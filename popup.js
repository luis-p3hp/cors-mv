/* Popup UI. All state lives in the service worker; this is a thin client. */

const $ = (id) => document.getElementById(id);

const els = {
  toggle: $('toggle'),
  status: $('status'),
  includeMic: $('include-mic'),
  micGain: $('mic-gain'),
  micGainOut: $('mic-gain-out'),
  remoteGain: $('remote-gain'),
  remoteGainOut: $('remote-gain-out')
};

let state = null;
let currentTab = null;

const send = (msg) => chrome.runtime.sendMessage({ target: 'bg', ...msg });

function hostOf(url) {
  try { return new URL(url).host; } catch (_) { return ''; }
}

function setStatus(text, kind) {
  els.status.textContent = text;
  els.status.className = kind || 'idle';
}

function renderSide(side) {
  const key = side.toLowerCase();
  const slot = state.sides[side];
  const titleEl = $(key + '-title');
  const hostEl = $(key + '-host');
  const assignEl = $(key + '-assign');
  const clearEl = $(key + '-clear');

  if (slot) {
    titleEl.textContent = slot.title;
    titleEl.className = 'slot';
    hostEl.textContent = hostOf(slot.url);
    clearEl.disabled = state.running;
  } else {
    titleEl.textContent = 'not assigned';
    titleEl.className = 'slot empty';
    hostEl.textContent = '';
    clearEl.disabled = true;
  }

  const isCurrent = slot && currentTab && slot.tabId === currentTab.id;
  assignEl.textContent = isCurrent ? 'This tab ✓' : 'Assign this tab';
  assignEl.disabled = state.running || !currentTab || isCurrent;
}

function render() {
  renderSide('A');
  renderSide('B');

  const ready = !!(state.sides.A && state.sides.B);
  els.toggle.textContent = state.running ? 'Stop bridge' : 'Start bridge';
  els.toggle.className = state.running ? 'stop' : 'primary';
  els.toggle.disabled = !ready && !state.running;

  els.includeMic.checked = !!state.opts.includeMic;
  els.micGain.value = Math.round(state.opts.micGain * 100);
  els.micGainOut.textContent = els.micGain.value + '%';
  els.micGain.disabled = !state.opts.includeMic;
  els.remoteGain.value = Math.round(state.opts.remoteGain * 100);
  els.remoteGainOut.textContent = els.remoteGain.value + '%';

  if (state.running) setStatus('Bridging — each side hears the other.', 'live');
  else if (state.error) setStatus(state.error, 'err');
  else if (!ready) setStatus('Assign a tab to each side to begin.', 'idle');
  else setStatus('Ready.', 'idle');
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab || null;
  const res = await send({ type: 'get-state' });
  state = res.state;
  render();
}

/* ---- events ---- */

for (const side of ['A', 'B']) {
  $(side.toLowerCase() + '-assign').addEventListener('click', async () => {
    if (!currentTab) return;
    const res = await send({
      type: 'assign',
      side,
      tab: { id: currentTab.id, title: currentTab.title, url: currentTab.url }
    });
    state = res.state;
    render();
  });

  $(side.toLowerCase() + '-clear').addEventListener('click', async () => {
    const res = await send({ type: 'unassign', side });
    state = res.state;
    render();
  });
}

els.toggle.addEventListener('click', async () => {
  els.toggle.disabled = true;
  setStatus(state.running ? 'Stopping…' : 'Starting…', 'idle');
  const res = await send({ type: state.running ? 'stop' : 'start' });
  if (res && res.ok === false) {
    await refresh();
    setStatus(res.error || 'Failed.', 'err');
    return;
  }
  await refresh();
});

async function pushOpts(patch) {
  const res = await send({ type: 'set-opts', opts: patch });
  state = res.state;
  render();
}

els.includeMic.addEventListener('change', () => pushOpts({ includeMic: els.includeMic.checked }));

els.micGain.addEventListener('input', () => { els.micGainOut.textContent = els.micGain.value + '%'; });
els.micGain.addEventListener('change', () => pushOpts({ micGain: Number(els.micGain.value) / 100 }));

els.remoteGain.addEventListener('input', () => { els.remoteGainOut.textContent = els.remoteGain.value + '%'; });
els.remoteGain.addEventListener('change', () => pushOpts({ remoteGain: Number(els.remoteGain.value) / 100 }));

refresh();
