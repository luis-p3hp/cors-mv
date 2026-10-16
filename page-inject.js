/**
 * Main-world script: the virtual microphone.
 *
 * Runs at document_start, before Meet/Teams grab a reference to
 * navigator.mediaDevices.getUserMedia, and replaces it with a version that
 * returns a WebAudio mix:
 *
 *     [real microphone] --micGain--\
 *                                   >--> MediaStreamDestination --> page
 *     [other meeting]  --remoteGain-/
 *
 * The destination node is created once and never swapped, so the page keeps a
 * stable track even when the bridge is started or stopped mid-meeting.
 */

(() => {
  'use strict';

  if (window.__audioBridgeInstalled) return;
  window.__audioBridgeInstalled = true;

  const TAG = '[CORS-MV]';
  const md = navigator.mediaDevices;
  if (!md || typeof md.getUserMedia !== 'function') return;

  const origGUM = md.getUserMedia.bind(md);

  let opts = { includeMic: true, micGain: 1, remoteGain: 1 };
  let running = false;
  let readySent = false;

  let ctx = null;
  let mixDest = null;
  let micGainNode = null;
  let remoteGainNode = null;
  let micPromise = null;

  let pc = null;
  let remoteSrc = null;
  let remoteSink = null; // keeps the WebRTC track flowing (Chrome quirk)
  let pendingIce = [];

  const log = (...a) => { try { console.debug(TAG, ...a); } catch (_) {} };
  const post = (msg) => window.postMessage({ __audioBridge: 'toExt', msg }, '*');

  /* ---------------------------------------------------------------- */
  /* audio graph                                                       */
  /* ---------------------------------------------------------------- */

  function ensureCtx() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    mixDest = ctx.createMediaStreamDestination();
    micGainNode = ctx.createGain();
    remoteGainNode = ctx.createGain();
    micGainNode.connect(mixDest);
    remoteGainNode.connect(mixDest);
    applyOpts();

    const resume = () => {
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    };
    ctx.onstatechange = resume;
    ['click', 'keydown', 'pointerdown'].forEach((e) =>
      window.addEventListener(e, resume, { capture: true, passive: true })
    );
    resume();
    log('virtual microphone graph created');
  }

  function applyOpts() {
    if (micGainNode) micGainNode.gain.value = opts.includeMic ? opts.micGain : 0;
    if (remoteGainNode) remoteGainNode.gain.value = opts.remoteGain;
  }

  async function ensureMic(audioConstraints) {
    if (!opts.includeMic) return null;
    if (micPromise) return micPromise;
    micPromise = (async () => {
      const c = (audioConstraints && typeof audioConstraints === 'object') ? audioConstraints : true;
      const stream = await origGUM({ audio: c });
      ensureCtx();
      ctx.createMediaStreamSource(stream).connect(micGainNode);
      log('real microphone mixed in');
      return stream;
    })().catch((err) => {
      // No mic, or the user denied it: the bridge audio alone still goes out.
      log('real microphone unavailable:', (err && err.name) || err);
      return null;
    });
    return micPromise;
  }

  /* ---------------------------------------------------------------- */
  /* getUserMedia patch                                                */
  /* ---------------------------------------------------------------- */

  md.getUserMedia = async function getUserMedia(constraints) {
    try {
      if (!constraints || !constraints.audio) return await origGUM(constraints);

      ensureCtx();
      announce();
      await ensureMic(constraints.audio);

      const out = new MediaStream();
      out.addTrack(mixDest.stream.getAudioTracks()[0].clone());

      if (constraints.video) {
        const v = await origGUM({ video: constraints.video });
        v.getVideoTracks().forEach((t) => out.addTrack(t));
      }
      log('handed the page a virtual microphone track');
      return out;
    } catch (err) {
      log('falling back to the real getUserMedia:', err);
      return await origGUM(constraints);
    }
  };

  // Legacy callback form, still used by some builds.
  if (typeof navigator.getUserMedia === 'function') {
    navigator.getUserMedia = function (constraints, ok, fail) {
      md.getUserMedia(constraints).then(ok, fail);
    };
  }

  /* ---------------------------------------------------------------- */
  /* signalling with the offscreen document                            */
  /* ---------------------------------------------------------------- */

  function announce() {
    if (!running || readySent || !mixDest) return;
    readySent = true;
    post({ type: 'page-ready' });
  }

  async function onOffer(sdp) {
    teardownRemote();
    ensureCtx();

    pc = new RTCPeerConnection({ iceServers: [] });
    pendingIce = [];

    pc.ontrack = (ev) => {
      const stream = ev.streams[0] || new MediaStream([ev.track]);
      attachRemote(stream);
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) post({ type: 'page-signal', kind: 'ice', data: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      log('bridge connection:', pc.connectionState);
      if (pc.connectionState === 'failed') { teardownRemote(); readySent = false; announce(); }
    };

    await pc.setRemoteDescription({ type: 'offer', sdp });
    for (const c of pendingIce.splice(0)) { try { await pc.addIceCandidate(c); } catch (_) {} }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    post({ type: 'page-signal', kind: 'answer', data: { sdp: pc.localDescription.sdp } });
  }

  function attachRemote(stream) {
    ensureCtx();
    // Chrome only pumps a remote WebRTC track into WebAudio while the stream is
    // also attached to a media element; muted so it is not heard twice locally.
    remoteSink = new Audio();
    remoteSink.srcObject = stream;
    remoteSink.muted = true;
    remoteSink.play().catch(() => {});

    remoteSrc = ctx.createMediaStreamSource(stream);
    remoteSrc.connect(remoteGainNode);
    log('other meeting audio is now feeding the virtual microphone');
  }

  function teardownRemote() {
    if (remoteSrc) { try { remoteSrc.disconnect(); } catch (_) {} remoteSrc = null; }
    if (remoteSink) { try { remoteSink.pause(); remoteSink.srcObject = null; } catch (_) {} remoteSink = null; }
    if (pc) { try { pc.close(); } catch (_) {} pc = null; }
  }

  /* ---------------------------------------------------------------- */
  /* messages from the relay                                           */
  /* ---------------------------------------------------------------- */

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__audioBridge !== 'toPage' || !d.msg) return;
    handle(d.msg).catch((e) => log('handler error', e));
  });

  async function handle(msg) {
    switch (msg.type) {
      case 'relay-ready':
        post({ type: 'page-hello', wantsReply: true });
        return;

      case 'reply':
        if (msg.for === 'page-hello' && msg.resp) applyBridgeState(msg.resp);
        return;

      case 'bridge-state':
        applyBridgeState(msg);
        return;

      case 'signal':
        if (msg.kind === 'offer') return await onOffer(msg.data.sdp);
        if (msg.kind === 'ice') {
          if (!pc || !pc.remoteDescription) pendingIce.push(msg.data);
          else { try { await pc.addIceCandidate(msg.data); } catch (_) {} }
        }
        return;

      case 'disconnect':
        teardownRemote();
        readySent = false;
        return;
    }
  }

  function applyBridgeState(s) {
    const was = running;
    running = !!s.running;
    if (s.opts) { opts = { ...opts, ...s.opts }; applyOpts(); }
    if (!running) {
      if (was) log('bridge stopped');
      teardownRemote();
      readySent = false;
    } else {
      if (!was) log('bridge started for this tab');
      announce();
    }
  }

  window.addEventListener('pagehide', () => post({ type: 'page-gone' }));

  // The relay may already be listening (world load order is not guaranteed).
  post({ type: 'page-hello', wantsReply: true });
})();
