/* Tether popup — English UI: daemon status, current tab/session, event counts, capture toggle.
 * Talks to the background worker via runtime messages (../src/messages.ts). */

import { PopupRequest, TabState } from "../src/messages.js";

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

function shorten(u: string): string {
  try { const x = new URL(u); return x.host + x.pathname; } catch { return u; }
}

function render(s: TabState): void {
  el("daemon-dot").classList.toggle("on", s.daemonConnected);
  el("daemon-text").textContent = s.daemonConnected ? "connected" : "disconnected";
  el("tab-url").textContent = s.url ? shorten(s.url) : "—";
  el("session-id").textContent = s.capturing && s.sessionId ? s.sessionId : "—";
  el("console-count").textContent = String(s.consoleCount);
  el("network-count").textContent = String(s.networkCount);
  (el("toggle") as HTMLButtonElement).textContent = s.capturing
    ? "Stop capturing this tab"
    : "Start capturing this tab";
}

function send(req: PopupRequest): Promise<TabState> {
  return chrome.runtime.sendMessage<PopupRequest, TabState>(req);
}

async function main(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tab?.id;
  if (tabId === undefined) { el("tab-url").textContent = "no active tab"; return; }

  render(await send({ type: "getState", tabId }));

  el("toggle").addEventListener("click", async () => {
    render(await send({ type: "toggleCapture", tabId }));
  });

  // Live-refresh counts while the popup is open.
  const timer = setInterval(async () => render(await send({ type: "getState", tabId })), 1000);
  window.addEventListener("unload", () => clearInterval(timer));
}

void main();
