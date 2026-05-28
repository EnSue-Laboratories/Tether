/* Tether popup — monochrome JetBrains Mono UI (v3.6 design, see thread
 * #Agents:ab6f8be6). Drives:
 *   - CAPTURE toggle (role="switch")
 *   - Network / Console channel toggle (role="tablist")
 *   - REQ / ERR clickable filter buttons (role="button", aria-pressed)
 *   - Empty / guide-line state when no capture
 *
 * The popup talks to the background worker via runtime messages (see
 * ../src/messages.ts). Event-list streaming + selectable detail are scoped
 * for a follow-up PR; the current TabState exposes counts only, so this PR
 * renders status + counts and keeps the event-list area as a documented
 * empty state.
 */

import {
  PopupConsoleRow,
  PopupNetworkRow,
  PopupRequest,
  TabState
} from "../src/messages.js";

type Channel = "network" | "console";
type Filter = "all" | "err";

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

function shorten(u: string): string {
  try {
    const x = new URL(u);
    return x.host + x.pathname;
  } catch {
    return u;
  }
}

interface UiState {
  channel: Channel;
  filter: Filter;
  tabId: number | undefined;
  latest: TabState | null;
  /** Row ids the user has expanded. Persists across the 1s poll re-render. */
  expanded: Set<string>;
}

const ui: UiState = {
  channel: "network",
  filter: "all",
  tabId: undefined,
  latest: null,
  expanded: new Set<string>(),
};

// ---- Render ---------------------------------------------------------------

function renderCapture(s: TabState): void {
  const btn = el<HTMLButtonElement>("capture-toggle");
  btn.setAttribute("aria-checked", String(s.capturing));
  // Don't disable the toggle on `!daemonConnected`: the background only
  // connects to the native host AFTER the first capture request, so a fresh
  // popup always shows daemonConnected=false. Disabling here would deadlock
  // the user. Failure to connect (e.g. host not installed) is surfaced by
  // the post-toggle TabState, not by greying out the control upfront.
}

function renderChannel(): void {
  // Single text label: shows the *current* channel — clicking swaps it.
  const sw = el<HTMLButtonElement>("channel-switch");
  sw.textContent = ui.channel.toUpperCase();
  sw.dataset.channel = ui.channel;
}

function renderFilter(): void {
  el("filter-all").setAttribute("aria-pressed", String(ui.filter === "all"));
  el("filter-err").setAttribute("aria-pressed", String(ui.filter === "err"));
  // Active label switches between REQ (network) and EVT (console). Terse so
  // the button stays the same width on channel switch.
  el("metric-all-label").textContent = ui.channel === "console" ? "EVT" : "REQ";
}

function renderCounts(s: TabState): void {
  const visible = ui.channel === "console" ? s.consoleCount : s.networkCount;
  el("metric-all-count").textContent = String(visible);
  // ERR = rows that match the channel's error predicate in the current tail.
  // This is a *visible* count (tail-bounded), not a lifetime count — matches
  // what the user sees in the list.
  const errCount =
    ui.channel === "console"
      ? s.console.filter(isConsoleErr).length
      : s.network.filter(isNetworkErr).length;
  el("metric-err-count").textContent = String(errCount);
}

function isNetworkErr(r: PopupNetworkRow): boolean {
  if (r.errorText) return true;
  if (r.status !== undefined && r.status >= 400) return true;
  return false;
}
function isConsoleErr(r: PopupConsoleRow): boolean {
  return r.level === "error" || r.level === "warn";
}

function renderStatus(s: TabState): void {
  const wrap = el("agent-status");
  const label = el("agent-status-label");
  if (s.capturing) {
    wrap.classList.remove("paused");
    label.textContent = "Listening";
  } else {
    wrap.classList.add("paused");
    label.textContent = "Paused";
  }
}

function renderEmptyState(_s: TabState): void {
  // Single message across all three empty states: capture off, capture on
  // with no events yet, and current channel/filter empty. The placeholder
  // itself communicates "nothing to show", and we don't need to distinguish.
  el("empty-title").textContent = "No capture in progress";
}

function renderList(s: TabState): void {
  const list = el<HTMLUListElement>("event-list");
  const empty = el("empty-state");
  const rows = s.capturing ? visibleRows(s) : [];
  if (rows.length === 0) {
    empty.hidden = false;
    list.hidden = true;
    list.replaceChildren();
    return;
  }
  empty.hidden = true;
  list.hidden = false;
  // Newest-first in the list — capture buffer is newest-last.
  const frag = document.createDocumentFragment();
  for (let i = rows.length - 1; i >= 0; i--) frag.appendChild(rowEl(rows[i]));
  list.replaceChildren(frag);
}

type RowKind = { kind: "net"; row: PopupNetworkRow } | { kind: "con"; row: PopupConsoleRow };

function visibleRows(s: TabState): RowKind[] {
  if (ui.channel === "console") {
    const rs = ui.filter === "err" ? s.console.filter(isConsoleErr) : s.console;
    return rs.map((row) => ({ kind: "con" as const, row }));
  }
  const rs = ui.filter === "err" ? s.network.filter(isNetworkErr) : s.network;
  return rs.map((row) => ({ kind: "net" as const, row }));
}

function rowEl(r: RowKind): HTMLLIElement {
  return r.kind === "net" ? netRowEl(r.row) : conRowEl(r.row);
}

function netRowEl(r: PopupNetworkRow): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "log-item";
  if (r.errorText || (r.status !== undefined && r.status >= 400)) li.classList.add("is-error");
  if (r.status === undefined && !r.errorText) li.classList.add("is-pending");
  if (ui.expanded.has(r.id)) li.classList.add("is-expanded");

  const summary = document.createElement("div");
  summary.className = "log-summary";

  const tag = document.createElement("span");
  tag.className = "method-tag";
  tag.textContent = (r.method ?? "—").toUpperCase();

  const details = document.createElement("span");
  details.className = "log-details";
  const url = document.createElement("span");
  url.className = "log-url";
  url.textContent = shorten(r.url);
  const meta = document.createElement("span");
  meta.className = "log-meta";
  meta.textContent = netMeta(r);
  details.appendChild(url);
  details.appendChild(meta);

  const status = document.createElement("span");
  status.className = "status";
  status.textContent = netStatusText(r);

  summary.appendChild(tag);
  summary.appendChild(details);
  summary.appendChild(status);
  li.appendChild(summary);

  if (ui.expanded.has(r.id)) li.appendChild(netDetailsEl(r));

  summary.addEventListener("click", () => toggleExpanded(r.id));
  return li;
}

function netDetailsEl(r: PopupNetworkRow): HTMLElement {
  const pane = document.createElement("div");
  pane.className = "log-pane";
  const rows: Array<[string, string | undefined]> = [
    ["URL", r.url],
    ["METHOD", r.method],
    ["STATUS", r.status === undefined ? (r.errorText ? "—" : "pending") : String(r.status)],
    ["TYPE", r.resourceType],
    ["DURATION", r.durationMs !== undefined ? `${r.durationMs}ms` : undefined],
    ["TS", new Date(r.ts).toISOString()],
    ["ERROR", r.errorText]
  ];
  for (const [k, v] of rows) {
    if (!v) continue;
    pane.appendChild(detailRow(k, v));
  }
  return pane;
}

function netMeta(r: PopupNetworkRow): string {
  const parts: string[] = [];
  if (r.resourceType) parts.push(r.resourceType);
  if (r.durationMs !== undefined) parts.push(`${r.durationMs}ms`);
  if (r.errorText) parts.push(r.errorText);
  return parts.join(" · ");
}
function netStatusText(r: PopupNetworkRow): string {
  if (r.errorText) return "ERR";
  if (r.status === undefined) return "…";
  return String(r.status);
}

function conRowEl(r: PopupConsoleRow): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "log-item is-console";
  if (r.level === "error") li.classList.add("is-error");
  if (r.level === "warn") li.classList.add("is-warn");
  if (ui.expanded.has(r.id)) li.classList.add("is-expanded");

  const summary = document.createElement("div");
  summary.className = "log-summary";

  const tag = document.createElement("span");
  tag.className = "method-tag";
  tag.textContent = r.level.toUpperCase();

  const details = document.createElement("span");
  details.className = "log-details";
  const text = document.createElement("span");
  text.className = "log-url";
  text.textContent = r.text || "(empty)";
  details.appendChild(text);
  if (r.url) {
    const meta = document.createElement("span");
    meta.className = "log-meta";
    meta.textContent = shorten(r.url);
    details.appendChild(meta);
  }

  const status = document.createElement("span");
  status.className = "status";

  summary.appendChild(tag);
  summary.appendChild(details);
  summary.appendChild(status);
  li.appendChild(summary);

  if (ui.expanded.has(r.id)) li.appendChild(conDetailsEl(r));

  summary.addEventListener("click", () => toggleExpanded(r.id));
  return li;
}

function conDetailsEl(r: PopupConsoleRow): HTMLElement {
  const pane = document.createElement("div");
  pane.className = "log-pane";
  pane.appendChild(detailMessage(r.text || "(empty)"));
  const meta: Array<[string, string | undefined]> = [
    ["LEVEL", r.level.toUpperCase()],
    ["URL", r.url],
    ["TS", new Date(r.ts).toISOString()]
  ];
  for (const [k, v] of meta) {
    if (!v) continue;
    pane.appendChild(detailRow(k, v));
  }
  return pane;
}

function detailRow(label: string, value: string): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "pane-row";
  const l = document.createElement("span");
  l.className = "pane-label";
  l.textContent = label;
  const v = document.createElement("span");
  v.className = "pane-value";
  v.textContent = value;
  row.appendChild(l);
  row.appendChild(v);
  return row;
}

function detailMessage(text: string): HTMLDivElement {
  const m = document.createElement("div");
  m.className = "pane-message";
  m.textContent = text;
  return m;
}

function toggleExpanded(id: string): void {
  if (ui.expanded.has(id)) ui.expanded.delete(id);
  else ui.expanded.add(id);
  if (ui.latest) render(ui.latest);
}

function render(s: TabState): void {
  ui.latest = s;
  renderCapture(s);
  renderChannel();
  renderFilter();
  renderCounts(s);
  renderStatus(s);
  renderEmptyState(s);
  renderList(s);
}

// ---- Messaging ------------------------------------------------------------

function send(req: PopupRequest): Promise<TabState> {
  return chrome.runtime.sendMessage<PopupRequest, TabState>(req);
}

async function refresh(): Promise<void> {
  if (ui.tabId === undefined) return;
  try {
    render(await send({ type: "getState", tabId: ui.tabId }));
  } catch {
    // Background worker not awake / no daemon yet — keep last render.
  }
}

// ---- Event wiring ---------------------------------------------------------

function bindCaptureToggle(): void {
  el<HTMLButtonElement>("capture-toggle").addEventListener("click", async () => {
    if (ui.tabId === undefined) return;
    render(await send({ type: "toggleCapture", tabId: ui.tabId }));
  });
}

function bindChannelToggle(): void {
  el<HTMLButtonElement>("channel-switch").addEventListener("click", () => {
    ui.channel = ui.channel === "network" ? "console" : "network";
    if (ui.latest) render(ui.latest);
  });
}

function bindFilterButtons(): void {
  el<HTMLButtonElement>("filter-all").addEventListener("click", () => {
    if (ui.filter === "all") return;
    ui.filter = "all";
    if (ui.latest) render(ui.latest);
  });
  el<HTMLButtonElement>("filter-err").addEventListener("click", () => {
    if (ui.filter === "err") return;
    ui.filter = "err";
    if (ui.latest) render(ui.latest);
  });
}

// ---- Entry ----------------------------------------------------------------

async function main(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  ui.tabId = tab?.id;
  if (ui.tabId === undefined) {
    el("empty-title").textContent = "— No active tab";
    return;
  }

  bindCaptureToggle();
  bindChannelToggle();
  bindFilterButtons();

  await refresh();

  const timer = window.setInterval(refresh, 1000);
  window.addEventListener("unload", () => window.clearInterval(timer));
}

void main();
