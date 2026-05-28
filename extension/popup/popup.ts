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

import { PopupRequest, TabState } from "../src/messages.js";

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
}

const ui: UiState = {
  channel: "network",
  filter: "all",
  tabId: undefined,
  latest: null,
};

// ---- Render ---------------------------------------------------------------

function renderCapture(s: TabState): void {
  const btn = el<HTMLButtonElement>("capture-toggle");
  btn.setAttribute("aria-checked", String(s.capturing));
  // Daemon down → disable the toggle so users can't fire futile requests.
  btn.disabled = !s.daemonConnected;
}

function renderChannel(): void {
  for (const name of ["network", "console"] as Channel[]) {
    const node = el<HTMLButtonElement>(`channel-${name}`);
    node.setAttribute("aria-selected", String(ui.channel === name));
  }
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
  // ERR is not tracked separately on TabState yet — show 0 until the daemon
  // surfaces an error subcount. Footer remains clickable so the affordance
  // is discoverable.
  el("metric-err-count").textContent = "0";
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

function renderEmptyState(s: TabState): void {
  const title = el("empty-title");
  if (!s.daemonConnected) {
    title.textContent = "— Daemon disconnected";
    return;
  }
  if (!s.capturing) {
    title.textContent = "— No capture in progress";
    return;
  }
  const host = s.url ? shorten(s.url) : "this tab";
  title.textContent = `— Capturing ${host}`;
}

function render(s: TabState): void {
  ui.latest = s;
  renderCapture(s);
  renderChannel();
  renderFilter();
  renderCounts(s);
  renderStatus(s);
  renderEmptyState(s);
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
  for (const name of ["network", "console"] as Channel[]) {
    el<HTMLButtonElement>(`channel-${name}`).addEventListener("click", () => {
      if (ui.channel === name) return;
      ui.channel = name;
      if (ui.latest) render(ui.latest);
    });
  }
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
