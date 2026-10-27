// Turns a clean camera frame into a disposable-film print.
// Runs once at capture, so the clean original never leaves the phone.

const MAX_SIDE = 1600;

// Tone curve with exposure baked in: soft highlight shoulder, lifted blacks,
// cool shadows and warm highlights like cheap consumer film.
function buildLuts(gain) {
  const r = new Uint8ClampedArray(256);
  const g = new Uint8ClampedArray(256);
  const b = new Uint8ClampedArray(256);
  const k = 0.9;
  const norm = 1 - Math.exp(-k);
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * gain;
    const sh = (1 - Math.exp(-x * k)) / norm;
    const s = Math.min(1, sh);
    const sc = s < 0.5 ? 2 * s * s : 1 - 2 * (1 - s) * (1 - s);
    const y = s * 0.5 + sc * 0.5;
    r[i] = 13 + y * 236 + (y - 0.5) * 14;
    g[i] = 12 + y * 234 + (1 - y) * 5;
    b[i] = 22 + y * 214 - (y - 0.5) * 10;
  }
  return { r, g, b };
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// Disposables run bright, so meter every frame toward a slightly high exposure.
function meter(data, flash) {
  let sum = 0, n = 0;
  for (let i = 0; i < data.length; i += 64) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    n++;
  }
  const avg = Math.max(0.04, sum / n / 255);
  return Math.min(flash ? 1.2 : 1.45, Math.max(0.85, 0.38 / avg));
}

// Clumpy grain: noise drawn at half size and smoothed up, so it reads as
// silver grain instead of digital pixel noise.
function grainField(w, h) {
  const gw = Math.ceil(w / 2), gh = Math.ceil(h / 2);
  const small = canvas(gw, gh);
  const sctx = small.getContext('2d');
  const img = sctx.createImageData(gw, gh);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 128 + (Math.random() + Math.random() + Math.random() - 1.5) * 110;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  sctx.putImageData(img, 0, 0);
  const big = canvas(w, h);
  const bctx = big.getContext('2d', { willReadFrequently: true });
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(small, 0, 0, w, h);
  return bctx.getImageData(0, 0, w, h).data;
}

export async function develop(frame, { flash = false, date = new Date() } = {}) {
  const scale = Math.min(1, MAX_SIDE / Math.max(frame.width, frame.height));
  const w = Math.round(frame.width * scale);
  const h = Math.round(frame.height * scale);

  // Downscale then upscale for the soft plastic-lens look.
  const soft = canvas(Math.round(w * 0.72), Math.round(h * 0.72));
  const sctx = soft.getContext('2d');
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(frame, 0, 0, soft.width, soft.height);

  const out = canvas(w, h);
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(soft, 0, 0, w, h);

  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const src = new Uint8ClampedArray(d);
  const LUT = buildLuts(meter(src, flash));
  const grain = grainField(w, h);
  const grainAmt = flash ? 0.06 : 0.085;
  const cx = w / 2, cy = h / 2;
  // Red and blue land slightly apart toward the edges, like a plastic lens.
  const fringe = 0.0028;

  for (let y = 0; y < h; y++) {
    const dy = (y - cy) / cy;
    const yr = Math.min(h - 1, Math.max(0, Math.round(cy + (y - cy) * (1 + fringe))));
    const yb = Math.min(h - 1, Math.max(0, Math.round(cy + (y - cy) * (1 - fringe))));
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dx = (x - cx) / cx;
      const dn = (dx * dx + dy * dy) / 2;

      const xr = Math.min(w - 1, Math.max(0, Math.round(cx + (x - cx) * (1 + fringe))));
      const xb = Math.min(w - 1, Math.max(0, Math.round(cx + (x - cx) * (1 - fringe))));

      let r = LUT.r[src[(yr * w + xr) * 4]];
      let g = LUT.g[src[i + 1]];
      let b = LUT.b[src[(yb * w + xb) * 4 + 2]];

      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      r = lum + (r - lum) * 1.06;
      g = lum + (g - lum) * 1.02;
      b = lum + (b - lum) * 1.0;

      // Corners fall off, the middle stays open.
      let k = 1.02 - 0.42 * Math.pow(dn, 1.5);
      if (flash) k *= 1.14 - 0.5 * dn;
      r *= k; g *= k; b *= k;

      // Grain shows most in the shadows and mids, least in bright areas.
      const l = lum / 255;
      const weight = 0.55 + 0.9 * Math.max(0, 1 - Math.abs(l - 0.35) * 1.6);
      const n = (grain[i] - 128) * grainAmt * weight;
      d[i] = r + n;
      d[i + 1] = g + n;
      d[i + 2] = b + n * 1.1;
    }
  }
  ctx.putImageData(img, 0, 0);

  halation(ctx, out, w, h);
  if (Math.random() < 0.35) lightLeak(ctx, w, h);
  dateStamp(ctx, w, h, date);

  return new Promise((resolve) => out.toBlob(resolve, 'image/jpeg', 0.86));
}

// Red-orange bloom around bright lights. Blurred by shrinking and growing,
// which works on every browser (Safari ignores canvas blur filters).
function halation(ctx, out, w, h) {
  const tw = Math.max(8, Math.round(w / 24)), th = Math.max(8, Math.round(h / 24));
  const tiny = canvas(tw, th);
  const tctx = tiny.getContext('2d', { willReadFrequently: true });
  tctx.drawImage(out, 0, 0, tw, th);
  const img = tctx.getImageData(0, 0, tw, th);
  const d = img.data;
  let any = false;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const t = Math.max(0, (lum - 205) / 50);
    if (t > 0) any = true;
    d[i] = 255 * t;
    d[i + 1] = 70 * t;
    d[i + 2] = 20 * t;
  }
  if (!any) return;
  tctx.putImageData(img, 0, 0);
  const mid = canvas(Math.round(w / 6), Math.round(h / 6));
  const mctx = mid.getContext('2d');
  mctx.imageSmoothingQuality = 'high';
  mctx.drawImage(tiny, 0, 0, mid.width, mid.height);
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = 0.55;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(mid, 0, 0, w, h);
  ctx.restore();
}

function lightLeak(ctx, w, h) {
  const left = Math.random() < 0.5;
  const x = left ? -w * 0.12 : w * 1.12;
  const y = h * (0.15 + Math.random() * 0.7);
  const rad = Math.max(w, h) * (0.4 + Math.random() * 0.2);
  const grad = ctx.createRadialGradient(x, y, 0, x, y, rad);
  grad.addColorStop(0, 'rgba(255, 80, 25, 0.6)');
  grad.addColorStop(0.4, 'rgba(255, 150, 50, 0.25)');
  grad.addColorStop(1, 'rgba(255, 170, 60, 0)');
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

function dateStamp(ctx, w, h, date) {
  const yy = String(date.getFullYear()).slice(2);
  const mm = String(date.getMonth() + 1).padStart(2, ' ');
  const dd = String(date.getDate()).padStart(2, ' ');
  const text = `'${yy} ${mm} ${dd}`;
  const short = Math.min(w, h);
  const size = Math.round(short * 0.045);
  ctx.save();
  ctx.font = `bold ${size}px "Courier New", ui-monospace, monospace`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(255, 150, 60, 0.92)';
  ctx.shadowColor = 'rgba(255, 80, 0, 0.9)';
  ctx.shadowBlur = size * 0.35;
  ctx.fillText(text, w - short * 0.07, h - short * 0.07);
  ctx.restore();
}
