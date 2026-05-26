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
export interface NetworkEvent extends Envelope {
  type: "network";
  requestId: string;
  phase: "request" | "response" | "failed";
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
  capture: { console: true, network: true, bodies: false },
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
    text: d.text || d.exception?.description || "Uncaught exception",
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
interface CdpRequestWillBeSent {
  requestId: string;
  request: { url: string; method: string; headers: Record<string, string> };
  timestamp: number; wallTime?: number; type?: string;
}
interface CdpResponseReceived {
  requestId: string;
  response: { url: string; status: number; statusText: string; headers: Record<string, string>; mimeType: string; fromDiskCache?: boolean };
  timestamp: number; type?: string;
}
interface CdpLoadingFailed { requestId: string; errorText: string; timestamp: number; type?: string; }

export function mapRequestWillBeSent(p: CdpRequestWillBeSent, ctx: CaptureContext): NetworkEvent | null {
  if (!ctx.config.capture.network || !urlAllowed(p.request.url, ctx.config.filter)) return null;
  ctx.reqInfo.set(p.requestId, { start: p.timestamp, url: p.request.url });
  const ts = p.wallTime ? Math.round(p.wallTime * 1000) : Date.now();
  return {
    ...envelope(ctx, "network", ts), type: "network", requestId: p.requestId, phase: "request",
    method: p.request.method, url: p.request.url, resourceType: p.type?.toLowerCase(),
    requestHeaders: redactHeaders(p.request.headers, ctx.config.redact.headers)
  };
}

export function mapResponseReceived(p: CdpResponseReceived, ctx: CaptureContext): NetworkEvent | null {
  if (!ctx.config.capture.network || !urlAllowed(p.response.url, ctx.config.filter)) return null;
  const info = ctx.reqInfo.get(p.requestId);
  const durationMs = info ? Math.round((p.timestamp - info.start) * 1000) : undefined;
  return {
    ...envelope(ctx, "network"), type: "network", requestId: p.requestId, phase: "response",
    url: p.response.url, resourceType: p.type?.toLowerCase(), status: p.response.status,
    statusText: p.response.statusText, mimeType: p.response.mimeType,
    responseHeaders: redactHeaders(p.response.headers, ctx.config.redact.headers),
    durationMs, fromCache: p.response.fromDiskCache
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
