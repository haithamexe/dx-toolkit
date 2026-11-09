/**
 * Lets a route stop the dashboard it runs in after it has answered (the dev tools' restart: the next
 * call from an AI tool or `dx` starts the dashboard again from the current build). The dashboard
 * registers how when it starts.
 */
let handler: (() => void) | undefined;

/** Sets the handler; with `only`, clears it only if it is still that one (a dashboard closing must not clear a newer one's). */
export function setShutdownHandler(fn: (() => void) | undefined, only?: () => void): void {
  if (only && handler !== only) return;
  handler = fn;
}

/** Stops the dashboard in a moment, so the answer to the request that asked for it gets out first. */
export function requestShutdown(delayMs = 150): void {
  setTimeout(() => handler?.(), delayMs).unref?.();
}
