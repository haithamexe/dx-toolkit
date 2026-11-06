import fs from "node:fs";
import path from "node:path";

/**
 * Windows shortcuts (.lnk) in the user's own Start menu folders: the Startup shortcuts for Floppy
 * and the dx app. dx writes the file itself, in the Shell Link format Microsoft documents
 * ([MS-SHLLINK]): no PowerShell or COM to start, which on a busy computer could take a minute or
 * hang (CI's Windows runners), and nothing in a path is ever run as a command.
 */

/** What a shortcut starts: a program, its arguments, and the icon it shows. */
export interface ShortcutLaunch {
  command: string;
  args: string[];
  icon?: string;
}

/** The user's own Start menu Programs folder. */
export function startMenuFolder(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const appData = env.APPDATA || (env.USERPROFILE ? path.join(env.USERPROFILE, "AppData", "Roaming") : undefined);
  return appData ? path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs") : undefined;
}

/** Where Windows looks for programs to start when you sign in. */
export function startupFolder(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const programs = startMenuFolder(env);
  return programs ? path.join(programs, "Startup") : undefined;
}

/** The arguments as one command line, the way Windows splits them again (quotes and backslashes per CommandLineToArgvW). */
export function shortcutArgs(args: string[]): string {
  return args
    .map((a) => {
      if (a !== "" && !/[\s"]/.test(a)) return a;
      // Backslashes before a quote are doubled, and the quote escaped; trailing ones doubled before the closing quote.
      return `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
    })
    .join(" ");
}

// [MS-SHLLINK] 2.1.1 LinkFlags, and 2.1 the header's class id.
const HAS_NAME = 0x4;
const HAS_WORKING_DIR = 0x10;
const HAS_ARGUMENTS = 0x20;
const HAS_ICON_LOCATION = 0x40;
const IS_UNICODE = 0x80;
const HAS_EXP_STRING = 0x200;
const LINK_CLSID = Buffer.from("0114020000000000c000000000000046", "hex");
const SW_SHOWNORMAL = 1;
const SW_SHOWMINNOACTIVE = 7;

/** A StringData field: its length in characters, then the UTF-16 text, no terminator. */
function stringData(s: string): Buffer {
  const text = Buffer.from(s, "utf16le");
  const count = Buffer.alloc(2);
  count.writeUInt16LE(s.length);
  return Buffer.concat([count, text]);
}

/**
 * A shortcut file's bytes: the header; the description, working folder, arguments and icon as
 * StringData; and the program's path in an EnvironmentVariableDataBlock (ANSI and Unicode), which
 * Windows resolves the target from, as it does for shortcuts to `%ProgramFiles%\…`. No item ID
 * list or LinkInfo: those describe a file the way Explorer saw it, and the path is all it needs.
 */
export function shortcutBytes(launch: ShortcutLaunch, description: string, options: { minimised?: boolean; workingDir?: string } = {}): Buffer {
  const target = path.win32.resolve(launch.command);
  if (target.length >= 260) throw new Error("The program's path is too long for a shortcut (260 characters).");
  const workingDir = options.workingDir ?? path.win32.dirname(target);
  const args = shortcutArgs(launch.args);
  const flags = HAS_EXP_STRING | HAS_NAME | HAS_WORKING_DIR | IS_UNICODE | (args ? HAS_ARGUMENTS : 0) | (launch.icon ? HAS_ICON_LOCATION : 0);

  const header = Buffer.alloc(0x4c);
  header.writeUInt32LE(0x4c, 0);
  LINK_CLSID.copy(header, 4);
  header.writeUInt32LE(flags, 20);
  header.writeUInt32LE(0x20, 24); // FILE_ATTRIBUTE_ARCHIVE: a plain file
  // creation, access and write times (28-51) and file size (52) stay zero: Windows reads the file itself.
  header.writeInt32LE(0, 56); // icon index
  header.writeUInt32LE(options.minimised ? SW_SHOWMINNOACTIVE : SW_SHOWNORMAL, 60);

  const strings = [stringData(description), stringData(workingDir), ...(args ? [stringData(args)] : []), ...(launch.icon ? [stringData(launch.icon)] : [])];

  // [MS-SHLLINK] 2.5.4 EnvironmentVariableDataBlock: size, signature, 260 ANSI bytes, 260 UTF-16 characters.
  const env = Buffer.alloc(0x314);
  env.writeUInt32LE(0x314, 0);
  env.writeUInt32LE(0xa0000001, 4);
  env.write(target.replace(/[^\x20-\x7e]/g, "?"), 8, 259, "latin1");
  env.write(target, 8 + 260, 518, "utf16le");
  return Buffer.concat([header, ...strings, env, Buffer.alloc(4)]);
}

/**
 * A shortcut already saying all this: the same program, arguments, icon, description and window.
 * Windows adds its own item IDs to a shortcut the first time it opens one (checked: the file grows
 * and WScript then shows the target), so one that says the same is left as it is, not rewritten.
 */
export function shortcutMatches(bytes: Buffer, launch: ShortcutLaunch, description: string, options: { minimised?: boolean } = {}): boolean {
  if (bytes.length < 0x4c || bytes.readUInt32LE(0) !== 0x4c || !bytes.subarray(4, 20).equals(LINK_CLSID)) return false;
  if (bytes.readUInt32LE(60) !== (options.minimised ? SW_SHOWMINNOACTIVE : SW_SHOWNORMAL)) return false;
  const has = (s: string) => bytes.includes(Buffer.from(s, "utf16le"));
  const args = shortcutArgs(launch.args);
  return has(path.win32.resolve(launch.command)) && has(description) && (!args || has(args)) && (!launch.icon || has(launch.icon));
}

/** Writes a shortcut, minimised when `minimised`, starting in the user's home folder. Windows only. */
export function writeShortcut(file: string, launch: ShortcutLaunch, description: string, options: { minimised?: boolean } = {}): { ok: boolean; message: string } {
  if (process.platform !== "win32") return { ok: false, message: "Shortcuts are Windows-only for now." };
  try {
    if (fs.existsSync(file) && shortcutMatches(fs.readFileSync(file), launch, description, options)) return { ok: true, message: "Shortcut is up to date." };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, shortcutBytes(launch, description, { ...options, workingDir: process.env.USERPROFILE || path.dirname(launch.command) }));
  } catch (err) {
    return { ok: false, message: `Couldn't add the shortcut: ${(err as Error).message}` };
  }
  return { ok: true, message: "Shortcut written." };
}
