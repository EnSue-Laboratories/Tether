/* Tether extension — background service worker (SKELETON, Phase 0).
 *
 * Responsibilities (see ../../docs/DESIGN.md):
 *  - Hold the Native Messaging port to `tetherd` (com.ensue.tether), reconnect on drop.
 *  - On capture-enable for a tab: attach chrome.debugger (CDP), enable Runtime + Network domains.
 *  - Map CDP events -> Tether event schema (capture.ts), redact, batch, and post to the daemon.
 *  - Apply daemon `control` messages (capture toggles, limits, redaction, url filters).
 *
 * Phase 0 = structure + TODOs only. Real wiring lands after the daemon (Codex) is in.
 */

const NATIVE_HOST = "com.ensue.tether";

let port: chrome.runtime.Port | null = null;
const attached = new Set<number>(); // tabIds currently being captured

function connectDaemon(): void {
  // TODO: chrome.runtime.connectNative(NATIVE_HOST); wire onMessage(control) + onDisconnect(retry).
}

export function enableCapture(tabId: number): void {
  if (attached.has(tabId)) return;
  // TODO: chrome.debugger.attach({ tabId }, "1.3", ...) then send Runtime.enable + Network.enable.
  //       Subscribe to Runtime.consoleAPICalled / Runtime.exceptionThrown / Network.* via
  //       chrome.debugger.onEvent, convert with capture.ts, and forward through `port`.
  attached.add(tabId);
}

export function disableCapture(tabId: number): void {
  if (!attached.has(tabId)) return;
  // TODO: chrome.debugger.detach({ tabId }); emit a session "closed" event.
  attached.delete(tabId);
}

// TODO: chrome.tabs.onRemoved -> disableCapture + session "closed".
// TODO: chrome.debugger.onDetach -> clean up `attached` (e.g. user closed the debugger infobar).

connectDaemon();
