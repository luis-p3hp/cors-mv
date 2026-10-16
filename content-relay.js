/**
 * Isolated-world relay.
 *
 * The virtual microphone has to live in the page's own JS world (that is the
 * only place where patching navigator.mediaDevices.getUserMedia is visible to
 * Meet/Teams), and that world has no chrome.* APIs. This script is the postal
 * service between the two: window.postMessage <-> chrome.runtime.
 */

(() => {
  'use strict';

  // page -> extension
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__audioBridge !== 'toExt' || !d.msg) return;

    let replied = false;
    try {
      chrome.runtime.sendMessage({ target: 'bg', ...d.msg }, (resp) => {
        void chrome.runtime.lastError; // service worker may be asleep
        if (replied || !d.msg.wantsReply) return;
        replied = true;
        toPage({ type: 'reply', for: d.msg.type, resp: resp || null });
      });
    } catch (_) {
      // extension context invalidated (reloaded/updated) - page keeps working
    }
  });

  // extension -> page
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.target !== 'page') return;
    toPage(msg);
  });

  function toPage(msg) {
    window.postMessage({ __audioBridge: 'toPage', msg }, '*');
  }

  // Tell the page script the relay is alive (it may have loaded first).
  toPage({ type: 'relay-ready' });
})();
