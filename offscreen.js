/**
 * Offscreen document: owns the two tabCapture streams and one
 * RTCPeerConnection per connected page frame.
 *
 * The peer connections are pure local loopback (no ICE servers, host/mDNS
 * candidates only), which is the only way to hand a live MediaStream from an
 * extension context to a web page's JS context.
 */

const capture = { A: null, B: null }; // side -> { stream, audioEl }
const pcs = new Map();                // connId -> { pc, side, pendingIce: [] }
let started = false;

const otherSide = (side) => (side === 'A' ? 'B' : 'A');

function toBg(msg) {
  return chrome.runtime.sendMessage({ target: 'bg', ...msg }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;
  handle(msg)
    .then((r) => sendResponse(r === undefined ? { ok: true } : r))
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});

async function handle(msg) {
  switch (msg.type) {
    case 'start':      return await start(msg.sides);
    case 'stop':       return await stop();
    case 'connect':    return await connect(msg.connId, msg.side);
    case 'signal':     return await onSignal(msg);
    case 'disconnect': return dropPc(msg.connId);
    case 'ping':       return { ok: true, started, pcs: pcs.size };
    default:           return { ok: false, error: 'unknown ' + msg.type };
  }
}

/* ------------------------------------------------------------------ */
/* tab capture                                                         */
/* ------------------------------------------------------------------ */

async function captureTab(streamId) {
  return await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });
}

async function start(sides) {
  await stop();
  for (const s of sides) {
    const stream = await captureTab(s.streamId);

    // tabCapture silences the tab for the user unless the audio is played
    // back somewhere. Do that here so the meetings stay audible.
    const audioEl = new Audio();
    audioEl.srcObject = stream;
    audioEl.autoplay = true;
    audioEl.volume = 1;
    try { await audioEl.play(); } catch (_) { /* autoplay is allowed for extension pages */ }

    capture[s.side] = { stream, audioEl };
  }
  started = true;
  return { ok: true };
}

async function stop() {
  for (const connId of [...pcs.keys()]) dropPc(connId);
  for (const side of ['A', 'B']) {
    const c = capture[side];
    if (!c) continue;
    try { c.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { c.audioEl.srcObject = null; } catch (_) {}
    capture[side] = null;
  }
  started = false;
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* loopback peer connections                                           */
/* ------------------------------------------------------------------ */

async function connect(connId, side) {
  // The page on `side` must receive the OTHER side's tab audio.
  const source = capture[otherSide(side)];
  if (!source) return { ok: false, error: 'capture for ' + otherSide(side) + ' is not running' };

  const pc = new RTCPeerConnection({ iceServers: [] });
  const entry = { pc, side, pendingIce: [] };
  pcs.set(connId, entry);

  source.stream.getAudioTracks().forEach((t) => pc.addTrack(t, source.stream));

  pc.onicecandidate = (e) => {
    if (e.candidate) toBg({ type: 'signal-out', connId, kind: 'ice', data: e.candidate.toJSON() });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') dropPc(connId);
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await toBg({ type: 'signal-out', connId, kind: 'offer', data: { sdp: pc.localDescription.sdp } });
  return { ok: true, connId };
}

async function onSignal(msg) {
  const entry = pcs.get(msg.connId);
  if (!entry) return { ok: false, error: 'no such connection' };
  const { pc } = entry;

  if (msg.kind === 'answer') {
    await pc.setRemoteDescription({ type: 'answer', sdp: msg.data.sdp });
    for (const c of entry.pendingIce.splice(0)) {
      try { await pc.addIceCandidate(c); } catch (_) {}
    }
    return { ok: true };
  }

  if (msg.kind === 'ice') {
    if (!pc.remoteDescription) entry.pendingIce.push(msg.data);
    else { try { await pc.addIceCandidate(msg.data); } catch (_) {} }
    return { ok: true };
  }

  return { ok: false, error: 'unknown signal ' + msg.kind };
}

function dropPc(connId) {
  const entry = pcs.get(connId);
  if (!entry) return { ok: true };
  pcs.delete(connId);
  try { entry.pc.close(); } catch (_) {}
  return { ok: true };
}
