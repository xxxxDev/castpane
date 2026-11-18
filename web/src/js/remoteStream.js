// The Remote page's link (server/remote.js): one socket that brings the capture core's
// H.264 or HEVC frames and answers, and takes the page's requests, clicks and keys. Frames are
// decoded by the browser's own (hardware) decoder and drawn on a canvas; each one shown
// is acknowledged, and the capture core skips frames while three are unshown, so the picture
// stays current instead of falling behind (as Sill does).
export function remoteSupported() {
  return typeof window !== 'undefined' && 'VideoDecoder' in window && 'EncodedVideoChunk' in window;
}

// Whether this browser decodes HEVC in hardware: the Mac then sends it, sharper for the
// same bits. Asked once; a browser that cannot say is taken as no.
let hevcAnswer = null;
export function hevcDecodes() {
  if (!hevcAnswer) {
    hevcAnswer = remoteSupported() && typeof VideoDecoder.isConfigSupported === 'function'
      ? VideoDecoder.isConfigSupported({ codec: 'hvc1.1.6.L153.B0', optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' }).then((r) => !!r.supported, () => false)
      : Promise.resolve(false);
  }
  return hevcAnswer;
}

// machine: another Mac that joined this one (docs/multi-mac.md), or empty for this Mac.
// onCodecFailed: an HEVC stream this browser would not decode after all; ask for H.264.
// direct: 'both', 'cloudflare' or 'off' (js/remotePrefs.js).
export function openRemote({ pass, machine = '', canvas, direct: directPref = 'both', onMessage = () => {}, onState = () => {}, onStats = () => {}, onLink = () => {}, onCodecFailed = () => {} }) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/remote?pass=${encodeURIComponent(pass)}${machine ? `&machine=${encodeURIComponent(machine)}` : ''}`);
  ws.binaryType = 'arraybuffer';
  let decoder = null, config = null, needKey = true, closed = false, opened = false, shown = false;
  let frames = 0, bytes = 0, statsAt = performance.now();
  // How long each frame takes from the decoder to the canvas, and how many wait: what the
  // page's automatic size reads to tell a device that cannot keep up.
  const sentAt = new Map();let lagSum = 0, lagCount = 0, queueMax = 0;
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  // The direct link (server/directLink.js): offered once the Mac has answered; while it is open
  // everything goes and comes that way, and the socket only keeps the session.
  // Input goes the new way only once the server has had all it was sent the old way (an echo by
  // the socket comes back after them): a mouse-up never overtakes its mouse-down.
  let pc = null, dc = null, direct = false, inParts = [], inLength = 0, inputDirect = false, held = null;
  const sendSocket = (msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
  const send = (msg) => {
    if (held) { held.push(msg);return; }
    if (inputDirect && dc?.readyState === 'open') {
      const data = new TextEncoder().encode(JSON.stringify(msg)), CHUNK = 60 * 1024;
      try {
        for (let at = 0; at < data.length || at === 0; at += CHUNK) {
          const end = Math.min(data.length, at + CHUNK), piece = new Uint8Array(1 + end - at);
          piece[0] = (end < data.length ? 1 : 0) | 2;piece.set(data.subarray(at, end), 1);dc.send(piece);
          if (!data.length) break;
        }
        return;
      } catch { /* closing: the socket below */ }
    }
    sendSocket(msg);
  };
  // The time a message takes there and back, by whichever way is in use.
  let echoN = 0, echoAt = 0, rtt = 0;
  // A link that went quiet (a phone changing networks) is let go after a few seconds without an
  // answer, and the socket takes over, rather than a frozen picture until the browser notices.
  let echoAnswered = 0;
  const echoTimer = setInterval(() => {
    if (closed) return clearInterval(echoTimer);
    if (inputDirect && echoN > echoAnswered + 2) { try { dc.close(); } catch {} }
    echoAt = performance.now();send({ t: 'echo', n: ++echoN });
  }, 2000);
  function offerDirect() {
    if (typeof RTCPeerConnection === 'undefined' || directPref === 'off') return;
    try {
      const stun = directPref === 'cloudflare' ? ['stun:stun.cloudflare.com:3478'] : ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'];
      pc = new RTCPeerConnection({ iceServers: [{ urls: stun }] });
      dc = pc.createDataChannel('castpane', { ordered: true });
      dc.binaryType = 'arraybuffer';
      dc.onopen = () => { direct = true;needKey = true;onLink({ rtt, direct }); };
      dc.onclose = () => {
        if (!direct) return;
        direct = false;inputDirect = false;needKey = true;onLink({ rtt, direct });
        if (held) { const q = held;held = null;for (const m of q) sendSocket(m); }
        // The Mac told by the socket, so its frames come that way at once.
        sendSocket({ t: 'rtc-close' });
        sendSocket({ t: 'key-frame' });
        // What was pressed may have been lost with the link: the page lets go of it again.
        onState('direct-lost');
        // Its candidates no longer taken (a member could name any address to be tried).
        try { pc.close(); } catch {}
      };
      dc.onmessage = (e) => {
        const m = new Uint8Array(e.data), flags = m[0];
        // As the server takes them: a piece that says more follows is a whole one, and a message
        // is at most 8 MiB (a frame through the hub is no larger).
        if (((flags & 1) && m.length < 1 + 60 * 1024) || inLength + m.length > 8 * 1024 * 1024) { inParts = [];inLength = 0;try { dc.close(); } catch {} return; }
        inParts.push(m.subarray(1));inLength += m.length - 1;
        if (flags & 1) return;
        let whole = inParts[0];
        if (inParts.length > 1) { whole = new Uint8Array(inLength);let o = 0;for (const p of inParts) { whole.set(p, o);o += p.length; } }
        inParts = [];inLength = 0;
        if (!inputDirect && !held) {
          held = [];sendSocket({ t: 'echo', n: 0 });
          // Its answer lost (the Mac too busy, or one that never answers): the link is let go.
          setTimeout(() => { if (held && !inputDirect) { try { dc.close(); } catch {} } }, 5000);
        }
        // Another Mac's link brings only its video and echoes: its other messages come by the
        // hub, which checks them (server/members.js).
        if (flags & 2) {
          const s = new TextDecoder().decode(whole);
          if (!machine) text(s);
          else {
            // Taken apart once, only an echo with its number kept (a key given twice is no way in).
            let o = null;try { o = JSON.parse(s); } catch {}
            if (o && o.t === 'echo' && Number.isSafeInteger(o.n)) text(JSON.stringify({ t: 'echo', n: o.n }));
          }
        }
        else video(whole.byteOffset || whole.byteLength !== whole.buffer.byteLength ? whole.slice().buffer : whole.buffer);
      };
      pc.oniceconnectionstatechange = () => { if (direct && (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed')) { try { dc.close(); } catch {} } };
      pc.onicecandidate = (e) => { if (e.candidate?.candidate) sendSocket({ t: 'rtc-candidate', candidate: e.candidate.candidate, mid: e.candidate.sdpMid || '0' }); };
      pc.createOffer().then((o) => pc.setLocalDescription(o)).then(() => sendSocket({ t: 'rtc-offer', sdp: pc.localDescription.sdp, stun: directPref === 'cloudflare' ? 'cloudflare' : 'both' })).catch(() => {});
    } catch { pc = null; }
  }

  function makeDecoder() {
    try { decoder?.close(); } catch {}
    decoder = new VideoDecoder({
      output(frame) {
        const ts = frame.timestamp;
        try {
          if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) { canvas.width = frame.displayWidth; canvas.height = frame.displayHeight; }
          ctx.drawImage(frame, 0, 0);
        } finally { frame.close(); }
        const at = sentAt.get(ts);
        if (at !== undefined) { sentAt.delete(ts);lagSum += performance.now() - at;lagCount++; }
        frames++;shown = true;
        send({ t: 'ack' });
      },
      error() {
        // HEVC that fails before its first picture: this browser cannot decode it.
        if (hevc() && !shown) { codecFailed();return; }
        needKey = true; send({ t: 'key-frame' }); if (config) { try { makeDecoder(); } catch {} }
      },
    });
    shown = false;
    needKey = true;
    if (!config) return;
    try { decoder.configure({ codec: config.codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' }); }
    catch (e) { if (hevc()) codecFailed();else throw e; }
  }
  const hevc = () => !!config?.codec?.startsWith('hvc1');
  function codecFailed() { const was = config;config = null;try { decoder?.close(); } catch {} decoder = null;if (was) onCodecFailed(); }

  ws.onopen = () => { opened = true; onState('open'); };
  ws.onclose = () => { closed = true; try { decoder?.close(); } catch {} try { pc?.close(); } catch {} onState(opened ? 'closed' : 'refused'); };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') return text(e.data);
    // A frame still coming by the socket once the direct link is open: let go (counted shown).
    if (direct) { send({ t: 'ack' });return; }
    video(e.data);
  };
  let offered = false;
  function text(s) {
    let msg; try { msg = JSON.parse(s); } catch { return; }
    // Offered once the Mac's first word is here: before, the server is still reaching it (another
    // Mac's through this one takes a while), and an offer then went nowhere.
    if (!offered) { offered = true;offerDirect(); }
    if (msg.t === 'rtc-answer') { pc?.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch(() => {});return; }
    if (msg.t === 'rtc-candidate') { pc?.addIceCandidate({ candidate: msg.candidate, sdpMid: msg.mid }).catch(() => {});return; }
    if (msg.t === 'rtc-none') return;
    if (msg.t === 'echo') {
      if (msg.n === 0) { if (held) { const q = held;held = null;inputDirect = direct;echoAnswered = echoN;for (const m of q) send(m); } return; }
      if (Number.isSafeInteger(msg.n) && msg.n > echoAnswered) echoAnswered = msg.n;
      if (msg.n === echoN) { rtt = Math.round(performance.now() - echoAt);onLink({ rtt, direct }); }
      return;
    }
    if (msg.t === 'config') { config = msg; makeDecoder(); }
    onMessage(msg);
  }
  let keyAskedAt = -Infinity;
  const askKey = () => { const now = performance.now(); if (now - keyAskedAt < 1000) return; keyAskedAt = now; send({ t: 'key-frame' }); };
  function video(buffer) {
    const data = new Uint8Array(buffer);
    if (!decoder || decoder.state !== 'configured' || data.length < 10) { send({ t: 'ack' }); return; }
    const key = (data[0] & 1) === 1;
    // Waiting for a key frame: one is asked for, not left to the encoder's own interval. By the
    // direct link a key frame can come before the config that goes the hub's way, and then be
    // dropped, the picture stuck until the next one.
    if (needKey && !key) { send({ t: 'ack' }); askKey(); return; }
    needKey = false;
    const view = new DataView(buffer);
    const timestamp = Number(view.getBigUint64(1));
    bytes += data.length;
    if (sentAt.size > 30) sentAt.clear();
    sentAt.set(timestamp, performance.now());
    try { decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp, data: data.subarray(9) }));queueMax = Math.max(queueMax, decoder.decodeQueueSize || 0); }
    catch { needKey = true; send({ t: 'ack' }); send({ t: 'key-frame' }); }
    const now = performance.now();
    if (now - statsAt >= 1000) {
      onStats({ fps: Math.round(frames * 1000 / (now - statsAt)), mbps: +(bytes * 8 / 1e6 / ((now - statsAt) / 1000)).toFixed(1), lag: lagCount ? Math.round(lagSum / lagCount) : 0, queue: queueMax, width: canvas.width, rtt, direct });
      frames = 0; bytes = 0; statsAt = now; lagSum = 0; lagCount = 0; queueMax = 0;
    }
  }
  return {
    send,
    get closed() { return closed; },
    close() { closed = true; clearInterval(echoTimer); try { pc?.close(); } catch {} try { ws.close(); } catch {} try { decoder?.close(); } catch {} },
  };
}

// Where a point on the canvas element falls in the picture, 0…1 each way: the canvas
// is drawn with object-fit: contain, so there may be bars on two sides.
export function pictureRect(canvas) {
  const box = canvas.getBoundingClientRect();
  const vw = canvas.width || 1, vh = canvas.height || 1;
  const scale = Math.min(box.width / vw, box.height / vh);
  const w = vw * scale, h = vh * scale;
  return { left: box.left + (box.width - w) / 2, top: box.top + (box.height - h) / 2, width: w, height: h };
}
export function toPicture(canvas, clientX, clientY) {
  const r = pictureRect(canvas);
  return { x: Math.min(1, Math.max(0, (clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (clientY - r.top) / r.height)), inside: clientX >= r.left && clientX <= r.left + r.width && clientY >= r.top && clientY <= r.top + r.height };
}

// A typed character, for a shortcut held with the keys row's modifiers (⌘ C).
export function codeOfChar(ch) {
  const c = String(ch || '').toLowerCase();
  if (/^[a-z]$/.test(c)) return 'Key' + c.toUpperCase();
  if (/^[0-9]$/.test(c)) return 'Digit' + c;
  return { ' ': 'Space', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', '`': 'Backquote' }[c] || null;
}

// A Windows or Linux keyboard's habits, as the Mac's own keys: Ctrl is otherwise simply ⌘, and
// Ctrl+← would go to the line's start, not a word back.
export function otherKeyboardKey({ code, ctrl, alt, shift, win }) {
  if (win) return null;
  const s = shift ? ['shift'] : [], arrow = /^Arrow(Left|Right)$/.test(code);
  if (!ctrl && !alt && code === 'Home') return { code: 'ArrowLeft', mods: [...s, 'meta'] };
  if (!ctrl && !alt && code === 'End') return { code: 'ArrowRight', mods: [...s, 'meta'] };
  if (alt && !ctrl && code === 'F4') return { code: 'KeyQ', mods: ['meta'] };
  if (alt && !ctrl && code === 'Tab') return { code: 'Tab', mods: [...s, 'meta'] };
  if (!ctrl || alt) return null;
  if (code === 'Home') return { code: 'ArrowUp', mods: [...s, 'meta'] };
  if (code === 'End') return { code: 'ArrowDown', mods: [...s, 'meta'] };
  if (arrow) return { code, mods: [...s, 'alt'] };
  if (code === 'Backspace' || code === 'Delete') return { code, mods: ['alt'] };
  if (code === 'KeyY' && !shift) return { code: 'KeyZ', mods: ['shift', 'meta'] };
  if (code === 'Tab') return { code: 'Tab', mods: [...s, 'ctrl'] };
  if (code === 'F4') return { code: 'KeyW', mods: ['meta'] };
  return null;
}

// For a 1920 × 1080 picture: the Mac gives a larger one more (Session.scaledBitrate).
export const QUALITY = { low: 2_000_000, standard: 6_000_000, high: 12_000_000, max: 25_000_000 };
export const RESOLUTION = { '1280': 1280, '1920': 1920, '2560': 2560, native: 3840 };
export const STEPS = ['1280', '1920', '2560', 'native'], QSTEPS = ['low', 'standard', 'high'];

// One second's figures (fps, lag: ms from the decoder to the canvas, queue: frames waiting)
// for the automatic size and quality. Three seconds behind: a step down, size first, never
// below 1280 and low. Long enough without: a step up, quality back first, never past the
// device's top or where it started. Each step down doubles the wait before the next step
// up, so it does not swing back and forth. Returns 'down', 'up' or null; auto is changed.
// res, q: whether each is left to automatic.
export function autoStep(auto, s, { res, q, top, start }) {
  if (!res && !q) return null;
  if (auto.cool > 0) { auto.cool--;return null; }
  const behind = s.fps > 0 && (s.queue >= 3 || s.lag > Math.max(50, 1500 / Math.max(s.fps, 1)));
  if (behind) { auto.bad++;auto.good = 0; } else if (s.fps > 0) { auto.bad = 0;auto.good++; }
  const r = STEPS.indexOf(auto.res), k = QSTEPS.indexOf(auto.q);
  if (auto.bad >= 3) {
    auto.bad = 0;
    if (res && r > 0) auto.res = STEPS[r - 1];
    else if (q && k > 0) auto.q = QSTEPS[k - 1];
    else return null;
    auto.good = 0;auto.upAfter = Math.min(auto.upAfter * 2, 240);auto.cool = 5;
    return 'down';
  }
  if (auto.good >= auto.upAfter) {
    auto.good = 0;
    if (q && k < QSTEPS.indexOf(start.q)) auto.q = QSTEPS[k + 1];
    else if (res && r < STEPS.indexOf(top) && r < STEPS.indexOf(start.res)) auto.res = STEPS[r + 1];
    else return null;
    auto.cool = 5;
    return 'up';
  }
  return null;
}
