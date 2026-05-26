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
  CaptureConfig, CaptureContext, ControlMessage, DEFAULT_CONFIG, IngestEvent, IngestMessage,
  mapConsoleApiCalled, mapExceptionThrown, mapLoadingFailed, mapRequestWillBeSent, mapResponseReceived
} from "./capture.js";
import { PopupRequest, TabState } from "./messages.js";

const NATIVE_HOST = "com.ensue.tether";
const CDP_VERSION = "1.3";
const FLUSH_MS = 500;
const MAX_QUEUE = 10000; // bound the outbound queue if the daemon is unreachable

let port: chrome.runtime.Port | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let config: CaptureConfig = DEFAULT_CONFIG;
let queue: IngestEvent[] = [];

const contexts = new Map<number, CaptureContext>();                 // tabId -> capture context
const counts = new Map<number, { console: number; network: number }>();
const pageUrls = new Map<number, string>();                         // tabId -> last known url

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
  if (ev.type === "console") bump(ev.tabId, "console");
  else if (ev.type === "network" && ev.phase === "request") bump(ev.tabId, "network");
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
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
    chrome.debugger.sendCommand({ tabId }, "Network.enable");
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
  if (detach) chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; });
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
    case "Network.requestWillBeSent": emit(mapRequestWillBeSent(p, ctx)); break;
    case "Network.responseReceived":  emit(mapResponseReceived(p, ctx)); break;
    case "Network.loadingFailed":     emit(mapLoadingFailed(p, ctx)); break;
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
  return {
    daemonConnected: port !== null,
    capturing: contexts.has(tabId),
    tabId,
    url: pageUrls.get(tabId),
    sessionId: contexts.get(tabId)?.sessionId,
    consoleCount: c.console,
    networkCount: c.network
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
