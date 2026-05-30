/* Tether extension — CDP -> Tether ingest-event mapping + redaction.
 * See ../../docs/DESIGN.md §2 (event schema), §3.1 (wire), §6 (security).
 *
 * The extension emits *ingest* events: `sessionId` is extension-owned; `seq` is stamped by the
 * daemon on ingest and is NOT sent from here. Header redaction happens here, before any event
 * leaves the extension. */

type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";

interface Envelope {
  type: "console" | "network" | "session";
  ts: number;       // Unix epoch ms
  tabId: number;
  sessionId: string; // extension-owned, stable per tab lifetime
}
export interface ConsoleEvent extends Envelope {
  type: "console";
  level: ConsoleLevel;
  text: string;
  args?: string[];
  stack?: string;
  url?: string;
  source: "console-api" | "exception" | "network-error" | "browser-log";
}
export type NetworkPhase =
  | "request" | "response" | "failed" | "finished" | "body"
  | "ws-open" | "ws-handshake" | "ws-frame-sent" | "ws-frame-recv"
  | "ws-frame-error" | "ws-close";

export interface NetworkEvent extends Envelope {
  type: "network";
  requestId: string;
  phase: NetworkPhase;
  method?: string;
  url: string;
  resourceType?: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  durationMs?: number;
  fromCache?: boolean;
  errorText?: string;
  /* Request-phase extras */
  postData?: string;
  postDataBase64?: boolean;
  postDataTruncated?: boolean;
  initiator?: Record<string, unknown>;
  priority?: string;
  /* Response-phase extras (CDP Network.responseReceived.response) */
  httpVersion?: string;        // e.g. "http/1.1" — the protocol field from CDP
  serverIPAddress?: string;
  serverPort?: number;
  connectionId?: number;
  connectionReused?: boolean;
  remoteIPAddress?: string;
  remotePort?: number;
  responseHeadersText?: string;
  encodedResponseHeadersSize?: number;
  timing?: Record<string, number>;
  /* Finished-phase (CDP Network.loadingFinished) extras */
  encodedDataLength?: number;
  decodedBodyLength?: number;
  /* Body-phase payload (size-capped) */
  body?: string;
  bodyBase64?: boolean;
  bodyTruncated?: boolean;
  /* WebSocket-phase extras */
  opcode?: number;
  mask?: boolean;
  payloadData?: string;
  payloadBase64?: boolean;
  payloadTruncated?: boolean;
}
export interface SessionEvent extends Envelope {
  type: "session";
  event: "opened" | "navigated" | "closed";
  url?: string;
  title?: string;
}
export type IngestEvent = ConsoleEvent | NetworkEvent | SessionEvent;

/* ---- daemon control config (§3.1) ---- */
export interface CaptureConfig {
  capture: { console: boolean; network: boolean; bodies: boolean };
  limits: { perSessionEvents: number; bodyMaxBytes: number };
  redact: { headers: string[] };
  filter: { urlAllow: string[]; urlDeny: string[] };
}
export const DEFAULT_CONFIG: CaptureConfig = {
  capture: { console: true, network: true, bodies: true },
  limits: { perSessionEvents: 5000, bodyMaxBytes: 65536 },
  redact: { headers: ["authorization", "cookie", "set-cookie", "proxy-authorization"] },
  filter: { urlAllow: [], urlDeny: [] }
};

/* ---- daemon wire messages (§3.1) ---- */
export interface IngestMessage { v: 1; kind: "events"; events: IngestEvent[]; }
export interface ControlMessage {
  v: 1; kind: "control";
  capture: CaptureConfig["capture"];
  limits: CaptureConfig["limits"];
  redact: CaptureConfig["redact"];
  filter: CaptureConfig["filter"];
}

export function redactHeaders(
  h: Record<string, string> | undefined,
  denylist: string[]
): Record<string, string> | undefined {
  if (!h) return undefined;
  const deny = new Set(denylist.map((k) => k.toLowerCase()));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k] = deny.has(k.toLowerCase()) ? "«redacted»" : v;
  return out;
}

function safeTest(re: string, s: string): boolean {
  try { return new RegExp(re).test(s); } catch { return false; }
}
function urlAllowed(url: string, filter: CaptureConfig["filter"]): boolean {
  if (filter.urlDeny.some((re) => safeTest(re, url))) return false;
  if (filter.urlAllow.length > 0) return filter.urlAllow.some((re) => safeTest(re, url));
  return true;
}

/* Per-tab capture state for one session. */
export interface CaptureContext {
  tabId: number;
  sessionId: string;
  config: CaptureConfig;
  /** CDP monotonic request start (seconds) + url, keyed by requestId, for durationMs / failed url. */
  reqInfo: Map<string, { start: number; url: string }>;
}

function envelope(ctx: CaptureContext, type: Envelope["type"], ts?: number): Envelope {
  return { type, ts: ts ?? Date.now(), tabId: ctx.tabId, sessionId: ctx.sessionId };
}

/* ---- console ---- */
const LEVELS: Record<string, ConsoleLevel> = {
  log: "log", info: "info", warning: "warn", warn: "warn",
  error: "error", debug: "debug", trace: "debug", dir: "log"
};

interface CdpRemoteObject { type: string; value?: unknown; description?: string; unserializableValue?: string; }
interface CdpCallFrame { functionName: string; url: string; lineNumber: number; columnNumber: number; }
interface CdpStackTrace { callFrames: CdpCallFrame[]; }
interface CdpConsoleApiCalled { type: string; args: CdpRemoteObject[]; timestamp?: number; stackTrace?: CdpStackTrace; }
interface CdpExceptionThrown {
  timestamp?: number;
  exceptionDetails: { text: string; url?: string; exception?: CdpRemoteObject; stackTrace?: CdpStackTrace };
}

/* CDP `Runtime.exceptionThrown` splits an uncaught error across two fields: `text` is just the
 * bare prefix ("Uncaught", or "Uncaught (in promise)"), and the real message + type live in
 * `exception.description` ("TypeError: x is not a function\n    at ..."). A thrown primitive
 * (string/number) has no description and carries its content in `exception.value` instead.
 * Compose the DevTools-style headline ("Uncaught TypeError: ...") rather than surfacing the
 * bare "Uncaught", which is what issue #14 reported. */
function exceptionText(d: CdpExceptionThrown["exceptionDetails"]): string {
  const prefix = d.text?.trim();
  const desc = d.exception?.description;
  if (desc) {
    const head = desc.split("\n", 1)[0].trim();
    if (head) return prefix && !head.startsWith(prefix) ? `${prefix} ${head}` : head;
  }
  const val = d.exception?.value;
  if (val !== undefined) {
    const v = typeof val === "string" ? val : JSON.stringify(val);
    return prefix ? `${prefix} ${v}` : v;
  }
  return prefix || "Uncaught exception";
}

function argText(a: CdpRemoteObject): string {
  if (a.value !== undefined) return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
  if (a.unserializableValue) return a.unserializableValue;
  return a.description ?? a.type;
}
function stackText(st?: CdpStackTrace): string | undefined {
  if (!st?.callFrames?.length) return undefined;
  return st.callFrames
    .map((f) => `at ${f.functionName || "<anonymous>"} (${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1})`)
    .join("\n");
}

export function mapConsoleApiCalled(p: CdpConsoleApiCalled, ctx: CaptureContext, pageUrl?: string): ConsoleEvent | null {
  if (!ctx.config.capture.console) return null;
  const args = p.args.map(argText);
  return {
    ...envelope(ctx, "console", p.timestamp), type: "console",
    level: LEVELS[p.type] ?? "log", text: args.join(" "), args,
    stack: stackText(p.stackTrace), url: pageUrl, source: "console-api"
  };
}

export function mapExceptionThrown(p: CdpExceptionThrown, ctx: CaptureContext, pageUrl?: string): ConsoleEvent | null {
  if (!ctx.config.capture.console) return null;
  const d = p.exceptionDetails;
  return {
    ...envelope(ctx, "console", p.timestamp), type: "console", level: "error",
    text: exceptionText(d),
    stack: stackText(d.stackTrace) ?? d.exception?.description,
    url: d.url ?? pageUrl, source: "exception"
  };
}

/* CDP `Log.entryAdded` — browser-level diagnostics that don't come through Runtime:
 * network/CORS failures, CSS parse warnings, deprecations, mixed content, interventions, etc.
 * `source: "javascript"` entries are skipped because Runtime.exceptionThrown already covers them. */
type CdpLogSource =
  | "xml" | "javascript" | "network" | "storage" | "appcache" | "rendering" | "security"
  | "deprecation" | "worker" | "violation" | "intervention" | "recommendation" | "other";
interface CdpLogEntry {
  source: CdpLogSource;
  level: "verbose" | "info" | "warning" | "error";
  text: string;
  category?: string;
  timestamp: number;
  url?: string;
  lineNumber?: number;
  stackTrace?: CdpStackTrace;
  networkRequestId?: string;
  args?: CdpRemoteObject[];
}
interface CdpLogEntryAdded { entry: CdpLogEntry; }

const LOG_LEVELS: Record<CdpLogEntry["level"], ConsoleLevel> = {
  verbose: "debug", info: "info", warning: "warn", error: "error"
};

export function mapLogEntryAdded(p: CdpLogEntryAdded, ctx: CaptureContext, pageUrl?: string): ConsoleEvent | null {
  if (!ctx.config.capture.console) return null;
  const e = p.entry;
  if (e.source === "javascript") return null; // covered by Runtime.exceptionThrown
  const args = e.args?.map(argText);
  return {
    ...envelope(ctx, "console", e.timestamp), type: "console",
    level: LOG_LEVELS[e.level] ?? "log",
    text: `[${e.source}${e.category ? ":" + e.category : ""}] ${e.text}`,
    args, stack: stackText(e.stackTrace),
    url: e.url ?? pageUrl,
    source: e.source === "network" ? "network-error" : "browser-log"
  };
}

/* ---- network ---- */
interface CdpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  hasPostData?: boolean;
}
interface CdpInitiator { type: string; stack?: CdpStackTrace; url?: string; lineNumber?: number; }
interface CdpRequestWillBeSent {
  requestId: string;
  request: CdpRequest;
  timestamp: number; wallTime?: number;
  type?: string;
  initiator?: CdpInitiator;
  redirectResponse?: CdpResponse;
}
interface CdpResourceTiming {
  requestTime: number;
  proxyStart: number; proxyEnd: number;
  dnsStart: number; dnsEnd: number;
  connectStart: number; connectEnd: number;
  sslStart: number; sslEnd: number;
  sendStart: number; sendEnd: number;
  receiveHeadersStart?: number; receiveHeadersEnd: number;
  pushStart?: number; pushEnd?: number;
  workerStart?: number; workerReady?: number;
  workerFetchStart?: number; workerRespondWithSettled?: number;
}
interface CdpResponse {
  url: string;
  status: number; statusText: string;
  headers: Record<string, string>;
  headersText?: string;
  mimeType: string;
  charset?: string;
  requestHeaders?: Record<string, string>;
  requestHeadersText?: string;
  connectionReused?: boolean;
  connectionId?: number;
  remoteIPAddress?: string;
  remotePort?: number;
  fromDiskCache?: boolean;
  fromServiceWorker?: boolean;
  fromPrefetchCache?: boolean;
  encodedDataLength?: number;
  timing?: CdpResourceTiming;
  protocol?: string;
}
interface CdpResponseReceived {
  requestId: string;
  response: CdpResponse;
  timestamp: number;
  type?: string;
  hasExtraInfo?: boolean;
}
interface CdpLoadingFailed {
  requestId: string;
  errorText: string;
  timestamp: number;
  type?: string;
  canceled?: boolean;
  blockedReason?: string;
  corsErrorStatus?: { corsError: string; failedParameter?: string };
}
interface CdpLoadingFinished {
  requestId: string;
  timestamp: number;
  encodedDataLength: number;
}

/** Trim a UTF-8 string to a byte cap; for binary base64 payloads, trim base64 length to cap proxy. */
function capString(s: string, base64: boolean, cap: number): { value: string; truncated: boolean } {
  if (base64) {
    if (s.length <= cap) return { value: s, truncated: false };
    return { value: s.slice(0, cap), truncated: true };
  }
  // approximate byte size — TextEncoder is available in service workers
  const enc = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
  if (enc) {
    const bytes = enc.encode(s);
    if (bytes.length <= cap) return { value: s, truncated: false };
    // safe slice on code units, then trim trailing partial utf-8 by re-decoding
    return { value: new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, cap)), truncated: true };
  }
  if (s.length <= cap) return { value: s, truncated: false };
  return { value: s.slice(0, cap), truncated: true };
}

export function mapRequestWillBeSent(p: CdpRequestWillBeSent, ctx: CaptureContext): NetworkEvent | null {
  if (!ctx.config.capture.network || !urlAllowed(p.request.url, ctx.config.filter)) return null;
  ctx.reqInfo.set(p.requestId, { start: p.timestamp, url: p.request.url });
  const ts = p.wallTime ? Math.round(p.wallTime * 1000) : Date.now();
  const ev: NetworkEvent = {
    ...envelope(ctx, "network", ts), type: "network", requestId: p.requestId, phase: "request",
    method: p.request.method, url: p.request.url, resourceType: p.type?.toLowerCase(),
    requestHeaders: redactHeaders(p.request.headers, ctx.config.redact.headers),
    initiator: p.initiator as unknown as Record<string, unknown> | undefined
  };
  if (ctx.config.capture.bodies && p.request.postData) {
    const { value, truncated } = capString(p.request.postData, false, ctx.config.limits.bodyMaxBytes);
    ev.postData = value;
    ev.postDataBase64 = false;
    if (truncated) ev.postDataTruncated = true;
  }
  return ev;
}

export function mapResponseReceived(p: CdpResponseReceived, ctx: CaptureContext): NetworkEvent | null {
  if (!ctx.config.capture.network || !urlAllowed(p.response.url, ctx.config.filter)) return null;
  const info = ctx.reqInfo.get(p.requestId);
  const durationMs = info ? Math.round((p.timestamp - info.start) * 1000) : undefined;
  const r = p.response;
  return {
    ...envelope(ctx, "network"), type: "network", requestId: p.requestId, phase: "response",
    url: r.url, resourceType: p.type?.toLowerCase(), status: r.status,
    statusText: r.statusText, mimeType: r.mimeType,
    responseHeaders: redactHeaders(r.headers, ctx.config.redact.headers),
    durationMs, fromCache: r.fromDiskCache,
    httpVersion: r.protocol,
    serverIPAddress: r.remoteIPAddress,
    serverPort: r.remotePort,
    remoteIPAddress: r.remoteIPAddress,
    remotePort: r.remotePort,
    connectionId: r.connectionId,
    connectionReused: r.connectionReused,
    responseHeadersText: r.headersText,
    encodedResponseHeadersSize: r.headersText ? r.headersText.length : undefined,
    timing: r.timing as unknown as Record<string, number> | undefined
  };
}

export function mapLoadingFailed(p: CdpLoadingFailed, ctx: CaptureContext): NetworkEvent | null {
  if (!ctx.config.capture.network) return null;
  const info = ctx.reqInfo.get(p.requestId);
  ctx.reqInfo.delete(p.requestId);
  const durationMs = info ? Math.round((p.timestamp - info.start) * 1000) : undefined;
  return {
    ...envelope(ctx, "network"), type: "network", requestId: p.requestId, phase: "failed",
    url: info?.url ?? "", errorText: p.errorText, resourceType: p.type?.toLowerCase(), durationMs
  };
}

export function mapLoadingFinished(p: CdpLoadingFinished, ctx: CaptureContext): NetworkEvent | null {
  if (!ctx.config.capture.network) return null;
  const info = ctx.reqInfo.get(p.requestId);
  ctx.reqInfo.delete(p.requestId);
  const durationMs = info ? Math.round((p.timestamp - info.start) * 1000) : undefined;
  return {
    ...envelope(ctx, "network"), type: "network", requestId: p.requestId, phase: "finished",
    url: info?.url ?? "", durationMs, encodedDataLength: p.encodedDataLength
  };
}

/* Emit body event after fetching from CDP. background.ts owns the async fetch. */
export function buildBodyEvent(
  ctx: CaptureContext,
  requestId: string,
  url: string,
  body: string,
  base64Encoded: boolean
): NetworkEvent {
  const { value, truncated } = capString(body, base64Encoded, ctx.config.limits.bodyMaxBytes);
  return {
    ...envelope(ctx, "network"), type: "network", requestId, phase: "body",
    url, body: value, bodyBase64: base64Encoded, bodyTruncated: truncated || undefined
  };
}

/* ---- WebSocket ---- */
interface CdpWebSocketCreated { requestId: string; url: string; initiator?: CdpInitiator; }
interface CdpWebSocketHandshakeRequest {
  requestId: string; timestamp: number; wallTime?: number;
  request: { headers: Record<string, string> };
}
interface CdpWebSocketHandshakeResponse {
  requestId: string; timestamp: number;
  response: {
    status: number; statusText: string;
    headers: Record<string, string>;
    headersText?: string;
    requestHeaders?: Record<string, string>;
    requestHeadersText?: string;
  };
}
interface CdpWebSocketFrame {
  requestId: string; timestamp: number;
  response: { opcode: number; mask: boolean; payloadData: string };
}
interface CdpWebSocketFrameError { requestId: string; timestamp: number; errorMessage: string; }
interface CdpWebSocketClosed { requestId: string; timestamp: number; }

export function mapWsCreated(p: CdpWebSocketCreated, ctx: CaptureContext): NetworkEvent | null {
  if (!ctx.config.capture.network || !urlAllowed(p.url, ctx.config.filter)) return null;
  ctx.reqInfo.set(p.requestId, { start: Date.now() / 1000, url: p.url });
  return {
    ...envelope(ctx, "network"), type: "network", requestId: p.requestId, phase: "ws-open",
    url: p.url, resourceType: "websocket",
    initiator: p.initiator as unknown as Record<string, unknown> | undefined
  };
}

export function mapWsHandshakeRequest(p: CdpWebSocketHandshakeRequest, ctx: CaptureContext): NetworkEvent | null {
  if (!ctx.config.capture.network) return null;
  const info = ctx.reqInfo.get(p.requestId);
  if (info && !urlAllowed(info.url, ctx.config.filter)) return null;
  const ts = p.wallTime ? Math.round(p.wallTime * 1000) : Date.now();
  return {
    ...envelope(ctx, "network", ts), type: "network", requestId: p.requestId, phase: "request",
    url: info?.url ?? "", resourceType: "websocket", method: "GET",
    requestHeaders: redactHeaders(p.request.headers, ctx.config.redact.headers)
  };
}

export function mapWsHandshakeResponse(p: CdpWebSocketHandshakeResponse, ctx: CaptureContext): NetworkEvent | null {
  if (!ctx.config.capture.network) return null;
  const info = ctx.reqInfo.get(p.requestId);
  if (info && !urlAllowed(info.url, ctx.config.filter)) return null;
  const durationMs = info ? Math.round((p.timestamp - info.start) * 1000) : undefined;
  return {
    ...envelope(ctx, "network"), type: "network", requestId: p.requestId, phase: "ws-handshake",
    url: info?.url ?? "", resourceType: "websocket",
    status: p.response.status, statusText: p.response.statusText,
    responseHeaders: redactHeaders(p.response.headers, ctx.config.redact.headers),
    responseHeadersText: p.response.headersText,
    durationMs
  };
}

function mapWsFrame(
  p: CdpWebSocketFrame, ctx: CaptureContext,
  phase: "ws-frame-sent" | "ws-frame-recv"
): NetworkEvent | null {
  if (!ctx.config.capture.network) return null;
  const info = ctx.reqInfo.get(p.requestId);
  if (info && !urlAllowed(info.url, ctx.config.filter)) return null;
  // CDP gives payloadData as a UTF-8 string for opcode 1 (text) and base64 for opcode 2 (binary).
  const isBinary = p.response.opcode === 2;
  const { value, truncated } = capString(p.response.payloadData, isBinary, ctx.config.limits.bodyMaxBytes);
  return {
    ...envelope(ctx, "network"), type: "network", requestId: p.requestId, phase,
    url: info?.url ?? "", resourceType: "websocket",
    opcode: p.response.opcode, mask: p.response.mask,
    payloadData: value, payloadBase64: isBinary || undefined,
    payloadTruncated: truncated || undefined
  };
}
export function mapWsFrameSent(p: CdpWebSocketFrame, ctx: CaptureContext): NetworkEvent | null {
  return mapWsFrame(p, ctx, "ws-frame-sent");
}
export function mapWsFrameReceived(p: CdpWebSocketFrame, ctx: CaptureContext): NetworkEvent | null {
  return mapWsFrame(p, ctx, "ws-frame-recv");
}
export function mapWsFrameError(p: CdpWebSocketFrameError, ctx: CaptureContext): NetworkEvent | null {
  if (!ctx.config.capture.network) return null;
  const info = ctx.reqInfo.get(p.requestId);
  if (info && !urlAllowed(info.url, ctx.config.filter)) return null;
  return {
    ...envelope(ctx, "network"), type: "network", requestId: p.requestId, phase: "ws-frame-error",
    url: info?.url ?? "", resourceType: "websocket", errorText: p.errorMessage
  };
}
export function mapWsClosed(p: CdpWebSocketClosed, ctx: CaptureContext): NetworkEvent | null {
  if (!ctx.config.capture.network) return null;
  const info = ctx.reqInfo.get(p.requestId);
  if (info && !urlAllowed(info.url, ctx.config.filter)) return null;
  ctx.reqInfo.delete(p.requestId);
  return {
    ...envelope(ctx, "network"), type: "network", requestId: p.requestId, phase: "ws-close",
    url: info?.url ?? "", resourceType: "websocket"
  };
}
