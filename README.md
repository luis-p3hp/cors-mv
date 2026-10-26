# CORS-MV

A Chrome MV3 extension that patches two live meetings together: what one meeting tab
plays becomes the microphone of the other, in both directions at once. Works between any
two supported browser meeting tabs — Google Meet, Microsoft Teams, and the Zoom **web**
client — in any combination (Meet↔Teams, Meet↔Zoom, Teams↔Zoom, even Zoom↔Zoom).

## How it works

There is no Chrome API for registering a real virtual audio device, so the extension
fakes the microphone *inside the page* instead:

```
Meet tab audio ──chrome.tabCapture──> offscreen document ──RTCPeerConnection──> Teams page
                                                                                    │
                                              real mic (optional) ──┐               │
                                                                    ▼               ▼
                                                       WebAudio mix ──> getUserMedia() result
```

and symmetrically in the other direction.

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest, two content scripts (MAIN + ISOLATED worlds) |
| `background.js` | Service worker: hands out tab stream ids, relays SDP/ICE, keeps state |
| `offscreen.html/js` | Owns both `tabCapture` streams, replays them so the tabs stay audible, one loopback `RTCPeerConnection` per connected page frame |
| `page-inject.js` | MAIN world: replaces `navigator.mediaDevices.getUserMedia` with a WebAudio mix of *real mic + other meeting* |
| `content-relay.js` | ISOLATED world: `window.postMessage` ⇄ `chrome.runtime` courier (the MAIN world has no `chrome.*`) |
| `popup.html/js` | Assign tabs, start/stop, mix levels |

The mix destination node is created once and never replaced, so the page holds a stable
audio track — you can start and stop the bridge mid-meeting without the meeting app
losing its microphone.

## Install (developer mode)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select `C:\Project\ext`.
3. **Reload any Meet/Teams tabs that were already open** — the microphone patch only
   applies to pages loaded after the extension.

## Use

1. Open the Google Meet meeting. Click the extension icon **on that tab** → **Assign this
   tab** under *Side A*.
2. Switch to the Microsoft Teams meeting tab. Click the icon there → **Assign this tab**
   under *Side B*.
3. Click **Start bridge**.
4. In each meeting, unmute. If the app asks which microphone to use, any choice works —
   the extension intercepts the call regardless of the device selected.

Assigning has to happen from the tab itself: clicking the extension icon is what grants
`activeTab` for that tab, which is what `chrome.tabCapture` requires. Reloading or
navigating a bridged tab revokes it — re-assign and start again.

### Mix controls

- **Also send my real microphone** — on by default, so you are heard in both meetings.
  Turn it off to make the bridge a pure relay between the two rooms.
- **My mic / Bridged** sliders — level of each source in the outgoing mix (0–200%).

If the real microphone is denied or missing, the bridge audio alone still goes out.

## Notes and limits

- **Wear headphones.** On open speakers your real mic picks up both meetings and feeds
  them back in, on top of the bridged copy.
- **Browser tabs only** — `meet.google.com`, `teams.microsoft.com`, `teams.live.com`,
  `teams.cloud.microsoft`, `zoom.us`, `zoom.com`. The Teams and Zoom *desktop apps* are
  not browser tabs and cannot be bridged; for those you need an OS-level virtual audio
  device (VB-Cable, VoiceMeeter). To add another site, add its host pattern to both
  `host_permissions` and *both* `content_scripts[].matches` in `manifest.json`, then
  reload the extension and the tab.
- **Zoom needs the web client.** A Zoom invite link launches the desktop app by default.
  On the launch page choose **Join from your browser** so the meeting runs at a
  `.../wc/<id>/join` URL. Also click **Join Audio by Computer** — Zoom does not request a
  microphone until you do, so there is nothing to intercept before that.
- Only audio is bridged. Video, screen share, and chat are untouched.
- Latency is roughly one WebRTC hop over loopback — tens of milliseconds.
- The bridge stops automatically if either assigned tab is closed.
- Every participant in both meetings is being relayed to the other meeting. Say so before
  you start it; in most places recording or relaying a call without telling people is a
  legal problem, not just an etiquette one.

## Troubleshooting

Open DevTools on a meeting tab and filter the console for `[CORS-MV]` — the page
script logs when it creates the graph, when it serves a virtual mic track, and when the
other meeting's audio starts feeding it. For the capture side, use the offscreen document's
console via `chrome://extensions` → *Inspect views: offscreen.html*.

| Symptom | Cause |
| --- | --- |
| `Cannot capture side A…` | `activeTab` was lost (tab reloaded). Re-assign that tab. |
| Meeting still uses the real mic | Tab was loaded before the extension. Reload it. |
| No `[CORS-MV]` logs at all | URL is outside `matches` in `manifest.json` — add it there. |
| Zoom unaffected by the bridge | Meeting opened in the desktop app, not the web client. |
| Bridge starts but is silent | The far side is muted, or *Bridged* level is at 0%. |
