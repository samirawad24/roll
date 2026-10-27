// Synthesized camera sounds, so there are no audio files to load at a party.

let ctx = null;

export function unlock() {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch {
    ctx = null;
  }
}

function noise(duration, { freq = 2000, q = 1, gain = 0.4, delay = 0 } = {}) {
  if (!ctx) return;
  const len = Math.floor(ctx.sampleRate * duration);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  filter.Q.value = q;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(filter).connect(g).connect(ctx.destination);
  src.start(ctx.currentTime + delay);
}

export function shutter() {
  noise(0.025, { freq: 3500, q: 0.8, gain: 0.9 });
  noise(0.06, { freq: 1200, q: 1.2, gain: 0.6, delay: 0.045 });
}

export function tick() {
  noise(0.012, { freq: 4200, q: 3, gain: 0.35 });
}

export function clunk() {
  noise(0.05, { freq: 700, q: 2, gain: 0.8 });
}
