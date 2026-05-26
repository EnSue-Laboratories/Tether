/* Runtime messages between the popup and the background service worker. */

export interface TabState {
  daemonConnected: boolean;
  capturing: boolean;
  tabId: number;
  url?: string;
  sessionId?: string;
  consoleCount: number;
  networkCount: number;
}

export type PopupRequest =
  | { type: "getState"; tabId: number }
  | { type: "toggleCapture"; tabId: number };
