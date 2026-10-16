/**
 * CORS-MV - service worker (orchestrator).
 *
 * Data flow, per direction:
 *   tab A audio --chrome.tabCapture--> offscreen document
 *                --RTCPeerConnection (local loopback)--> page script in tab B
 *                --WebAudio mix--> track handed to tab B's getUserMedia()
 *
 * The service worker never touches media; it only hands out stream ids and
 * relays SDP/ICE between the offscreen document and the page scripts.
 */

const OFFSCREEN_URL = 'offscreen.html';
const DEFAULT_OPTS = { includeMic: true, micGain: 1.0, remoteGain: 1.0 };

let state = {
  sides: { A: null, B: null }, // { tabId, title, url }
  running: false,
  opts: { ...DEFAULT_OPTS },
  error: null
};

/** connId -> { tabId, frameId, side } */
const conns = new Map();
let connSeq = 0;
let offscreenSetup = null;

const ready = (async () => {
  try {
    const s = await chrome.storage.session.get('state');
    if (s && s.state) state = { ...state, ...s.state };
  } catch (_) { /* first run */ }
})();

const persist = () => chrome.storage.session.set({ state }).catch(() => {});

function sideForTab(tabId) {
  if (state.sides.A && state.sides.A.tabId === tabId) return 'A';
  if (state.sides.B && state.sides.B.tabId === tabId) return 'B';
  return null;
}

/* ------------------------------------------------------------------ */
/* offscreen document                                                  */
/* ------------------------------------------------------------------ */

async function hasOffscreen() {
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return ctxs.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (offscreenSetup) return offscreenSetup;
  offscreenSetup = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Capture each meeting tab audio and relay it to the other meeting tab.'
  }).finally(() => { offscreenSetup = null; });
  return offscreenSetup;
}

async function closeOffscreen() {
  if (await hasOffscreen()) {
    try { await chrome.offscreen.closeDocument(); } catch (_) {}
  }
}

async function toOffscreen(msg) {
  try {
    return await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

async function toPage(tabId, frameId, msg) {
  const options = (typeof frameId === 'number') ? { frameId } : undefined;
  try {
    await chrome.tabs.sendMessage(tabId, { target: 'page', ...msg }, options);
  } catch (_) {
    /* tab may not have the content script loaded yet */
  }
}

function broadcastState() {
  for (const side of ['A', 'B']) {
    const s = state.sides[side];
    if (s) toPage(s.tabId, undefined, { type: 'bridge-state', running: state.running, opts: state.opts });
  }
}

/* ------------------------------------------------------------------ */
/* start / stop                                                        */
/* ------------------------------------------------------------------ */

async function start() {
  if (!state.sides.A || !state.sides.B) throw new Error('Assign both meeting tabs first.');
  if (state.sides.A.tabId === state.sides.B.tabId) throw new Error('Side A and side B must be different tabs.');

  for (const side of ['A', 'B']) {
    const tabId = state.sides[side].tabId;
    try { await chrome.tabs.get(tabId); }
    catch (_) { throw new Error('The tab assigned to side ' + side + ' is gone. Re-assign it.'); }
  }

  await ensureOffscreen();

  const sides = [];
  for (const side of ['A', 'B']) {
    const tabId = state.sides[side].tabId;
    let streamId;
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    } catch (err) {
      await closeOffscreen();
      throw new Error(
        'Cannot capture side ' + side + ' ("' + state.sides[side].title + '"): ' +
        String((err && err.message) || err) +
        '. Switch to that tab, open this popup there, and press "Assign this tab" again.'
      );
    }
    sides.push({ side, tabId, streamId });
  }

  const res = await toOffscreen({ type: 'start', sides });
  if (!res || res.ok === false) {
    await closeOffscreen();
    throw new Error((res && res.error) || 'Offscreen capture failed.');
  }

  conns.clear();
  state.running = true;
  state.error = null;
  await persist();
  broadcastState();
  return { ok: true, state };
}

async function stop() {
  state.running = false;
  await persist();
  for (const [connId, c] of conns) {
    toPage(c.tabId, c.frameId, { type: 'disconnect', connId });
  }
  conns.clear();
  await toOffscreen({ type: 'stop' });
  await closeOffscreen();
  broadcastState();
  return { ok: true, state };
}

async function connectPage(side, tabId, frameId) {
  for (const [id, c] of [...conns]) {
    if (c.tabId === tabId && c.frameId === frameId) {
      conns.delete(id);
      await toOffscreen({ type: 'disconnect', connId: id });
    }
  }
  const connId = 'c' + (++connSeq);
  conns.set(connId, { tabId, frameId, side });
  const res = await toOffscreen({ type: 'connect', connId, side });
  if (!res || res.ok === false) conns.delete(connId);
  return res;
}

/* ------------------------------------------------------------------ */
/* messaging                                                           */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'bg') return;
  ready
    .then(() => handle(msg, sender))
    .then((r) => sendResponse(r === undefined ? { ok: true } : r))
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});

async function handle(msg, sender) {
  switch (msg.type) {

    case 'get-state':
      return { ok: true, state, connected: conns.size };

    case 'assign': {
      const { side, tab } = msg;
      state.sides[side] = { tabId: tab.id, title: tab.title || '(untitled)', url: tab.url || '' };
      await persist();
      return { ok: true, state };
    }

    case 'unassign': {
      state.sides[msg.side] = null;
      await persist();
      if (state.running) await stop();
      return { ok: true, state };
    }

    case 'start':
      return await start();

    case 'stop':
      return await stop();

    case 'set-opts':
      state.opts = { ...state.opts, ...msg.opts };
      await persist();
      broadcastState();
      return { ok: true, state };

    /* ---- from the page scripts ---- */

    case 'page-hello': {
      const side = sideForTab(sender.tab && sender.tab.id);
      return { ok: true, running: state.running && !!side, opts: state.opts, side };
    }

    case 'page-ready': {
      const tabId = sender.tab && sender.tab.id;
      const side = sideForTab(tabId);
      if (!side || !state.running) return { ok: false, error: 'not bridging this tab' };
      return await connectPage(side, tabId, sender.frameId);
    }

    case 'page-signal': {
      const tabId = sender.tab && sender.tab.id;
      let connId = null;
      for (const [id, c] of conns) {
        if (c.tabId === tabId && c.frameId === sender.frameId) { connId = id; break; }
      }
      if (!connId) return { ok: false, error: 'unknown connection' };
      return await toOffscreen({ type: 'signal', connId, kind: msg.kind, data: msg.data });
    }

    case 'page-gone': {
      const tabId = sender.tab && sender.tab.id;
      for (const [id, c] of [...conns]) {
        if (c.tabId === tabId && c.frameId === sender.frameId) {
          conns.delete(id);
          await toOffscreen({ type: 'disconnect', connId: id });
        }
      }
      return { ok: true };
    }

    /* ---- from the offscreen document ---- */

    case 'signal-out': {
      const c = conns.get(msg.connId);
      if (!c) return { ok: false, error: 'stale connection' };
      await toPage(c.tabId, c.frameId, { type: 'signal', kind: msg.kind, data: msg.data });
      return { ok: true };
    }

    case 'offscreen-error':
      state.error = msg.error;
      await persist();
      return { ok: true };

    default:
      return { ok: false, error: 'unknown message ' + msg.type };
  }
}

/* ------------------------------------------------------------------ */
/* tab lifecycle                                                       */
/* ------------------------------------------------------------------ */

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  const side = sideForTab(tabId);
  if (!side) return;
  state.sides[side] = null;
  await persist();
  if (state.running) await stop();
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  await ready;
  const side = sideForTab(tabId);
  if (!side) return;
  if (info.title && state.sides[side]) {
    state.sides[side].title = info.title;
    await persist();
  }
  if (info.status !== 'loading' || !info.url) return;
  // A navigation tears down the page connection (and drops activeTab).
  for (const [id, c] of [...conns]) {
    if (c.tabId === tabId) {
      conns.delete(id);
      await toOffscreen({ type: 'disconnect', connId: id });
    }
  }
});
