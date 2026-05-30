/* Tether extension — background service worker.
 *
 * Holds the Native Messaging port to `tetherd`, attaches chrome.debugger (CDP) per captured tab,
 * maps CDP events to the ingest schema (capture.ts), batches, and forwards to the daemon. Applies
 * daemon `control` config. See ../../docs/DESIGN.md §3.1.
 *
 * NOTE (MV3): in-memory state (contexts/counts) lives only as long as the service worker. An
 * attached debugger usually keeps the worker alive during active capture, but Chrome can still
 * terminate an idle worker (e.g. a quiet page with no console/network traffic). When that happens
 * the debugger detaches and capture silently stops — issue #15 ("extension sometimes would
 * abruptly fail"). To make capture self-healing we (1) persist the set of capturing tabIds to
 * chrome.storage.session, (2) re-establish capture on worker startup and on a keepalive alarm,
 * and (3) keep a recurring alarm so the worker is woken periodically while capturing. Session
 * storage is intentionally per-browser-session: it survives worker restarts but clears on browser
 * exit, so capture never silently resurrects across a full restart. */

import {
  buildBodyEvent, CaptureConfig, CaptureContext, ControlMessage, DEFAULT_CONFIG, IngestEvent,
  IngestMessage, mapConsoleApiCalled, mapExceptionThrown, mapLoadingFailed, mapLoadingFinished,
  mapLogEntryAdded, mapRequestWillBeSent, mapResponseReceived,
  mapWsClosed, mapWsCreated, mapWsFrameError, mapWsFrameReceived, mapWsFrameSent,
  mapWsHandshakeRequest, mapWsHandshakeResponse
} from "./capture.js";
import { PopupConsoleRow, PopupNetworkRow, PopupRequest, TabState, ToastDetailMessage, ToastMessage } from "./messages.js";

const NATIVE_HOST = "com.ensue.tether";
const CDP_VERSION = "1.3";
const FLUSH_MS = 500;
const MAX_QUEUE = 10000; // bound the outbound queue if the daemon is unreachable
const POPUP_TAIL = 100;  // popup-only recent-event window (per tab, per channel)
const KEEPALIVE_ALARM = "tether-keepalive"; // wakes the worker while capturing (see header note)
const CAPTURING_KEY = "tether.capturingTabs"; // chrome.storage.session key: number[] of tabIds

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
    maybeToast(ev);
  }
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}

/* Surface a toast in the page when a captured tab sees a failing API call.
 * Triggers: 5xx on any document/xhr/fetch/script/websocket request, 4xx on
 * xhr/fetch (app-initiated API calls — your backend, Stripe, etc.), and real
 * network failures. Asset 4xx/5xx, document/script 4xx (SPA route misses),
 * user-initiated aborts, and extension blocks are filtered out. The daemon
 * still receives every event regardless. */
const TOAST_RESOURCE_TYPES = new Set(["document", "xhr", "fetch", "script", "websocket"]);
const API_RESOURCE_TYPES = new Set(["xhr", "fetch"]);
const TOAST_QUIET_ERRORS = new Set([
  "net::ERR_ABORTED",          // navigation cancelled mid-flight
  "net::ERR_BLOCKED_BY_CLIENT" // ad-block / DNT blocked
]);

/* Per-request method, kept until the response body either arrives or the
 * request fails. CDP only carries `method` on Network.requestWillBeSent, so
 * we cache it here to enrich the response-phase toast. */
const requestMethods = new Map<string, string>();
/* requestIds that triggered a toast; used to gate the body-phase follow-up so
 * we only forward bodies for toasted requests. Bounded to keep memory honest. */
const toastedRequests = new Set<string>();
const TOASTED_MAX = 256;

function detailFromBody(body: string): { body: string; kind: "json" | "text"; truncated: boolean } | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  const MAX = 240;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const oneLine = JSON.stringify(parsed);
    if (oneLine.length <= MAX) return { body: oneLine, kind: "json", truncated: false };
    if (parsed && typeof parsed === "object") {
      for (const k of ["error", "message", "detail", "title", "error_description"]) {
        const v = (parsed as Record<string, unknown>)[k];
        if (typeof v === "string" && v.length > 0) {
          const out = v.length > MAX ? v.slice(0, MAX) : v;
          return { body: out, kind: "text", truncated: v.length > MAX };
        }
      }
    }
    return { body: oneLine.slice(0, MAX), kind: "json", truncated: true };
  } catch {
    if (trimmed.length <= MAX) return { body: trimmed, kind: "text", truncated: false };
    return { body: trimmed.slice(0, MAX), kind: "text", truncated: true };
  }
}

function maybeToast(ev: import("./capture.js").NetworkEvent): void {
  if (!contexts.has(ev.tabId)) return;

  // Body-phase follow-up: if this requestId triggered a toast and the body is
  // text (not binary), forward an excerpt so the toast can grow with detail.
  if (ev.phase === "body") {
    if (!toastedRequests.has(ev.requestId)) return;
    toastedRequests.delete(ev.requestId);
    if (!ev.body || ev.bodyBase64) return;
    const detail = detailFromBody(ev.body);
    if (!detail) return;
    const msg: ToastDetailMessage = {
      type: "toast-detail",
      requestId: ev.requestId,
      body: detail.body,
      bodyTruncated: detail.truncated || ev.bodyTruncated,
      kind: detail.kind
    };
    try { chrome.tabs.sendMessage(ev.tabId, msg, () => void chrome.runtime.lastError); } catch { /* no receiver */ }
    return;
  }

  const rt = ev.resourceType;
  const interesting = !rt || TOAST_RESOURCE_TYPES.has(rt);
  const status = ev.status ?? 0;
  const isServerErr = ev.phase === "response" && status >= 500 && interesting;
  const isApiClientErr = ev.phase === "response" && status >= 400 && status < 500 &&
    !!rt && API_RESOURCE_TYPES.has(rt);
  const isNetFail = ev.phase === "failed" && !!ev.errorText && interesting &&
    !TOAST_QUIET_ERRORS.has(ev.errorText);
  if (!isServerErr && !isApiClientErr && !isNetFail) return;

  if (isServerErr || isApiClientErr) {
    // Mark for body-phase enrichment. Bound the set; oldest entry drops first.
    if (toastedRequests.size >= TOASTED_MAX) {
      const oldest = toastedRequests.values().next();
      if (!oldest.done) toastedRequests.delete(oldest.value);
    }
    toastedRequests.add(ev.requestId);
  }

  const msg: ToastMessage = {
    type: "toast",
    requestId: ev.requestId,
    status: ev.status,
    method: ev.method ?? requestMethods.get(ev.requestId),
    url: ev.url,
    errorText: ev.errorText
  };
  try {
    chrome.tabs.sendMessage(ev.tabId, msg, () => void chrome.runtime.lastError);
  } catch {
    // chrome:// pages, the Web Store, PDF viewers etc. have no content script — ignore.
  }
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

/* ---- worker-restart resilience (issue #15) ---- */
/* Mirror the live set of capturing tabIds into session storage so a restarted
 * worker can re-attach. Called whenever `contexts` membership changes. */
function persistCapturing(): void {
  try {
    chrome.storage.session.set({ [CAPTURING_KEY]: [...contexts.keys()] }, () => void chrome.runtime.lastError);
  } catch { /* storage unavailable — recovery is best-effort */ }
}

/* Keep a recurring alarm alive exactly while we're capturing. The alarm both
 * wakes an idle worker (so capture resumes promptly after a restart) and gives
 * the worker periodic activity. 0.5 min is Chrome's minimum alarm period. */
function syncKeepalive(): void {
  if (contexts.size > 0) chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  else chrome.alarms.clear(KEEPALIVE_ALARM, () => void chrome.runtime.lastError);
}

/* Re-attach capture for every persisted tab not already live. Runs on worker
 * startup and on each keepalive alarm; a no-op once everything is attached.
 * Tabs that have since closed are pruned from the persisted set. */
function recoverCapturing(): void {
  try {
    chrome.storage.session.get(CAPTURING_KEY, (data) => {
      if (chrome.runtime.lastError || !data) return;
      const stored = data[CAPTURING_KEY];
      const tabIds = Array.isArray(stored) ? stored.filter((n): n is number => typeof n === "number") : [];
      // Nothing to capture (e.g. session storage cleared on browser restart) —
      // make sure no durable keepalive alarm keeps ticking pointlessly.
      if (tabIds.length === 0 && contexts.size === 0) {
        chrome.alarms.clear(KEEPALIVE_ALARM, () => void chrome.runtime.lastError);
        return;
      }
      for (const tabId of tabIds) {
        if (contexts.has(tabId)) continue;
        chrome.tabs.get(tabId, (tab) => {
          if (chrome.runtime.lastError || !tab) { prunePersisted(tabId); return; }
          enableCapture(tabId);
        });
      }
    });
  } catch { /* storage unavailable */ }
}

/* Drop a single tabId from the persisted set (a tab that closed while the
 * worker was asleep, so chrome.tabs.onRemoved never fired for it). */
function prunePersisted(tabId: number): void {
  try {
    chrome.storage.session.get(CAPTURING_KEY, (data) => {
      if (chrome.runtime.lastError || !data) return;
      const stored = data[CAPTURING_KEY];
      if (!Array.isArray(stored)) return;
      const next = stored.filter((n) => n !== tabId);
      if (next.length !== stored.length) {
        chrome.storage.session.set({ [CAPTURING_KEY]: next }, () => void chrome.runtime.lastError);
      }
    });
  } catch { /* storage unavailable */ }
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
    persistCapturing();
    syncKeepalive();
    chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
    chrome.debugger.sendCommand({ tabId }, "Network.enable", {
      maxResourceBufferSize: 10 * 1024 * 1024,
      maxTotalBufferSize: 100 * 1024 * 1024
    });
    chrome.debugger.sendCommand({ tabId }, "Log.enable");
    /* Manifest content scripts only inject on fresh page loads, so any tab open
     * before the extension was (re)loaded has no toast listener. Inject now so
     * the very first error after toggling CAPTURE is delivered. A sentinel in
     * toast.ts guards against double-registration if the manifest version is
     * already present. */
    chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ["content/toast.js"]
    }).catch(() => { /* chrome://, web store, file:// — no content scripts allowed */ });
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
  persistCapturing();
  syncKeepalive();
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
      const req = p as { requestId: string; request: { url: string; method: string } };
      bodyUrls.set(req.requestId, req.request.url);
      requestMethods.set(req.requestId, req.request.method);
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
      requestMethods.delete(req.requestId);
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
          requestMethods.delete(req.requestId);
        });
      } else {
        bodyUrls.delete(req.requestId);
        requestMethods.delete(req.requestId);
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

/* ---- worker lifecycle (issue #15) ---- */
/* Re-establish capture on each keepalive tick. After an idle-worker restart the
 * alarm is one of the events that wakes us; recoverCapturing() then re-attaches
 * the debugger for any tab that was capturing. A no-op once everything is live. */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) recoverCapturing();
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

/* Top-level: runs on every worker start, including an idle restart. If a prior
 * session was capturing (persisted in chrome.storage.session), re-attach now so
 * capture resumes without the user having to toggle CAPTURE again (issue #15). */
recoverCapturing();
