'use strict';
// A direct link to the Remote page (WebRTC data channel), beside its socket: the page offers it
// over the socket it has already signed in on, and once it opens, the capture core's frames and
// answers go to the page, and its requests come back, the short way between the two devices
// rather than through the tunnel. The socket stays for the session itself (sign-in, its checks,
// the end), and carries everything again if the direct link does not open or closes.
//
// Messages are cut into pieces a browser takes in one data-channel message (Safari's is 64 KiB):
// each piece is [flags:1][bytes], flags bit 0 "more follows", bit 1 "JSON" (else a video frame).

const CHUNK = 60 * 1024;
const MAX_IN = 1024 * 1024 + 64 * 1024;
// Public STUN only (no relay): each side learns the address the internet sees it at.
const ICE = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'];

let lib;
function load() {
  if (lib === undefined) { try { lib = require('node-datachannel'); } catch { lib = null; } }
  return lib;
}

const MORE = 1, JSON_KIND = 2;
function pieces(kind, buf) {
  const out = [];
  for (let at = 0; at < buf.length || at === 0; at += CHUNK) {
    const end = Math.min(buf.length, at + CHUNK);
    const head = Buffer.from([(end < buf.length ? MORE : 0) | (kind === 1 ? JSON_KIND : 0)]);
    out.push(Buffer.concat([head, buf.subarray(at, end)]));
    if (buf.length === 0) break;
  }
  return out;
}

// sendSignal(msg): to the page over its socket. onMessage(buf): a whole JSON message from the
// page. onOpen() / onClose(): the link opened, or went (the socket carries everything again).
function createDirect({ sendSignal, onMessage, onOpen, onClose }) {
  const d = load();
  if (!d) return null;
  let pc;
  try { pc = new d.PeerConnection('castpane', { iceServers: ICE, maxMessageSize: 256 * 1024 }); } catch { return null; }
  let dc = null, open = false, done = false, inParts = [], inLength = 0;
  pc.onLocalDescription((sdp, type) => { if (!done) sendSignal({ t: 'rtc-answer', sdp, type }); });
  pc.onLocalCandidate((candidate, mid) => { if (!done) sendSignal({ t: 'rtc-candidate', candidate, mid }); });
  pc.onDataChannel((ch) => {
    // One channel, the page's own; any other is refused.
    if (dc || ch.getLabel() !== 'castpane') { try { ch.close(); } catch { /* gone */ } return; }
    dc = ch;
    const opened = () => { if (open || done) return; open = true; onOpen(); };
    ch.onOpen(opened);
    if (ch.isOpen()) opened();
    ch.onClosed(() => end());
    ch.onError(() => end());
    ch.onMessage((m) => {
      if (done || typeof m === 'string') return end();
      const flags = m[0];
      if (!(flags & JSON_KIND)) return end();
      inParts.push(m.subarray(1)); inLength += m.length - 1;
      if (inLength > MAX_IN) return end();
      if (flags & MORE) return;
      const whole = inParts.length === 1 ? inParts[0] : Buffer.concat(inParts, inLength);
      inParts = []; inLength = 0;
      onMessage(whole);
    });
  });
  function end() {
    if (done) return;
    done = true;
    const was = open; open = false;
    try { dc?.close(); } catch { /* gone */ }
    try { pc.close(); } catch { /* gone */ }
    if (was) onClose();
  }
  return {
    get open() { return open; },
    // The page's offer and its candidates, checked by the caller for size and type.
    offer(sdp) { try { pc.setRemoteDescription(sdp, 'offer'); } catch { end(); } },
    candidate(candidate, mid) { try { pc.addRemoteCandidate(candidate, mid); } catch { /* not one it takes */ } },
    buffered() { try { return dc ? dc.bufferedAmount() : 0; } catch { return 0; } },
    // kind 1: a JSON message (string); kind 2: a video frame (Buffer).
    send(kind, data) {
      if (!open) return false;
      const buf = typeof data === 'string' ? Buffer.from(data) : data;
      try { for (const p of pieces(kind, buf)) dc.sendMessageBinary(p); return true; } catch { end(); return false; }
    },
    close: end,
  };
}

module.exports = { createDirect, pieces, available: () => !!load() };
