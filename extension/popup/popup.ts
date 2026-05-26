/* Tether popup logic (SKELETON, Phase 0). English UI only.
 * Shows daemon/connection status, current tab + session, recent event counts, and a capture toggle
 * that asks the background worker to enable/disable capture for the active tab. */

// TODO: query the active tab (chrome.tabs.query{active,currentWindow}); show its URL.
// TODO: ask the background worker for state (daemon connected? capturing this tab? counts) via
//       chrome.runtime.sendMessage, and render into the #ids in popup.html.
// TODO: wire #toggle -> sendMessage({ type: "toggleCapture", tabId }) -> background enable/disableCapture.
// TODO: live-update counts while the popup is open (poll or port subscription).

export {};
