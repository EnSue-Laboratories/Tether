/* Tether extension — background service worker.
 *
 * Holds the Native Messaging port to `tetherd`, attaches chrome.debugger (CDP) per captured tab,
 * maps CDP events to the ingest schema (capture.ts), batches, and forwards to the daemon. Applies
 * daemon `control` config. See ../../docs/DESIGN.md §3.1.
 *
 * NOTE (MV3): in-memory state (contexts/counts) lives only as long as the service worker. An
 * attached debugger keeps the worker alive during active capture, so state persists while
 * capturing; on an idle-worker restart, capture is re-established when the user toggles again.
 * (Persisting sessions across worker restarts is a possible follow-up.) */

import {
  buildBodyEvent, CaptureConfig, CaptureContext, ControlMessage, DEFAULT_CONFIG, IngestEvent,
  IngestMessage, mapConsoleApiCalled, mapExceptionThrown, mapLoadingFailed, mapLoadingFinished,
  mapLogEntryAdded, mapRequestWillBeSent, mapResponseReceived,
  mapWsClosed, mapWsCreated, mapWsFrameError, mapWsFrameReceived, mapWsFrameSent,
  mapWsHandshakeRequest, mapWsHandshakeResponse
} from "./capture.js";
import { PopupConsoleRow, PopupNetworkRow, PopupRequest, TabState } from "./messages.js";

const NATIVE_HOST = "com.ensue.tether";
const CDP_VERSION = "1.3";
const FLUSH_MS = 500;
const MAX_QUEUE = 10000; // bound the outbound queue if the daemon is unreachable
const POPUP_TAIL = 100;  // popup-only recent-event window (per tab, per channel)

let port: chrome.runtime.Port | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let config: CaptureConfig = DEFAULT_CONFIG;
let queue: IngestEvent[] = [];

const contexts = new Map<number, CaptureContext>();                 // tabId -> capture context
const counts = new Map<number, { console: number; network: number }>();
const pageUrls = new Map<number, string>();                         // tabId -> last known url

/* Per-tab recent-event tail for the popup. Network rows are rolled up by
 * requestId so request → response → finished updates one row in place; the
 * Map's insertion order is the display order. Console rows are append-only. */
const netTail = new Map<number, Map<string, PopupNetworkRow>>();
const conTail = new Map<number, PopupConsoleRow[]>();
let consoleRowSeq = 0;

/* ---- daemon connection (Native Messaging) ---- */
function connectDaemon(): void {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch {
    scheduleReconnect();
    return;
  }
  port.onMessage.addListener((msg: ControlMessage) => {
    if (msg && msg.kind === "control") {
      config = { capture: msg.capture, limits: msg.limits, redact: msg.redact, filter: msg.filter };
      for (const ctx of contexts.values()) ctx.config = config;
    }
  });
  port.onDisconnect.addListener(() => { port = null; scheduleReconnect(); });
}
function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; if (contexts.size > 0) connectDaemon(); }, 2000);
}

/* ---- outbound event queue ---- */
function emit(ev: IngestEvent | null): void {
  if (!ev) return;
  queue.push(ev);
  if (ev.type === "console") {
    bump(ev.tabId, "console");
    pushConsoleTail(ev.tabId, ev);
  } else if (ev.type === "network") {
    if (ev.phase === "request") bump(ev.tabId, "network");
    updateNetworkTail(ev.tabId, ev);
  }
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}

function pushConsoleTail(tabId: number, ev: import("./capture.js").ConsoleEvent): void {
  const rows = conTail.get(tabId) ?? [];
  rows.push({
    id: `c_${++consoleRowSeq}`,
    ts: ev.ts,
    level: ev.level,
    text: ev.text,
    url: ev.url
  });
  // Trim from the front — we keep newest at the end.
  if (rows.length > POPUP_TAIL) rows.splice(0, rows.length - POPUP_TAIL);
  conTail.set(tabId, rows);
}

function updateNetworkTail(tabId: number, ev: import("./capture.js").NetworkEvent): void {
  const map = netTail.get(tabId) ?? new Map<string, PopupNetworkRow>();
  // Map preserves insertion order — for an in-place update we keep the
  // existing position. We don't bother surfacing body / handshake / ws-frame-*
  // as standalone rows; they fold into the originating requestId.
  const existing = map.get(ev.requestId);
  if (existing) {
    if (ev.method) existing.method = ev.method;
    if (ev.url) existing.url = ev.url;
    if (ev.status !== undefined) existing.status = ev.status;
    if (ev.durationMs !== undefined) existing.durationMs = ev.durationMs;
    if (ev.resourceType) existing.resourceType = ev.resourceType;
    if (ev.phase === "failed" && ev.errorText) existing.errorText = ev.errorText;
  } else {
    map.set(ev.requestId, {
      id: ev.requestId,
      ts: ev.ts,
      method: ev.method,
      url: ev.url || "",
      status: ev.status,
      durationMs: ev.durationMs,
      resourceType: ev.resourceType,
      errorText: ev.phase === "failed" ? ev.errorText : undefined
    });
    if (map.size > POPUP_TAIL) {
      // Drop the oldest row to bound memory. Map iterator yields in insertion order.
      const first = map.keys().next();
      if (!first.done) map.delete(first.value);
    }
  }
  netTail.set(tabId, map);
}
function bump(tabId: number, kind: "console" | "network"): void {
  const c = counts.get(tabId) ?? { console: 0, network: 0 };
  c[kind]++;
  counts.set(tabId, c);
}
function flush(): void {
  flushTimer = null;
  if (queue.length === 0) return;
  if (!port) connectDaemon();
  if (!port) { if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE); return; }
  const msg: IngestMessage = { v: 1, kind: "events", events: queue };
  try { port.postMessage(msg); queue = []; } catch { port = null; scheduleReconnect(); }
}

/* ---- capture lifecycle ---- */
function newSessionId(): string {
  return "s_" + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
}

function enableCapture(tabId: number): void {
  if (contexts.has(tabId)) return;
  chrome.debugger.attach({ tabId }, CDP_VERSION, () => {
    if (chrome.runtime.lastError) return; // attach failed (already attached / restricted page)
    const ctx: CaptureContext = { tabId, sessionId: newSessionId(), config, reqInfo: new Map() };
    contexts.set(tabId, ctx);
    counts.set(tabId, { console: 0, network: 0 });
    chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
    chrome.debugger.sendCommand({ tabId }, "Network.enable", {
      maxResourceBufferSize: 10 * 1024 * 1024,
      maxTotalBufferSize: 100 * 1024 * 1024
    });
    chrome.debugger.sendCommand({ tabId }, "Log.enable");
    connectDaemon();
    chrome.tabs.get(tabId, (tab) => {
      void chrome.runtime.lastError;
      const url = tab?.url;
      if (url) pageUrls.set(tabId, url);
      emit({ type: "session", ts: Date.now(), tabId, sessionId: ctx.sessionId, event: "opened", url, title: tab?.title });
    });
  });
}

function disableCapture(tabId: number, detach = true): void {
  const ctx = contexts.get(tabId);
  if (!ctx) return;
  emit({ type: "session", ts: Date.now(), tabId, sessionId: ctx.sessionId, event: "closed", url: pageUrls.get(tabId) });
  flush();
  contexts.delete(tabId);
  counts.delete(tabId);
  netTail.delete(tabId);
  conTail.delete(tabId);
  if (detach) chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; });
}

/* For Network.getResponseBody we need the request's URL (for the body event) after we delete reqInfo
 * in mapLoadingFinished; cache url-per-requestId in a small map that lives until loadingFinished. */
const bodyUrls = new Map<string, string>();

interface CdpResponseBody { body: string; base64Encoded: boolean; }
function fetchResponseBody(tabId: number, requestId: string): Promise<CdpResponseBody | null> {
  return new Promise((resolve) => {
    chrome.debugger.sendCommand({ tabId }, "Network.getResponseBody", { requestId }, (result) => {
      if (chrome.runtime.lastError || !result) { resolve(null); return; }
      resolve(result as CdpResponseBody);
    });
  });
}

/* ---- CDP event routing ---- */
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  const ctx = contexts.get(tabId);
  if (!ctx) return;
  const pageUrl = pageUrls.get(tabId);
  const p = params as never; // CDP params are method-specific; mappers assert their own shapes
  switch (method) {
    case "Runtime.consoleAPICalled": emit(mapConsoleApiCalled(p, ctx, pageUrl)); break;
    case "Runtime.exceptionThrown":  emit(mapExceptionThrown(p, ctx, pageUrl)); break;
    case "Log.entryAdded":           emit(mapLogEntryAdded(p, ctx, pageUrl)); break;
    case "Network.requestWillBeSent": {
      const req = p as { requestId: string; request: { url: string } };
      bodyUrls.set(req.requestId, req.request.url);
      emit(mapRequestWillBeSent(p, ctx));
      break;
    }
    case "Network.responseReceived": {
      const req = p as { requestId: string; response: { url: string } };
      bodyUrls.set(req.requestId, req.response.url);
      emit(mapResponseReceived(p, ctx));
      break;
    }
    case "Network.loadingFailed": {
      const req = p as { requestId: string };
      bodyUrls.delete(req.requestId);
      emit(mapLoadingFailed(p, ctx));
      break;
    }
    case "Network.loadingFinished": {
      const req = p as { requestId: string };
      const url = bodyUrls.get(req.requestId) ?? "";
      emit(mapLoadingFinished(p, ctx));
      if (ctx.config.capture.bodies) {
        void fetchResponseBody(tabId, req.requestId).then((b) => {
          if (b && b.body) emit(buildBodyEvent(ctx, req.requestId, url, b.body, b.base64Encoded));
          bodyUrls.delete(req.requestId);
        });
      } else {
        bodyUrls.delete(req.requestId);
      }
      break;
    }
    case "Network.webSocketCreated":                    emit(mapWsCreated(p, ctx)); break;
    case "Network.webSocketWillSendHandshakeRequest":   emit(mapWsHandshakeRequest(p, ctx)); break;
    case "Network.webSocketHandshakeResponseReceived":  emit(mapWsHandshakeResponse(p, ctx)); break;
    case "Network.webSocketFrameSent":                  emit(mapWsFrameSent(p, ctx)); break;
    case "Network.webSocketFrameReceived":              emit(mapWsFrameReceived(p, ctx)); break;
    case "Network.webSocketFrameError":                 emit(mapWsFrameError(p, ctx)); break;
    case "Network.webSocketClosed":                     emit(mapWsClosed(p, ctx)); break;
    default: break;
  }
});

/* ---- tab lifecycle ---- */
chrome.tabs.onRemoved.addListener((tabId) => disableCapture(tabId, false));
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined && contexts.has(source.tabId)) disableCapture(source.tabId, false);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const ctx = contexts.get(tabId);
  if (!ctx || !changeInfo.url) return;
  pageUrls.set(tabId, changeInfo.url);
  emit({ type: "session", ts: Date.now(), tabId, sessionId: ctx.sessionId, event: "navigated", url: changeInfo.url, title: tab.title });
});

/* ---- popup messaging ---- */
function stateFor(tabId: number): TabState {
  const c = counts.get(tabId) ?? { console: 0, network: 0 };
  const netMap = netTail.get(tabId);
  return {
    daemonConnected: port !== null,
    capturing: contexts.has(tabId),
    tabId,
    url: pageUrls.get(tabId),
    sessionId: contexts.get(tabId)?.sessionId,
    consoleCount: c.console,
    networkCount: c.network,
    network: netMap ? Array.from(netMap.values()) : [],
    console: conTail.get(tabId) ?? []
  };
}

chrome.runtime.onMessage.addListener((req: PopupRequest, _sender, sendResponse) => {
  if (req.type === "toggleCapture") {
    if (contexts.has(req.tabId)) disableCapture(req.tabId);
    else enableCapture(req.tabId);
    setTimeout(() => sendResponse(stateFor(req.tabId)), 60); // let attach settle before reporting
    return true; // async response
  }
  sendResponse(stateFor(req.tabId)); // getState
  return false;
});
