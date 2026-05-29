/* Tether extension — error toast content script.
 *
 * Receives a `ToastMessage` from the background when it sees a 5xx response
 * or a non-asset network failure on a captured tab, and renders a small
 * top-center toast. All UI lives in a *closed* shadow root attached to
 * documentElement so page CSS/JS can't reach in. Toast styling mirrors the
 * popup's monochrome devtool aesthetic. */
import type { ToastDetailMessage, ToastMessage } from "./messages.js";

type AnyToastMsg = ToastMessage | ToastDetailMessage;

const STACK_MAX = 3;        // bound concurrent toasts
const TTL_MS = 4000;        // auto-dismiss
const DEDUP_MS = 2000;      // ignore re-fires for same requestId within this window

const recent = new Map<string, number>(); // requestId -> last shown ts
let stack: ShadowRoot | null = null;

const TOAST_CSS = `
:host { all: initial; }
.stack {
  position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
  z-index: 2147483647;
  display: flex; flex-direction: column; gap: 8px;
  pointer-events: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Courier New', monospace;
  -webkit-font-smoothing: antialiased;
}
.toast {
  pointer-events: auto;
  min-width: 260px; max-width: 460px;
  background: #000; color: #fff;
  border: 1px solid #2a2a2a;
  border-top: 3px solid #A0A0A0;
  padding: 11px 14px 12px;
  display: flex; flex-direction: column; gap: 4px;
  cursor: pointer; position: relative; overflow: hidden;
  opacity: 0; transform: translateY(-8px);
  transition: opacity 180ms ease, transform 180ms ease;
  box-shadow: 0 10px 28px rgba(0,0,0,0.55);
  user-select: none;
}
.toast.in { opacity: 1; transform: translateY(0); }
.toast.out { opacity: 0; transform: translateY(-6px); }
.head { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.status {
  font-size: 11px; font-weight: 700; letter-spacing: 0.18em; color: #fff;
  font-feature-settings: "tnum" 1; white-space: nowrap;
}
.method {
  font-size: 9.5px; font-weight: 700; color: #888; letter-spacing: 0.08em;
  white-space: nowrap;
}
.spacer { flex: 1; }
.brand {
  font-size: 9px; font-weight: 700; color: #555; letter-spacing: 0.22em;
  white-space: nowrap;
}
.url {
  font-size: 10.5px; color: #888; line-height: 1.45;
  word-break: break-all;
}
.more {
  display: none;
  font-size: 11px; color: #888; letter-spacing: 0.18em;
  margin-right: 8px; line-height: 1;
}
.has-detail .more { display: inline; }
.has-detail:hover .more { color: #fff; }
.detail {
  margin: 0; padding: 0 9px;
  background: rgba(255, 255, 255, 0.04);
  border-left: 2px solid #A0A0A0;
  font-size: 10.5px; line-height: 1.5;
  color: #fff;
  white-space: pre-wrap; word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Courier New', monospace;
  max-height: 0; opacity: 0; overflow: hidden; position: relative;
  transition: max-height 180ms ease, opacity 140ms ease,
              padding 180ms ease, margin-top 180ms ease;
}
.toast:hover .detail {
  max-height: 110px;
  opacity: 1;
  margin-top: 6px;
  padding: 7px 9px 8px;
}
.detail-fade {
  position: absolute; left: 0; right: 0; bottom: 0; height: 18px;
  background: linear-gradient(to bottom, rgba(0,0,0,0), rgba(0,0,0,0.85));
  pointer-events: none;
}
/* Hovering pauses the TTL countdown so users can read the body in peace. */
.toast:hover .bar { animation-play-state: paused; }
.bar {
  position: absolute; left: 0; bottom: 0; height: 2px; width: 100%;
  background: #A0A0A0;
  transform-origin: left center; transform: scaleX(1);
}
/* CSS animation (not transition) so we don't depend on a paint between the
 * initial scaleX(1) and the final scaleX(0). */
.bar.run { animation: tether-toast-bar linear forwards; }
@keyframes tether-toast-bar {
  from { transform: scaleX(1); }
  to   { transform: scaleX(0); }
}
@media (prefers-reduced-motion: reduce) {
  .toast { transition: opacity 80ms ease; transform: none; }
  .toast.in, .toast.out { transform: none; }
  .bar.run { animation: none; transform: scaleX(0); }
}
`;

function ensureStack(): ShadowRoot {
  if (stack) return stack;
  const hostEl = document.createElement("tether-toast-host");
  // Belt-and-suspenders: stop page CSS that targets unknown elements from styling us.
  hostEl.style.cssText =
    "all:initial;position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;";
  document.documentElement.appendChild(hostEl);
  const root = hostEl.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = TOAST_CSS;
  const layer = document.createElement("div");
  layer.className = "stack";
  root.append(style, layer);
  stack = root;
  return root;
}

function shortenUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const tail = u.pathname + u.search;
    const full = u.host + tail;
    if (full.length <= 64) return full;
    return full.slice(0, 32) + "…" + full.slice(-30);
  } catch {
    if (raw.length <= 64) return raw;
    return raw.slice(0, 32) + "…" + raw.slice(-30);
  }
}

function statusLabel(m: ToastMessage): string {
  if (typeof m.status === "number") return `HTTP ${m.status}`;
  if (m.errorText) {
    // "net::ERR_CONNECTION_REFUSED" -> "ERR_CONNECTION_REFUSED"
    return m.errorText.replace(/^net::/, "");
  }
  return "NET ERR";
}

function dismiss(node: HTMLElement): void {
  if (!node.isConnected) return;
  node.classList.remove("in");
  node.classList.add("out");
  setTimeout(() => node.remove(), 220);
}

function render(msg: ToastMessage): void {
  const now = Date.now();
  const last = recent.get(msg.requestId);
  if (last && now - last < DEDUP_MS) return;
  recent.set(msg.requestId, now);
  if (recent.size > 256) {
    // GC oldest entries — Map preserves insertion order.
    const cutoff = now - 30_000;
    for (const [k, v] of recent) {
      if (v < cutoff) recent.delete(k);
      else break;
    }
  }

  const root = ensureStack();
  const stackEl = root.querySelector(".stack") as HTMLElement;

  while (stackEl.children.length >= STACK_MAX) {
    const first = stackEl.firstElementChild as HTMLElement | null;
    if (!first) break;
    first.remove();
  }

  const toast = document.createElement("div");
  toast.className = "toast";
  toast.dataset.rid = msg.requestId;
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");

  const head = document.createElement("div");
  head.className = "head";
  const status = document.createElement("span");
  status.className = "status";
  status.textContent = statusLabel(msg);
  const method = document.createElement("span");
  method.className = "method";
  method.textContent = msg.method ?? "GET";
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  const more = document.createElement("span");
  more.className = "more";
  more.textContent = "···";
  const brand = document.createElement("span");
  brand.className = "brand";
  brand.textContent = "TETHER";
  head.append(status, method, spacer, more, brand);

  const url = document.createElement("div");
  url.className = "url";
  url.textContent = shortenUrl(msg.url);

  const bar = document.createElement("div");
  bar.className = "bar";

  toast.append(head, url, bar);
  toast.addEventListener("click", () => dismiss(toast));
  stackEl.append(toast);

  // Animate in + drive the TTL bar.
  bar.style.animationDuration = `${TTL_MS}ms`;
  requestAnimationFrame(() => {
    toast.classList.add("in");
    bar.classList.add("run");
  });

  setTimeout(() => dismiss(toast), TTL_MS);
}

function applyDetail(msg: ToastDetailMessage): void {
  if (!stack) return;
  const toast = stack.querySelector(
    `.toast[data-rid="${CSS.escape(msg.requestId)}"]`
  ) as HTMLElement | null;
  if (!toast) return;                                  // toast already auto-dismissed
  if (toast.querySelector(".detail")) return;          // already enriched
  const block = document.createElement("pre");
  block.className = "detail" + (msg.kind === "json" ? " is-json" : "");
  block.textContent = msg.bodyTruncated ? msg.body + "…" : msg.body;
  const fade = document.createElement("div");
  fade.className = "detail-fade";
  block.append(fade);
  // Insert before the TTL bar so the bar stays pinned to the bottom.
  const bar = toast.querySelector(".bar");
  if (bar) toast.insertBefore(block, bar);
  else toast.append(block);
  // Surfaces the "···" hint in the head row and unlocks the :hover reveal.
  toast.classList.add("has-detail");
}

/* Both the manifest content_scripts entry and an on-demand
 * chrome.scripting.executeScript from background.ts can land in the same
 * isolated world. Per-injection function-scoped state (constants, the local
 * `stack` host) is harmless, but a duplicate runtime listener would render two
 * toasts per error. Gate addListener via a window sentinel. */
type Sentinel = Window & { __tetherToastInstalled?: boolean };
const sentinel = window as Sentinel;
if (!sentinel.__tetherToastInstalled) {
  sentinel.__tetherToastInstalled = true;
  chrome.runtime.onMessage.addListener((msg: AnyToastMsg) => {
    if (!msg) return;
    if (window.top !== window) return;
    if (msg.type === "toast") render(msg);
    else if (msg.type === "toast-detail") applyDetail(msg);
  });
}
