import crypto from "node:crypto";

/**
 * Intercept: requests (or answers) a rule holds in the dashboard, to edit and Forward or Drop, as
 * in Burp. Held in memory only, with their real headers and body (to edit them, you see them),
 * never written anywhere, and sent on unchanged after a minute so the app never hangs. At most
 * 50 wait at once; more go straight on.
 */

export interface HeldItem {
  id: string;
  dir: string;
  project: string;
  service?: string;
  phase: "request" | "response";
  method: string;
  url: string;
  status?: number;
  headers: Record<string, string>;
  body: string;
  /** The body wasn't text: it can't be edited, only forwarded or dropped. */
  binary?: boolean;
  rule: string;
  at: string;
  expiresAt: string;
}

export interface Decision {
  action: "forward" | "drop";
  method?: string;
  url?: string;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Sent on by itself after the wait. */
  timedOut?: boolean;
}

export const HOLD_MS = 60_000;
const HOLD_MAX = 50;
const held = new Map<string, { item: HeldItem; done: (d: Decision) => void; timer: NodeJS.Timeout }>();

/** Holds one request or answer until it's decided, or the wait is over (then it goes on unchanged). */
export function hold(item: Omit<HeldItem, "id" | "at" | "expiresAt">, waitMs = HOLD_MS): Promise<Decision> {
  if (held.size >= HOLD_MAX) return Promise.resolve({ action: "forward" });
  const id = crypto.randomBytes(6).toString("hex");
  const at = Date.now();
  const full: HeldItem = { ...item, id, at: new Date(at).toISOString(), expiresAt: new Date(at + waitMs).toISOString() };
  return new Promise((resolve) => {
    const finish = (d: Decision) => {
      const h = held.get(id);
      if (!h) return;
      clearTimeout(h.timer);
      held.delete(id);
      resolve(d);
    };
    const timer = setTimeout(() => finish({ action: "forward", timedOut: true }), waitMs);
    timer.unref?.();
    held.set(id, { item: full, done: finish, timer });
  });
}

export function listHeld(dir?: string): HeldItem[] {
  const norm = (p: string) => (process.platform === "linux" ? p : p.toLowerCase());
  return [...held.values()].map((h) => h.item).filter((i) => !dir || norm(i.dir) === norm(dir));
}

export function heldItem(id: string): HeldItem | undefined {
  return held.get(id)?.item;
}

/** Forward (maybe edited) or drop one held item. False when it's gone (decided, or sent on after the wait). */
export function decide(id: string, d: Decision): boolean {
  const h = held.get(id);
  if (!h) return false;
  h.done(d);
  return true;
}

/** Sends everything held on, unchanged (when its rule is turned off, or the dashboard stops). */
export function releaseAll(dir?: string): number {
  const items = listHeld(dir);
  for (const i of items) decide(i.id, { action: "forward" });
  return items.length;
}
