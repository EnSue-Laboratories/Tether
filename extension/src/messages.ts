/* Runtime messages between the popup and the background service worker.
 *
 * TabState also carries a *capped* recent-event tail for the popup (network +
 * console). The full event stream still goes to the daemon — this tail is just
 * what the popup renders. Bound is `POPUP_TAIL` in background.ts. */

export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";

export interface PopupNetworkRow {
  /** CDP requestId — stable across request/response/finished phases. */
  id: string;
  /** First-seen ts (request phase). */
  ts: number;
  method?: string;
  url: string;
  /** HTTP status once the response phase lands. Undefined while pending. */
  status?: number;
  durationMs?: number;
  resourceType?: string;
  /** Set if the request failed; treated as an "ERR" row by the filter. */
  errorText?: string;
}

export interface PopupConsoleRow {
  id: string;
  ts: number;
  level: ConsoleLevel;
  text: string;
  url?: string;
}

export interface TabState {
  daemonConnected: boolean;
  capturing: boolean;
  tabId: number;
  url?: string;
  sessionId?: string;
  consoleCount: number;
  networkCount: number;
  /** Newest-last tail of network rows for the popup (rolled up by requestId). */
  network: PopupNetworkRow[];
  /** Newest-last tail of console rows for the popup. */
  console: PopupConsoleRow[];
}

export type PopupRequest =
  | { type: "getState"; tabId: number }
  | { type: "toggleCapture"; tabId: number };

/* Background → content-script message: render a top-center error toast.
 * Fired for 5xx responses and non-asset network failures on captured tabs. */
export interface ToastMessage {
  type: "toast";
  /** CDP requestId — used by the content script to dedup retries. */
  requestId: string;
  /** HTTP status if the response phase landed; absent for failed phase. */
  status?: number;
  method?: string;
  url: string;
  /** CDP errorText for failed phase, e.g. "net::ERR_CONNECTION_REFUSED". */
  errorText?: string;
}

/* Background → content-script follow-up: attach a body excerpt to an
 * existing toast once Network.getResponseBody returns. May arrive after the
 * toast was auto-dismissed; in that case the content script no-ops. */
export interface ToastDetailMessage {
  type: "toast-detail";
  requestId: string;
  /** Decoded body string (utf-8). base64 binary bodies are filtered out
   *  by the background side and never sent here. */
  body: string;
  bodyTruncated?: boolean;
  /** Hint for rendering: "json" if the body parsed as JSON, else "text". */
  kind: "json" | "text";
}
