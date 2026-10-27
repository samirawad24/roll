// Turns a clean camera frame into a disposable-film print.
// Runs once at capture, so the clean original never leaves the phone.

const MAX_SIDE = 1600;
const LUT = buildLuts();

function buildLuts() {
  const r = new Uint8ClampedArray(256);
  const g = new Uint8ClampedArray(256);
  const b = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    const s = x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x);
    const c = x * 0.55 + s * 0.45;
    // Lifted, slightly blue blacks and warm, creamy highlights.
    r[i] = 16 + c * 239;
    g[i] = 11 + c * 234;
    b[i] = 26 + c * 200;
  }
  return { r, g, b };
}

export async function develop(frame, { flash = false, date = new Date() } = {}) {
  const scale = Math.min(1, MAX_SIDE / Math.max(frame.width, frame.height));
  const w = Math.round(frame.width * scale);
  const h = Math.round(frame.height * scale);

  // Downscale then upscale for the soft plastic-lens look.
  const soft = document.createElement('canvas');
  soft.width = Math.round(w * 0.7);
  soft.height = Math.round(h * 0.7);
  const sctx = soft.getContext('2d');
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(frame, 0, 0, soft.width, soft.height);

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(soft, 0, 0, w, h);

  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const cx = w / 2, cy = h / 2;
  const grainAmt = flash ? 18 : 24;

  for (let y = 0; y < h; y++) {
    const dy = (y - cy) / cy;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dx = (x - cx) / cx;
      const d2 = dx * dx + dy * dy;

      let r = LUT.r[d[i]], g = LUT.g[d[i + 1]], b = LUT.b[d[i + 2]];

      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      r = lum + (r - lum) * 1.12;
      g = lum + (g - lum) * 1.08;
      b = lum + (b - lum) * 1.04;

      let k = 1.04 - 0.2 * d2;
      if (flash) k *= 1.22 - 0.42 * d2;
      r *= k; g *= k; b *= k;

      const mid = 1 - Math.min(1, Math.abs(lum / 255 - 0.45) * 1.4);
      const n = (Math.random() + Math.random() - 1) * grainAmt * (0.35 + mid);
      d[i] = r + n + (Math.random() - 0.5) * 6;
      d[i + 1] = g + n;
      d[i + 2] = b + n + (Math.random() - 0.5) * 6;
    }
  }
  ctx.putImageData(img, 0, 0);

  if (Math.random() < 0.45) lightLeak(ctx, w, h);
  dateStamp(ctx, w, h, date);

  return new Promise((resolve) => out.toBlob(resolve, 'image/jpeg', 0.86));
}

function lightLeak(ctx, w, h) {
  const left = Math.random() < 0.5;
  const x = left ? -w * 0.1 : w * 1.1;
  const y = h * (0.15 + Math.random() * 0.7);
  const rad = Math.max(w, h) * (0.45 + Math.random() * 0.25);
  const grad = ctx.createRadialGradient(x, y, 0, x, y, rad);
  grad.addColorStop(0, 'rgba(255, 70, 20, 0.75)');
  grad.addColorStop(0.35, 'rgba(255, 140, 40, 0.35)');
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
