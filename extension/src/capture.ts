/* Tether extension — CDP -> Tether event mapping + redaction (SKELETON, Phase 0).
 * Converts chrome.debugger (CDP) events into the wire schema in ../../docs/DESIGN.md §2,
 * applying header/body redaction (§6) before anything leaves the extension. */

export type TetherEvent = ConsoleEvent | NetworkEvent | SessionEvent;

/* The extension emits *ingest* events (DESIGN.md §3.1): sessionId is extension-owned; `seq` is
 * stamped by the daemon on ingest and is NOT sent from here. */
interface Envelope { type: "console" | "network" | "session"; ts: number; tabId: number; sessionId: string; }
export interface ConsoleEvent extends Envelope { type: "console"; level: string; text: string; args?: unknown[]; stack?: string; url?: string; source: string; }
export interface NetworkEvent extends Envelope { type: "network"; requestId: string; phase: "request" | "response" | "failed"; method?: string; url: string; resourceType?: string; status?: number; statusText?: string; mimeType?: string; requestHeaders?: Record<string, string>; responseHeaders?: Record<string, string>; durationMs?: number; fromCache?: boolean; errorText?: string; }
export interface SessionEvent extends Envelope { type: "session"; event: "opened" | "navigated" | "closed"; url?: string; title?: string; }

/** Default-redacted headers (§6); replaced before leaving the extension. Extended via daemon control. */
export const DEFAULT_REDACT_HEADERS = ["authorization", "cookie", "set-cookie", "proxy-authorization"];

export function redactHeaders(h: Record<string, string>, denylist: string[]): Record<string, string> {
  const deny = new Set(denylist.map((k) => k.toLowerCase()));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k] = deny.has(k.toLowerCase()) ? "«redacted»" : v;
  return out;
}

// TODO: mapConsoleApiCalled(params) -> ConsoleEvent  (Runtime.consoleAPICalled)
// TODO: mapExceptionThrown(params)  -> ConsoleEvent  (Runtime.exceptionThrown, source:"exception")
// TODO: mapRequestWillBeSent(params)-> NetworkEvent  (phase "request", redact requestHeaders)
// TODO: mapResponseReceived(params) -> NetworkEvent  (phase "response", redact responseHeaders, mimeType/status)
// TODO: mapLoadingFailed(params)    -> NetworkEvent  (phase "failed", errorText)
// TODO: optional body capture (Network.getResponseBody) gated by control.capture.bodies + bodyMaxBytes.
