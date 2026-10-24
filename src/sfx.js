// Tiny synthesized sound effects (no audio files). Browsers only allow sound
// after the page has been interacted with, so early sounds may be silent.

let ctx = null;
function audio() {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function noiseBurst(c, t, { length, freq, q, type = 'bandpass', gain }) {
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * length), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 2;
  const src = c.createBufferSource();
  src.buffer = buf;
  const filter = c.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + length);
  src.connect(filter).connect(g).connect(c.destination);
  src.start(t);
}

function tone(c, t, { from, to, length, gain, type = 'sine' }) {
  const osc = c.createOscillator();
  osc.type = type;
  const g = c.createGain();
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.exponentialRampToValueAtTime(to, t + length);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + length);
  osc.connect(g).connect(c.destination);
  osc.start(t);
  osc.stop(t + length + 0.02);
}

// Crunchy bite.
export function chomp() {
  const c = audio();
  if (!c) return;
  const t = c.currentTime;
  noiseBurst(c, t, { length: 0.18, freq: 1800, q: 0.8, gain: 0.7 });
  tone(c, t, { from: 140, to: 60, length: 0.14, gain: 0.5 });
}

// Wet slime landing; louder for harder hits.
export function splat(strength = 1) {
  const c = audio();
  if (!c) return;
  const t = c.currentTime;
  const k = Math.min(1, strength / 3);
  noiseBurst(c, t, { length: 0.25, freq: 500, q: 1.5, type: 'lowpass', gain: 0.3 + k * 0.5 });
  tone(c, t, { from: 220, to: 70, length: 0.2, gain: 0.25 + k * 0.3, type: 'triangle' });
}

// Soft "pop" when something new appears.
export function pop() {
  const c = audio();
  if (!c) return;
  tone(c, c.currentTime, { from: 500, to: 900, length: 0.08, gain: 0.15 });
}
