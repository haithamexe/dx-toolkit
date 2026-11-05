/**
 * How a page is loaded when it should feel like somewhere else: a cheap phone on a weak
 * connection (6x slower CPU, 3G, a phone's screen and touch), or another time zone. DevTools
 * commands, sent to each tab by the dx browser and by headless page checks.
 */

export interface Emulation {
  /** A cheap phone in a tunnel: phone screen and touch, CPU 6x slower, a 3G connection. */
  phone?: boolean;
  /** An IANA time zone, e.g. "Pacific/Auckland". */
  timeZone?: string;
}

export const PHONE = {
  name: "Cheap phone on 3G",
  width: 390,
  height: 844,
  scale: 3,
  cpu: 6,
  // Chrome's own "Fast 3G" preset.
  latencyMs: 562.5,
  downBytes: 188_743,
  upBytes: 86_400,
  userAgent: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
};

export type CdpCommand = [method: string, params: object];

/** The commands that put a tab into this state. With `undo`, the ones that take a tab out of it again (to `userAgent`). */
export function emulationCommands(e: Emulation, options: { undo?: boolean; userAgent?: string } = {}): CdpCommand[] {
  const out: CdpCommand[] = [];
  if (e.phone && !options.undo) {
    out.push(
      ["Emulation.setDeviceMetricsOverride", { width: PHONE.width, height: PHONE.height, deviceScaleFactor: PHONE.scale, mobile: true }],
      ["Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }],
      ["Emulation.setEmitTouchEventsForMouse", { enabled: true, configuration: "mobile" }],
      ["Emulation.setUserAgentOverride", { userAgent: PHONE.userAgent, platform: "Android" }],
      ["Emulation.setCPUThrottlingRate", { rate: PHONE.cpu }],
      ["Network.emulateNetworkConditions", { offline: false, latency: PHONE.latencyMs, downloadThroughput: PHONE.downBytes, uploadThroughput: PHONE.upBytes, connectionType: "cellular3g" }],
    );
  } else if (options.undo) {
    out.push(
      ["Emulation.clearDeviceMetricsOverride", {}],
      ["Emulation.setTouchEmulationEnabled", { enabled: false }],
      ["Emulation.setEmitTouchEventsForMouse", { enabled: false }],
      ["Emulation.setCPUThrottlingRate", { rate: 1 }],
      ["Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }],
    );
    if (options.userAgent) out.push(["Emulation.setUserAgentOverride", { userAgent: options.userAgent }]);
  }
  if (e.timeZone && !options.undo) out.push(["Emulation.setTimezoneOverride", { timezoneId: e.timeZone }]);
  else if (options.undo) out.push(["Emulation.setTimezoneOverride", { timezoneId: "" }]);
  return out;
}

/** Sends the commands to one tab; a command the browser doesn't know is skipped. */
export async function applyEmulation(send: (method: string, params: object) => Promise<unknown>, e: Emulation, options: { undo?: boolean; userAgent?: string } = {}): Promise<void> {
  for (const [method, params] of emulationCommands(e, options)) await send(method, params).catch(() => undefined);
}
