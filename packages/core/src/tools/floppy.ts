import fs from "node:fs";
import path from "node:path";
import { ensureDxHome } from "../config.js";
import { isLoopbackUrl, findBrowser } from "./browser.js";
import { detached } from "./detached.js";
import { openUrl } from "./launch.js";
import { encodePng, iconFile, icnsFile, ICNS_TYPES, parseColor } from "./png.js";
import { startupFolder, writeShortcut, type ShortcutLaunch } from "./shortcuts.js";

/**
 * Floppy: the save icon come alive, sitting on the taskbar. This file holds what doesn't need a
 * window: the pixel art and its frames, the mood it shows for what dx is doing, the Startup
 * shortcut, and opening the dashboard as an app window. The window itself is floppyWindow.ts.
 */

// ------------------------------------------------------------ pixel art

export const FLOPPY_COLOURWAYS = {
  navy: { body: "#000080", hi: "#3a3ac8", lo: "#00004e", z: "#8aa0ff" },
  charcoal: { body: "#383838", hi: "#6a6a6a", lo: "#1a1a1a", z: "#bdbdbd" },
  maroon: { body: "#800000", hi: "#c43a3a", lo: "#4e0000", z: "#ff9a9a" },
} as const;
export type FloppyColourway = keyof typeof FLOPPY_COLOURWAYS;

const FIXED: Record<string, string> = {
  K: "#0b0b0b", G: "#c3c3c3", g: "#e6e6e6", M: "#7f7f7f", D: "#1f1f1f", W: "#ffffff", L: "#cfcfcf", U: "#9fb3ff",
  A: "#00b000", R: "#e00000", r: "#8a0000", V: "#9b4dff", Y: "#ffd400", P: "#ff8fb0", O: "#ffffff", x: "rgba(0,0,0,0.28)",
};

/** A grid of palette keys, "." for nothing. */
export type PixelGrid = string[][];

interface BodySpec {
  x0: number; x1: number; y0: number; y1: number;
  /** Pixels where x - y reaches this are cut off: the corner every floppy has. */
  ch: number;
  shutter: [number, number, number, number];
  slot: [number, number, number, number];
  label: [number, number, number, number];
  rule?: [number, number][];
  holes?: [number, number][];
}

function body(size: number, spec: BodySpec): PixelGrid {
  const g: PixelGrid = Array.from({ length: size }, () => Array<string>(size).fill("."));
  const inB = (x: number, y: number) => x >= spec.x0 && x <= spec.x1 && y >= spec.y0 && y <= spec.y1 && x - y < spec.ch;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (!inB(x, y)) continue;
    const edge = !inB(x - 1, y) || !inB(x + 1, y) || !inB(x, y - 1) || !inB(x, y + 1);
    g[y][x] = edge ? "K" : !inB(x - 2, y) || !inB(x, y - 2) ? "H" : !inB(x + 2, y) || !inB(x, y + 2) ? "S" : "B";
  }
  const [sx0, sx1, sy0, sy1] = spec.shutter;
  for (let y = sy0; y <= sy1; y++) for (let x = sx0; x <= sx1; x++) g[y][x] = x === sx0 || x === sx1 || y === sy1 ? "M" : y === sy0 ? "g" : "G";
  const [lx0, lx1, ly0, ly1] = spec.slot;
  for (let y = ly0; y <= ly1; y++) for (let x = lx0; x <= lx1; x++) g[y][x] = "D";
  const [bx0, bx1, by0, by1] = spec.label;
  for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) g[y][x] = y === by0 ? "L" : "W";
  for (const [x, y] of spec.rule ?? []) g[y][x] = "U";
  for (const [x, y] of spec.holes ?? []) g[y][x] = "D";
  return g;
}

const BODY24 = body(24, {
  x0: 2, x1: 21, y0: 1, y1: 22, ch: 18,
  shutter: [7, 15, 2, 8], slot: [12, 13, 3, 6], label: [5, 18, 11, 21],
  rule: Array.from({ length: 10 }, (_, i) => [7 + i, 20] as [number, number]),
  holes: [[3, 19], [4, 19], [3, 20], [4, 20], [19, 19], [20, 19], [19, 20], [20, 20]],
});
const BODY16 = body(18, { x0: 1, x1: 16, y0: 1, y1: 16, ch: 14, shutter: [5, 11, 2, 6], slot: [9, 10, 3, 5], label: [3, 14, 9, 15] });

type Pts = [number, number][];
const block = (x0: number, x1: number, y0: number, y1: number): Pts => {
  const p: Pts = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) p.push([x, y]);
  return p;
};
const EYES: Record<string, Record<string, Pts>> = {
  open: { K: [...block(8, 9, 13, 15), ...block(14, 15, 13, 15)], W: [[9, 13], [15, 13]] },
  blink: { K: [[8, 15], [9, 15], [14, 15], [15, 15]] },
  left: { K: [...block(7, 8, 13, 15), ...block(13, 14, 13, 15)], W: [[8, 13], [14, 13]] },
  right: { K: [...block(9, 10, 13, 15), ...block(15, 16, 13, 15)], W: [[10, 13], [16, 13]] },
  down: { K: [...block(8, 9, 14, 16), ...block(14, 15, 14, 16)], W: [[9, 14], [15, 14]] },
  upright: { K: [...block(9, 10, 12, 14), ...block(15, 16, 12, 14)], W: [[10, 12], [16, 12]] },
  happy: { K: [[7, 15], [8, 14], [9, 14], [10, 15], [13, 15], [14, 14], [15, 14], [16, 15]] },
  x: { R: [[7, 13], [9, 13], [8, 14], [7, 15], [9, 15], [14, 13], [16, 13], [15, 14], [14, 15], [16, 15]] },
  closed: { K: [[7, 15], [8, 15], [9, 15], [14, 15], [15, 15], [16, 15]] },
  wide: { K: [...block(7, 9, 13, 15), ...block(14, 16, 13, 15)], W: [[9, 13], [16, 13]] },
};
const MOUTHS: Record<string, Record<string, Pts>> = {
  smile: { K: [[10, 17], [13, 17], [11, 18], [12, 18]] },
  grin: { K: [[10, 17], [11, 17], [12, 17], [13, 17]], P: [[11, 18], [12, 18]] },
  o: { K: [[11, 18], [12, 18]] },
  O: { K: [[11, 17], [12, 17], [11, 18], [12, 18]] },
  wavy: { K: [[10, 18], [11, 17], [12, 18], [13, 17]] },
  small: { K: [[11, 18], [12, 18]] },
};
type Effect = [number, number, string][];
function glyph(rows: string[], ox: number, oy: number, key?: string): Effect {
  const out: Effect = [];
  rows.forEach((r, y) => [...r].forEach((c, x) => {
    if (c !== ".") out.push([ox + x, oy + y, c === "X" ? (key ?? "K") : c]);
  }));
  return out;
}
const Z_SMALL = ["XXX", ".X.", "XXX"];
const Z_BIG = ["XXXX", "..X.", ".X..", "XXXX"];
// Effects are placed in the whole sprite (32 × 30), above and beside the body.
const EFFECTS: Record<string, Effect> = {
  tw1: [[27, 3, "Y"], [26, 4, "Y"], [27, 4, "Y"], [28, 4, "Y"], [27, 5, "Y"]],
  tw2: [[28, 1, "Y"], [27, 2, "Y"], [28, 2, "Y"], [29, 2, "Y"], [28, 3, "Y"], [3, 8, "Y"]],
  badge: glyph(["..rrr..", ".rRRRr.", "rRWRWRr", "rRRWRRr", "rRWRWRr", ".rRRRr.", "..rrr.."], 24, 0),
  sp1: [[27, 1, "V"], [27, 2, "V"], [25, 3, "V"], [26, 3, "V"], [27, 3, "W"], [28, 3, "V"], [29, 3, "V"], [27, 4, "V"], [27, 5, "V"]],
  sp2: [[27, 2, "V"], [26, 3, "V"], [27, 3, "W"], [28, 3, "V"], [27, 4, "V"]],
  sp3: [[26, 2, "V"], [28, 2, "V"], [27, 3, "W"], [26, 4, "V"], [28, 4, "V"]],
  z1: glyph(Z_SMALL, 25, 6, "Z"),
  z2: glyph(Z_SMALL, 26, 3, "Z"),
  z3: glyph(Z_BIG, 26, 1, "Z"),
  z4: [...glyph(Z_BIG, 27, 0, "Z"), ...glyph(Z_SMALL, 24, 3, "Z")],
  ln1: [[0, 12, "M"], [1, 12, "M"], [0, 15, "M"], [1, 15, "M"], [0, 18, "M"], [1, 18, "M"]],
  ln2: [[0, 13, "M"], [1, 13, "M"], [0, 16, "M"], [1, 16, "M"], [0, 19, "M"], [1, 19, "M"]],
};

export interface FloppyFrame {
  eyes: string;
  mouth: string;
  ms: number;
  dx?: number;
  dy?: number;
  cheeks?: boolean;
  /** What the shutter's slot shows (a disk turning). */
  slot?: string;
  /** Pixels of the progress bar on the label, 1 to 10. */
  progress?: number;
  effects?: string[];
}

export type FloppyMood = "idle" | "starting" | "good" | "error" | "ai" | "sleep" | "held";

export interface FloppyMoodSpec {
  key: FloppyMood;
  name: string;
  /** Plays once and goes back to what it was showing. */
  once?: boolean;
  frames: FloppyFrame[];
}

/** Each frame keeps the face and timing of the one before unless it says otherwise. */
function frames(list: Partial<FloppyFrame>[]): FloppyFrame[] {
  let prev: FloppyFrame = { eyes: "open", mouth: "smile", ms: 500 };
  return list.map((f) => (prev = { eyes: prev.eyes, mouth: prev.mouth, ms: prev.ms, cheeks: prev.cheeks, ...f }));
}

/** Every mood, frame by frame: the sprite sheet the window plays. */
export const FLOPPY_MOODS: FloppyMoodSpec[] = [
  { key: "idle", name: "Idle", frames: frames([{ eyes: "open", mouth: "smile", ms: 700 }, { dy: 1 }, {}, { eyes: "blink", ms: 110 }, { eyes: "open", dy: 1, ms: 700 }, { eyes: "left", ms: 600 }, { dy: 1 }, { eyes: "right" }]) },
  { key: "starting", name: "Starting", frames: frames(Array.from({ length: 10 }, (_, i) => ({ eyes: "down", mouth: "o", ms: 150, slot: i % 2 ? "M" : "D", progress: i + 1, dy: (i >> 1) % 2 }))) },
  { key: "good", name: "All good", once: true, frames: frames([{ eyes: "happy", mouth: "grin", cheeks: true, ms: 80 }, { dy: -1 }, { dy: -2, effects: ["tw1"] }, { dy: -3, effects: ["tw2"] }, { dy: -2, effects: ["tw1"] }, { dy: -1 }, { ms: 500, effects: ["tw2"] }, { ms: 500 }]) },
  { key: "error", name: "Error", frames: frames([{ eyes: "x", mouth: "wavy", dx: -1, ms: 70, effects: ["badge"] }, { dx: 1, effects: ["badge"] }, { dx: -1, effects: ["badge"] }, { dx: 1, effects: ["badge"] }, { ms: 700, effects: ["badge"] }, { ms: 400 }]) },
  { key: "ai", name: "AI at work", frames: frames([{ eyes: "upright", mouth: "o", ms: 240, effects: ["sp1"] }, { effects: ["sp2"], dy: 1 }, { effects: ["sp3"], dy: 1 }, { effects: ["sp2"] }]) },
  { key: "sleep", name: "Asleep", frames: frames([{ eyes: "closed", mouth: "small", ms: 520, effects: ["z1"] }, { dy: 1, effects: ["z2"] }, { dy: 1, effects: ["z3"] }, { effects: ["z4"] }]) },
  { key: "held", name: "Picked up", frames: frames([{ eyes: "wide", mouth: "O", dy: -3, ms: 150, effects: ["ln1"] }, { dy: -3, effects: ["ln2"] }]) },
];

/** The whole sprite: 32 × 30, the 24-pixel body at (2, 5), room for effects around it. */
export const FLOPPY_SPRITE = { width: 32, height: 30, baseline: 28 } as const;

/** One frame as a grid. `halo` adds a one-pixel white edge, so it shows on a dark taskbar. */
export function composeFloppy(f: FloppyFrame, halo = false): PixelGrid {
  const { width: W, height: H } = FLOPPY_SPRITE;
  const g: PixelGrid = Array.from({ length: H }, () => Array<string>(W).fill("."));
  const ox = 2 + (f.dx ?? 0), oy = 5 + (f.dy ?? 0);
  const put = (x: number, y: number, k: string) => {
    if (x >= 0 && y >= 0 && x < W && y < H) g[y][x] = k;
  };
  BODY24.forEach((row, y) => row.forEach((k, x) => k !== "." && put(ox + x, oy + y, k)));
  if (f.slot) for (let y = 3; y <= 6; y++) for (let x = 12; x <= 13; x++) put(ox + x, oy + y, f.slot);
  if (f.progress) for (let x = 7; x < 7 + Math.min(10, f.progress); x++) put(ox + x, oy + 20, "A");
  for (const part of [EYES[f.eyes], MOUTHS[f.mouth]]) if (part) for (const k of Object.keys(part)) for (const [x, y] of part[k]) put(ox + x, oy + y, k);
  if (f.cheeks) {
    put(ox + 6, oy + 16, "P");
    put(ox + 17, oy + 16, "P");
  }
  for (const name of f.effects ?? []) for (const [x, y, k] of EFFECTS[name] ?? []) put(x, y, k);
  if (halo) addHalo(g);
  // A shadow under it, narrower the higher it jumps.
  const lift = Math.max(0, -(f.dy ?? 0));
  for (let x = 5 + lift * 2 + (f.dx ?? 0); x <= 22 - lift * 2 + (f.dx ?? 0); x++) if (g[FLOPPY_SPRITE.baseline][x] === ".") g[FLOPPY_SPRITE.baseline][x] = "x";
  return g;
}

function addHalo(g: PixelGrid): void {
  const H = g.length, W = g[0].length;
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && g[y][x] !== "." && g[y][x] !== "O";
  const add: [number, number][] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (g[y][x] === "." && (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1))) add.push([x, y]);
  for (const [x, y] of add) g[y][x] = "O";
}

/** The 16-pixel version (18 × 18 with its edge), drawn on its own for the tray and shortcut. */
export function floppyIcon16(kind: "idle" | "error" = "idle", halo = true): PixelGrid {
  const g = BODY16.map((r) => r.slice());
  const eyes: Pts = kind === "error" ? [[5, 10], [7, 10], [6, 11], [5, 12], [7, 12], [10, 10], [12, 10], [11, 11], [10, 12], [12, 12]] : [[6, 11], [6, 12], [11, 11], [11, 12]];
  for (const [x, y] of eyes) g[y][x] = kind === "error" ? "R" : "K";
  g[14][8] = "K";
  g[14][9] = "K";
  if (halo) addHalo(g);
  return g;
}

/** A grid as RGBA bytes, `scale` device pixels to a sprite pixel. */
export function gridToRgba(g: PixelGrid, colourway: FloppyColourway = "navy", scale = 1): { width: number; height: number; data: Uint8Array } {
  const cw = FLOPPY_COLOURWAYS[colourway];
  const colour = (k: string) => (k === "B" ? cw.body : k === "H" ? cw.hi : k === "S" ? cw.lo : k === "Z" ? cw.z : FIXED[k]);
  const cache = new Map<string, [number, number, number, number]>();
  const width = g[0].length * scale, height = g.length * scale;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const k = g[Math.floor(y / scale)][Math.floor(x / scale)];
    if (k === ".") continue;
    let rgba = cache.get(k);
    if (!rgba) cache.set(k, (rgba = parseColor(colour(k))));
    data.set(rgba, (y * width + x) * 4);
  }
  return { width, height, data };
}

export interface FloppyManifest {
  version: number;
  colourway: FloppyColourway;
  width: number;
  height: number;
  /** The sprite row the body stands on: everything below it may overlap the taskbar. */
  baseline: number;
  moods: { key: FloppyMood; once: boolean; frames: { file: string; ms: number }[] }[];
  icon: string;
}

/** 16, 32, 48, 64, 128 and 256 pixels: the sizes an icon file usually carries. */
const FLOPPY_ICON_SCALES = [1, 2, 3, 4, 8, 16];

// Bump when the art changes, so frames written by an older dx are drawn again.
const SPRITE_VERSION = 3;

/** Writes every frame as a PNG (with the white edge), the icon, and manifest.json; skips it when already there. */
export function writeFloppySprites(dir: string, colourway: FloppyColourway = "navy"): FloppyManifest {
  const manifestFile = path.join(dir, "manifest.json");
  try {
    const existing = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as FloppyManifest;
    if (existing.version === SPRITE_VERSION && existing.colourway === colourway && existing.moods.every((m) => m.frames.every((f) => fs.existsSync(path.join(dir, f.file))))) return existing;
  } catch {
    // not written yet
  }
  fs.mkdirSync(dir, { recursive: true });
  const manifest: FloppyManifest = { version: SPRITE_VERSION, colourway, ...FLOPPY_SPRITE, moods: [], icon: "floppy.ico" };
  for (const m of FLOPPY_MOODS) {
    const list = m.frames.map((f, i) => {
      const file = `${m.key}-${i}.png`;
      const { width, height, data } = gridToRgba(composeFloppy(f, true), colourway);
      fs.writeFileSync(path.join(dir, file), encodePng(width, height, data));
      return { file, ms: f.ms };
    });
    manifest.moods.push({ key: m.key, once: !!m.once, frames: list });
  }
  // The 16-pixel art at whole multiples, one image per size Windows asks for (title bar, taskbar,
  // Start menu, Alt+Tab), so it stays sharp everywhere; and a large PNG for other systems' windows.
  // Without its white edge the art is 16 × 16 inside the 18 × 18 grid: crop the empty margin.
  const art = floppyIcon16("idle", false).slice(1, 17).map((row) => row.slice(1, 17));
  const sizes = FLOPPY_ICON_SCALES.map((scale) => {
    const icon = gridToRgba(art, colourway, scale);
    return { png: encodePng(icon.width, icon.height, icon.data), width: icon.width, height: icon.height };
  });
  fs.writeFileSync(path.join(dir, manifest.icon), iconFile(sizes));
  fs.writeFileSync(path.join(dir, "floppy-256.png"), sizes[sizes.length - 1].png);
  // The macOS app's icon: the same art from 16 up to 1024 pixels, all whole multiples.
  const pngAt = new Map<number, Buffer>();
  const icns = ICNS_TYPES.map(([type, px]) => {
    if (!pngAt.has(px)) {
      const icon = gridToRgba(art, colourway, px / 16);
      pngAt.set(px, encodePng(icon.width, icon.height, icon.data));
    }
    return { type, png: pngAt.get(px)! };
  });
  fs.writeFileSync(path.join(dir, "floppy.icns"), icnsFile(icns));
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

// ------------------------------------------------------------ what it shows

export interface FloppyServer {
  project: string;
  dir: string;
  status: "starting" | "ready" | "stopped" | "failed";
  startedBy: string;
  errorCount: number;
  url?: string;
  /** The preparing step running now, while it starts. */
  step?: string;
}

/** What the dashboard says, through GET /api/floppy. `dashboard: false` when nothing answers. */
export interface FloppySnapshot {
  dashboard: boolean;
  servers: FloppyServer[];
  error?: { project: string; dir: string; id: string; message: string; file?: string; line?: number };
  ai?: { active: boolean; text?: string };
}

export interface FloppyTip {
  title: string;
  text: string;
  icon: "info" | "error" | "ok" | "ai";
}

export interface FloppyView {
  mood: FloppyMood;
  /** Play this once first (a server just came up), then show `mood`. */
  play?: FloppyMood;
  tip: FloppyTip;
  /** Say it without being hovered: something just changed. */
  announce?: boolean;
  /** Keep saying it until it's clicked: an error. */
  sticky?: boolean;
}

export interface FloppyMemory {
  /** Errors already looked at (opened dx while they showed). */
  seen: string[];
  /** Servers seen starting, so their becoming ready is a moment. */
  starting: string[];
  lastChange: number;
  signature?: string;
  quietUntil?: number;
  /** The mood shown last, so a change is announced once. */
  lastMood?: FloppyMood;
  lastError?: string;
}

export const FLOPPY_SLEEP_MS = 30 * 60_000;

export function newFloppyMemory(now = Date.now()): FloppyMemory {
  return { seen: [], starting: [], lastChange: now };
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** The key an error is remembered by once you've seen it. */
export function floppyErrorKey(snapshot: FloppySnapshot): string | undefined {
  if (snapshot.error) return `${snapshot.error.dir}|${snapshot.error.id}`;
  const failed = snapshot.servers.find((s) => s.status === "failed");
  return failed ? `${failed.dir}|failed` : undefined;
}

/**
 * The mood for what dx is doing, most urgent first: an error you haven't looked at, a server
 * starting, one that just came up (played once), an AI agent at work, quiet (asleep), then idle.
 * Errors wake it from quiet. Thirty minutes with nothing changing puts it to sleep.
 */
export function floppyView(snapshot: FloppySnapshot, memory: FloppyMemory, now = Date.now()): { view: FloppyView; memory: FloppyMemory } {
  const mem: FloppyMemory = { ...memory, seen: [...memory.seen], starting: [...memory.starting] };
  const live = snapshot.servers.filter((s) => s.status !== "stopped");
  const sig = JSON.stringify([snapshot.dashboard, live.map((s) => [s.dir, s.status, s.errorCount]), snapshot.ai?.active ?? false]);
  if (sig !== mem.signature) {
    mem.signature = sig;
    mem.lastChange = now;
  }
  if (mem.quietUntil && mem.quietUntil <= now) delete mem.quietUntil;

  const starting = live.filter((s) => s.status === "starting");
  const justReady = live.filter((s) => s.status === "ready" && mem.starting.includes(s.dir));
  mem.starting = starting.map((s) => s.dir);
  const changed = (mood: FloppyMood) => mem.lastMood !== mood;
  const done = (view: FloppyView) => {
    mem.lastMood = view.mood;
    return { view, memory: mem };
  };

  const errKey = floppyErrorKey(snapshot);
  if (errKey && !mem.seen.includes(errKey)) {
    const fresh = mem.lastError !== errKey;
    mem.lastError = errKey;
    const e = snapshot.error;
    const failed = snapshot.servers.find((s) => s.status === "failed");
    const tip: FloppyTip = e
      ? { title: `${e.project} has an error`, text: `${firstLine(e.message)}${e.file ? ` · ${path.basename(e.file)}${e.line ? `:${e.line}` : ""}` : ""}. Click me to see it.`, icon: "error" }
      : { title: `${failed?.project} stopped`, text: "It didn't start. Click me to see why.", icon: "error" };
    return done({ mood: "error", tip, announce: fresh, sticky: true });
  }
  if (!errKey) delete mem.lastError;

  if (starting.length) {
    const s = starting[0];
    return done({ mood: "starting", tip: { title: `Starting ${s.project}`, text: s.step ? `${s.step}…` : "Getting it ready…", icon: "info" }, announce: changed("starting") });
  }

  const ai = !!snapshot.ai?.active;
  const base: FloppyMood = ai ? "ai" : mem.quietUntil ? "sleep" : now - mem.lastChange > FLOPPY_SLEEP_MS ? "sleep" : "idle";
  if (justReady.length) {
    const s = justReady[0];
    return done({ mood: base, play: "good", tip: { title: `${s.project} is up`, text: s.url ? `It's at ${s.url.replace(/^https?:\/\//, "")}.` : "It's running.", icon: "ok" }, announce: true });
  }
  if (base === "ai") return done({ mood: "ai", tip: { title: "An AI agent is using dx", text: snapshot.ai?.text ? firstLine(snapshot.ai.text) : "Starting and checking your apps.", icon: "ai" }, announce: changed("ai") });
  if (base === "sleep") {
    const text = mem.quietUntil ? `Quiet until ${hhmm(mem.quietUntil)}. Errors still wake me.` : "Nothing for 30 minutes. Click me to open dx.";
    return done({ mood: "sleep", tip: { title: "Zzz", text, icon: "info" } });
  }
  if (!snapshot.dashboard) return done({ mood: "idle", tip: { title: "Floppy", text: "dx isn't running. Click me to start it.", icon: "info" } });
  const running = live.filter((s) => s.status === "ready");
  const text = running.length ? `${plural(running.length, "server")} running: ${running.slice(0, 3).map((s) => s.project).join(", ")}${running.length > 3 ? "…" : ""}.` : "Nothing running. Click me to open dx.";
  return done({ mood: "idle", tip: { title: "Floppy", text, icon: "info" } });
}

function firstLine(s: string): string {
  const line = s.split(/\r?\n/)[0].trim();
  return line.length > 140 ? line.slice(0, 139) + "…" : line;
}

// ------------------------------------------------------------ Startup and the app window

export function floppyShortcutPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = startupFolder(env);
  return dir ? path.join(dir, "dx Floppy.lnk") : undefined;
}

export function floppyStartsWithWindows(env: NodeJS.ProcessEnv = process.env): boolean {
  const file = floppyShortcutPath(env);
  return !!file && fs.existsSync(file);
}

export type FloppyLaunch = ShortcutLaunch;

/**
 * Adds or removes the Startup shortcut. It runs dx's own Floppy entry with node, minimised, and
 * that hands Floppy to a hidden process and exits, so nothing stays on screen. Only Windows.
 */
export function setFloppyStartup(on: boolean, launch?: FloppyLaunch, env: NodeJS.ProcessEnv = process.env): { ok: boolean; message: string; path?: string } {
  if (process.platform !== "win32") return { ok: false, message: "Starting with the computer is Windows-only for now." };
  const file = floppyShortcutPath(env);
  if (!file) return { ok: false, message: "Couldn't find your Startup folder (APPDATA isn't set)." };
  if (!on) {
    fs.rmSync(file, { force: true });
    return { ok: true, message: "Floppy won't start with Windows.", path: file };
  }
  if (!launch) return { ok: false, message: "Nothing to start." };
  const r = writeShortcut(file, launch, "dx Floppy", { minimised: true });
  if (!r.ok) return { ok: false, message: r.message.replace("the shortcut", "the Startup shortcut") };
  return { ok: true, message: "Floppy starts when you sign in to Windows.", path: file };
}

/** The browser that opens app windows: Edge on Windows (it's always there), else the first Chromium found. */
export function appWindowBrowser(): { name: string; path: string } | undefined {
  if (process.platform === "win32" && !process.env.DX_BROWSER) {
    for (const root of [process.env["PROGRAMFILES(X86)"], process.env.PROGRAMFILES, process.env.LOCALAPPDATA]) {
      if (!root) continue;
      const file = path.join(root, "Microsoft", "Edge", "Application", "msedge.exe");
      if (fs.existsSync(file)) return { name: "Edge", path: file };
    }
  }
  return findBrowser();
}

/**
 * Opens an address on this computer (the dashboard) as an app: its own window and taskbar icon,
 * no tabs or address bar. Falls back to the default browser when no Chromium browser is there.
 */
export async function openAppWindow(url: string): Promise<"app" | "browser"> {
  if (!isLoopbackUrl(url)) throw new Error("Only addresses on this computer open as an app window.");
  const browser = appWindowBrowser();
  if (!browser) {
    await openUrl(url);
    return "browser";
  }
  await detached(browser.path, [`--app=${url}`], { windowsHide: false });
  return "app";
}

export function ensureFloppyHome(dir: string): void {
  ensureDxHome();
  fs.mkdirSync(dir, { recursive: true });
}
