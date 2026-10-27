import { develop } from './film.js';
import * as queue from './queue.js';
import * as sound from './sound.js';

const EXPOSURES = 27;
const WIND_DISTANCE = 170;
// Set in step 2 when the backend exists. Until then frames wait in the queue.
const UPLOAD_URL = null;

const params = new URLSearchParams(location.search);
const eventId = (params.get('e') || 'demo').replace(/[^a-z0-9-]/gi, '').slice(0, 40) || 'demo';
const dev = params.has('dev');

const store = {
  get(k, fallback) {
    try {
      const v = localStorage.getItem(`roll:${eventId}:${k}`);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(k, v) {
    try { localStorage.setItem(`roll:${eventId}:${k}`, JSON.stringify(v)); } catch {}
  },
};

const $ = (id) => document.getElementById(id);
const screens = { load: $('load'), camera: $('camera'), done: $('done') };
const video = $('video');
const shutterBtn = $('shutter');
const flashBtn = $('flash');
const wind = $('wind');
const wheel = $('wheel');

let name = store.get('name', '');
let shotsLeft = store.get('left', EXPOSURES);
let wound = store.get('wound', true);
let facing = 'environment';
let flashOn = false;
let stream = null;
let busy = false;

function show(which) {
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== which;
}

function render() {
  $('count').textContent = shotsLeft;
  shutterBtn.disabled = !wound || shotsLeft <= 0;
  wind.classList.toggle('ready', wound);
  wind.setAttribute('aria-valuenow', wound ? 100 : 0);
  $('wind-hint').textContent = 'Drag to wind';
}

async function updateStatus() {
  const pending = (await queue.all()).length;
  let text = '';
  if (pending) text = `${pending} ${pending === 1 ? 'frame' : 'frames'} waiting to send`;
  $('status').textContent = text;
  $('done-status').textContent = text ? `${text}. Keep this page open on wifi or signal.` : '';
}

async function upload(item) {
  if (!UPLOAD_URL) throw new Error('No backend yet');
  const form = new FormData();
  form.append('event', item.eventId);
  form.append('name', item.name);
  form.append('taken_at', item.takenAt);
  form.append('id', item.id);
  form.append('photo', item.blob, `${item.id}.jpg`);
  const res = await fetch(UPLOAD_URL, { method: 'POST', body: form });
  if (!res.ok && res.status !== 409) throw new Error(`Upload failed ${res.status}`);
}

async function sendQueued() {
  await queue.flush(upload);
  updateStatus();
}

// Camera

async function startCamera() {
  stopCamera();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1440 } },
  });
  video.srcObject = stream;
  video.classList.toggle('mirror', facing === 'user');
  await video.play().catch(() => {});
}

function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

function torchTrack() {
  const track = stream?.getVideoTracks()[0];
  const caps = track?.getCapabilities?.() || {};
  return caps.torch ? track : null;
}

// How the phone is physically held, from gravity: 0 upright, 90 turned
// counterclockwise, -90 clockwise, 180 upside down. Lets a sideways shot come
// out sideways even when rotation lock keeps the page upright.
let deviceAngle = 0;
const isIOS = typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function';

function onMotion(e) {
  const g = e.accelerationIncludingGravity;
  if (!g || g.x === null) return;
  // iOS reports gravity with the opposite sign of the spec (and of Android).
  const x = isIOS ? -g.x : g.x;
  const y = isIOS ? -g.y : g.y;
  // Lying flat or mid-swing: keep the last reading.
  if (Math.max(Math.abs(x), Math.abs(y)) < 5) return;
  if (Math.abs(y) >= Math.abs(x) * 1.3) deviceAngle = y > 0 ? 0 : 180;
  else if (Math.abs(x) >= Math.abs(y) * 1.3) deviceAngle = x > 0 ? 90 : -90;
}

async function watchMotion() {
  try {
    if (isIOS && (await DeviceMotionEvent.requestPermission()) !== 'granted') return;
    window.addEventListener('devicemotion', onMotion);
  } catch {}
}

function screenAngle() {
  if (typeof window.orientation === 'number') return window.orientation;
  const a = screen.orientation?.angle || 0;
  return a > 180 ? a - 360 : a;
}

// Crop the live frame to the same window the viewfinder shows (2:3 upright,
// 3:2 when the page is sideways), then turn it if the phone is held sideways
// while the page is not.
function grabFrame() {
  const vw = video.videoWidth, vh = video.videoHeight;
  const portrait = window.innerHeight >= window.innerWidth;
  const target = portrait ? 2 / 3 : 3 / 2;
  let sw = vw, sh = vh;
  if (vw / vh > target) sw = Math.round(vh * target);
  else sh = Math.round(vw / target);

  let turn = (deviceAngle - screenAngle()) % 360;
  if (turn > 180) turn -= 360;
  if (turn <= -180) turn += 360;
  const sideways = Math.abs(turn) === 90;

  const c = document.createElement('canvas');
  c.width = sideways ? sh : sw;
  c.height = sideways ? sw : sh;
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((-turn * Math.PI) / 180);
  if (facing === 'user' && sideways) ctx.scale(-1, -1);
  ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, -sw / 2, -sh / 2, sw, sh);
  return c;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot() {
  if (busy || !wound || shotsLeft <= 0 || !video.videoWidth) return;
  busy = true;
  wound = false;
  store.set('wound', false);

  let frame;
  if (flashOn) {
    const torch = torchTrack();
    $('white').classList.add('on');
    if (torch) await torch.applyConstraints({ advanced: [{ torch: true }] }).catch(() => {});
    await wait(torch ? 220 : 120);
    frame = grabFrame();
    if (torch) torch.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {});
    $('white').classList.remove('on');
  } else {
    frame = grabFrame();
  }

  sound.shutter();
  navigator.vibrate?.(25);
  const blink = $('blink');
  blink.classList.remove('on');
  void blink.offsetWidth;
  blink.classList.add('on');

  shotsLeft -= 1;
  store.set('left', shotsLeft);
  render();

  const blob = await develop(frame, { flash: flashOn });
  const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await queue.enqueue({ id, eventId, name, takenAt: Date.now(), blob });
  if (dev) showDevThumb(blob);
  busy = false;
  sendQueued();

  if (shotsLeft <= 0) setTimeout(finish, 900);
}

function finish() {
  stopCamera();
  show('done');
  updateStatus();
}

// Wind wheel: drag either way, ticks as it turns, locks when the next frame is ready.

let windStart = null;
let windTravel = 0;
let wheelPos = 0;
let lastTick = 0;

wind.addEventListener('pointerdown', (e) => {
  if (wound) return;
  windStart = e.clientX;
  wind.setPointerCapture(e.pointerId);
});

wind.addEventListener('pointermove', (e) => {
  if (windStart === null || wound) return;
  const dx = e.clientX - windStart;
  windStart = e.clientX;
  windTravel += Math.abs(dx);
  wheelPos += dx;
  wheel.style.backgroundPositionX = `${wheelPos}px`;
  if (windTravel - lastTick > 14) {
    lastTick = windTravel;
    sound.tick();
  }
  wind.setAttribute('aria-valuenow', Math.min(100, Math.round((windTravel / WIND_DISTANCE) * 100)));
  if (windTravel >= WIND_DISTANCE) wound_();
});

const endWind = () => { windStart = null; };
wind.addEventListener('pointerup', endWind);
wind.addEventListener('pointercancel', endWind);

wind.addEventListener('keydown', (e) => {
  if (!wound && (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === ' ')) {
    e.preventDefault();
    wound_();
  }
});

function wound_() {
  wound = true;
  windStart = null;
  windTravel = 0;
  lastTick = 0;
  store.set('wound', true);
  sound.clunk();
  navigator.vibrate?.(12);
  render();
}

// Buttons

shutterBtn.addEventListener('click', shoot);

flashBtn.addEventListener('click', () => {
  flashOn = !flashOn;
  flashBtn.setAttribute('aria-pressed', flashOn);
  flashBtn.textContent = flashOn ? 'Flash on' : 'Flash off';
  sound.tick();
});

$('flip').addEventListener('click', async () => {
  facing = facing === 'environment' ? 'user' : 'environment';
  try { await startCamera(); } catch {}
});

$('load-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  name = $('name').value.trim().slice(0, 30);
  if (!name) return;
  store.set('name', name);
  sound.unlock();
  await watchMotion();
  await openCamera();
});

async function openCamera() {
  const err = $('load-error');
  err.hidden = true;
  if (!navigator.mediaDevices?.getUserMedia) {
    err.textContent = 'This browser cannot open the camera. Try Safari on iPhone or Chrome on Android.';
    err.hidden = false;
    return;
  }
  try {
    await startCamera();
    show('camera');
    render();
    updateStatus();
  } catch (ex) {
    err.textContent = ex.name === 'NotAllowedError'
      ? 'Camera access was blocked. Allow it in your browser settings, then reload this page.'
      : 'Could not open the camera. Close other apps using it and try again.';
    err.hidden = false;
    show('load');
  }
}

// iPhone kills the camera when the tab is hidden, so restart it on return.
document.addEventListener('visibilitychange', () => {
  if (screens.camera.hidden) return;
  if (document.hidden) stopCamera();
  else startCamera().catch(() => {});
});

window.addEventListener('online', sendQueued);

function showDevThumb(blob) {
  const btn = $('dev-thumb');
  const url = URL.createObjectURL(blob);
  btn.style.backgroundImage = `url(${url})`;
  btn.hidden = false;
  btn.onclick = () => btn.classList.toggle('big');
}

// Start

if (shotsLeft <= 0) {
  show('done');
  updateStatus();
  sendQueued();
} else {
  if (name) $('name').value = name;
  show('load');
  sendQueued();
}
