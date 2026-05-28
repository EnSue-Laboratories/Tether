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
