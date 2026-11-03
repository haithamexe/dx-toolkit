import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { dxPath, loadConfig, saveConfig } from "../config.js";
import { recordRun } from "../runs.js";
import { commandExists } from "./doctor.js";
import { scanProjects } from "./projects.js";
import { serviceName } from "./stacks.js";

const run = promisify(execFile);

/**
 * https:// for the local domains (https://shop.localhost), with a certificate your browsers trust.
 * mkcert makes a local certificate authority and adds it to the system's trust store once (that
 * step asks for permission), then signs a certificate for the *.localhost names dx serves. It's
 * opt-in: `dx https` turns it on, `dx https --off` turns it off.
 */

export interface CertFiles {
  cert: string;
  key: string;
}

export function certFiles(): CertFiles {
  return { cert: dxPath("certs", "localhost.pem"), key: dxPath("certs", "localhost-key.pem") };
}

const NAMES_FILE = () => dxPath("certs", "names.json");
const BASE_NAMES = ["localhost", "127.0.0.1", "::1", "dx.localhost"];

/** How to install mkcert here, for dx doctor and dx https. */
export function mkcertInstallFix(): string {
  if (process.platform === "win32") return "winget install FiloSottile.mkcert";
  if (process.platform === "darwin") return "brew install mkcert nss";
  return "sudo apt install -y mkcert libnss3-tools   (Fedora: sudo dnf install -y mkcert nss-tools; Arch: sudo pacman -S mkcert nss)";
}

export function httpsEnabled(): boolean {
  try {
    return loadConfig().https === true;
  } catch {
    return false;
  }
}

/** The names a certificate needs: each project and each of its services (*.shop.localhost). */
export function projectHostNames(): string[] {
  const names = new Set<string>();
  for (const p of scanProjects(loadConfig())) {
    const base = serviceName(p.name);
    if (!base) continue;
    names.add(`${base}.localhost`);
    names.add(`*.${base}.localhost`);
  }
  return [...names].sort();
}

function readNames(): string[] {
  try {
    return JSON.parse(fs.readFileSync(NAMES_FILE(), "utf8")) as string[];
  } catch {
    return [];
  }
}

/** True when the certificate covers this host name, directly or through a *.parent wildcard. */
export function certCovers(host: string, names = readNames()): boolean {
  const h = host.toLowerCase();
  if (names.includes(h)) return true;
  const dot = h.indexOf(".");
  return dot > 0 && names.includes(`*${h.slice(dot)}`);
}

/**
 * Makes sure a certificate exists that covers these names, adding them to the ones it already
 * covers. Returns undefined when mkcert isn't installed.
 */
export async function ensureCert(extra: string[] = []): Promise<(CertFiles & { names: string[]; created: boolean }) | undefined> {
  const files = certFiles();
  const have = readNames();
  const want = [...new Set([...BASE_NAMES, ...have, ...extra.map((n) => n.toLowerCase())])].sort();
  const fresh = fs.existsSync(files.cert) && fs.existsSync(files.key) && want.every((n) => have.includes(n));
  if (fresh) return { ...files, names: have, created: false };
  const mkcert = await commandExists("mkcert");
  if (!mkcert) return undefined;
  fs.mkdirSync(dxPath("certs"), { recursive: true });
  await run(mkcert, ["-cert-file", files.cert, "-key-file", files.key, ...want], { windowsHide: true, timeout: 60_000 });
  fs.writeFileSync(NAMES_FILE(), JSON.stringify(want, null, 2) + "\n");
  return { ...files, names: want, created: true };
}

export interface HttpsSetup {
  ok: boolean;
  steps: { name: string; ok: boolean; detail?: string }[];
  fix?: string;
}

/** Turns https on: installs mkcert's authority (asks once), makes the certificate, saves the setting. */
export async function setupHttps(): Promise<HttpsSetup> {
  const steps: HttpsSetup["steps"] = [];
  const mkcert = await commandExists("mkcert");
  if (!mkcert) {
    return { ok: false, steps: [{ name: "mkcert", ok: false, detail: "not installed" }], fix: `${mkcertInstallFix()}, then dx https` };
  }
  steps.push({ name: "mkcert", ok: true, detail: mkcert });
  try {
    // Adds the local authority to the system (and Firefox/Chrome) trust stores. This may show a prompt.
    await run(mkcert, ["-install"], { windowsHide: false, timeout: 300_000 });
    steps.push({ name: "Trust the local certificate authority", ok: true });
  } catch (err) {
    steps.push({ name: "Trust the local certificate authority", ok: false, detail: firstLine(err) });
    return { ok: false, steps, fix: "Run mkcert -install yourself and accept the prompt, then dx https" };
  }
  try {
    const cert = await ensureCert(projectHostNames());
    steps.push({ name: "Certificate", ok: !!cert, detail: cert ? `${cert.names.length} names, in ${cert.cert}` : "mkcert didn't make one" });
  } catch (err) {
    steps.push({ name: "Certificate", ok: false, detail: firstLine(err) });
    return { ok: false, steps };
  }
  const config = loadConfig();
  config.https = true;
  saveConfig(config);
  steps.push({ name: "Turned on", ok: true, detail: "the dashboard serves https:// from its next start" });
  recordRun("https", true, "local HTTPS turned on");
  return { ok: true, steps };
}

export function disableHttps(): void {
  const config = loadConfig();
  delete config.https;
  saveConfig(config);
  recordRun("https", true, "local HTTPS turned off");
}

function firstLine(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr || e.message || String(err)).split(/\r?\n/).find((l) => l.trim())?.trim() ?? "failed";
}
