// On-device odometer OCR (free, offline after first load).
//
// Pipeline per camera frame:
//  1. Grayscale + light blur.
//  2. Find the digit row: threshold (global Otsu and local/adaptive, both polarities), look for a row of
//     similarly sized blobs, and crop to it. This acts like "zooming in" on the reading even when it
//     fills only part of the guide box, and drops bezel edges, icons and glare around it.
//  3. Seven-segment decoder: LCD odometers are read segment by segment (Tesseract's text model often
//     confuses 7/1, 9/3, 5/6 on those). It only answers when every digit is an unambiguous pattern.
//  4. Tesseract.js (digits only) on a few binarized variants scaled to ~44 px digit height: Otsu,
//     adaptive, gaps closed (dot-matrix / segment displays) and bolder strokes.
//  5. Vote: a value read twice (or a clean seven-segment read) wins; otherwise another frame is taken.
import { createWorker, PSM, type Worker } from 'tesseract.js';

let workerPromise: Promise<Worker> | null = null;

/** Starts loading the OCR engine in the background so the first scan is fast. */
export function preloadOcr(): Promise<Worker> {
  workerPromise ??= (async () => {
    const base = document.baseURI;
    const w = await createWorker('eng', 1, {
      workerPath: new URL('tesseract/worker.min.js', base).href,
      corePath: new URL('tesseract/', base).href,
      workerBlobURL: false,
    });
    await w.setParameters({
      tessedit_char_whitelist: '0123456789',
      tessedit_pageseg_mode: PSM.SINGLE_LINE,
      user_defined_dpi: '300',
    });
    return w;
  })();
  workerPromise.catch(() => (workerPromise = null));
  return workerPromise;
}

// ---------- image helpers ----------

interface Gray {
  w: number;
  h: number;
  px: Uint8Array;
}

interface Rect {
  x: number; y: number; w: number; h: number;
}

/** Grayscale copy of `rect` in `src`, resized by `scale`, with a 3×3 box blur. */
function toGray(src: HTMLCanvasElement, scale: number, rect: Rect = { x: 0, y: 0, w: src.width, h: src.height }): Gray {
  const w = Math.max(1, Math.round(rect.w * scale));
  const h = Math.max(1, Math.round(rect.h * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Uint8Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) | 0;
  const out = new Uint8Array(g.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
          s += g[yy * w + xx];
          n++;
        }
      }
      out[y * w + x] = (s / n) | 0;
    }
  }
  return { w, h, px: out };
}

function otsu(px: Uint8Array): number {
  const hist = new Array(256).fill(0);
  for (const v of px) hist[v]++;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = px.length - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) [best, thr] = [between, t];
  }
  return thr;
}

type Method = 'otsu' | 'adaptive';

/** Ink mask (1 = ink). `lightInk` = light digits on a dark background (typical LCD/backlit odometer). */
function threshold(g: Gray, method: Method, lightInk: boolean): Uint8Array {
  const { w, h, px } = g;
  const m = new Uint8Array(w * h);
  if (method === 'otsu') {
    const t = otsu(px);
    for (let i = 0; i < m.length; i++) m[i] = (px[i] > t) === lightInk ? 1 : 0;
    return m;
  }
  // Bradley–Roth: compare each pixel with the mean of a window around it (handles glare and shadows).
  const ii = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += px[y * w + x];
      ii[(y + 1) * (w + 1) + x + 1] = ii[y * (w + 1) + x + 1] + row;
    }
  }
  const r = Math.max(4, Math.round(Math.min(w, h) / 4));
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const mean =
        (ii[y1 * (w + 1) + x1] - ii[y0 * (w + 1) + x1] - ii[y1 * (w + 1) + x0] + ii[y0 * (w + 1) + x0]) /
        ((x1 - x0) * (y1 - y0));
      const v = px[y * w + x];
      m[y * w + x] = lightInk
        ? v > mean + Math.max(8, 0.12 * (255 - mean)) ? 1 : 0
        : v < mean - Math.max(8, 0.12 * mean) ? 1 : 0;
    }
  }
  return m;
}

/** Grows (`grow`) or shrinks ink by `r` pixels with a 3×3 cross. */
function morph(m: Uint8Array, w: number, h: number, r: number, grow: boolean): Uint8Array {
  let cur = m;
  for (let k = 0; k < r; k++) {
    const out = new Uint8Array(cur.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const l = x > 0 ? cur[i - 1] : 0, rr = x < w - 1 ? cur[i + 1] : 0;
        const u = y > 0 ? cur[i - w] : 0, d = y < h - 1 ? cur[i + w] : 0;
        out[i] = grow ? (cur[i] | l | rr | u | d) : (cur[i] & l & rr & u & d);
      }
    }
    cur = out;
  }
  return cur;
}
const dilate = (m: Uint8Array, w: number, h: number, r: number) => morph(m, w, h, r, true);
/** Closing: fills gaps up to ~2r px (between LCD segments, dot-matrix dots) without thickening strokes. */
const close = (m: Uint8Array, w: number, h: number, r: number) => morph(morph(m, w, h, r, true), w, h, r, false);

interface Blob {
  id: number; x0: number; y0: number; x1: number; y1: number; area: number; edge: boolean;
}

/** Connected components (4-connected). `label` maps each ink pixel to its blob id (1-based). */
function components(m: Uint8Array, w: number, h: number): { blobs: Blob[]; label: Int32Array } {
  const label = new Int32Array(m.length);
  const blobs: Blob[] = [];
  const stack: number[] = [];
  for (let start = 0; start < m.length; start++) {
    if (!m[start] || label[start]) continue;
    const id = blobs.length + 1;
    const b: Blob = { id, x0: w, y0: h, x1: 0, y1: 0, area: 0, edge: false };
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w, y = (i / w) | 0;
      b.area++;
      if (x < b.x0) b.x0 = x;
      if (x > b.x1) b.x1 = x;
      if (y < b.y0) b.y0 = y;
      if (y > b.y1) b.y1 = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) b.edge = true;
      if (x > 0 && m[i - 1] && !label[i - 1]) { label[i - 1] = id; stack.push(i - 1); }
      if (x < w - 1 && m[i + 1] && !label[i + 1]) { label[i + 1] = id; stack.push(i + 1); }
      if (y > 0 && m[i - w] && !label[i - w]) { label[i - w] = id; stack.push(i - w); }
      if (y < h - 1 && m[i + w] && !label[i + w]) { label[i + w] = id; stack.push(i + w); }
    }
    blobs.push(b);
  }
  return { blobs, label };
}

const bh = (b: Blob) => b.y1 - b.y0 + 1;
const bw = (b: Blob) => b.x1 - b.x0 + 1;

interface Row {
  x0: number; y0: number; x1: number; y1: number; digitH: number; count: number;
}

/** Finds the most convincing horizontal row of digit-sized blobs. */
function findDigitRow(m: Uint8Array, w: number, h: number, closeR: number): Row | undefined {
  const { blobs } = components(close(m, w, h, closeR), w, h);
  const cands = blobs.filter((b) => {
    const fill = b.area / (bw(b) * bh(b));
    const ar = bw(b) / bh(b);
    // ar > 1.3: several digits touching each other (small or bold fonts); counted as several below.
    const shapeOk = ar >= 0.06 && (ar <= 1.3 ? fill > 0.1 && fill < 0.97 : ar <= 5 && fill > 0.2 && fill < 0.75);
    return !b.edge && bh(b) >= 10 && bh(b) >= 0.12 * h && bh(b) <= 0.95 * h && shapeOk;
  });
  const digitsIn = (b: Blob) => Math.max(1, Math.round(bw(b) / bh(b) / 0.6));
  let best: Row | undefined;
  const score = (r: Row) => Math.min(r.count, 7) * 1000 - Math.max(0, r.count - 7) * 500 + r.digitH;
  for (const ref of cands) {
    const rh = bh(ref);
    const rcy = (ref.y0 + ref.y1) / 2;
    const group = cands
      .filter((b) => Math.abs(bh(b) - rh) <= 0.3 * rh && Math.abs((b.y0 + b.y1) / 2 - rcy) <= 0.3 * rh)
      .sort((a, b) => a.x0 - b.x0);
    // Keep one contiguous run (gaps < 1.2 digit heights) around the reference blob.
    let lo = group.indexOf(ref), hi = lo;
    while (lo > 0 && group[lo].x0 - group[lo - 1].x1 < 1.2 * rh) lo--;
    while (hi < group.length - 1 && group[hi + 1].x0 - group[hi].x1 < 1.2 * rh) hi++;
    const run = group.slice(lo, hi + 1);
    // Merged blobs only count next to at least two ordinary single-digit blobs (else it is likely noise).
    if (run.filter((b) => digitsIn(b) === 1).length < 2) continue;
    const count = run.reduce((n, b) => n + digitsIn(b), 0);
    const row: Row = {
      x0: Math.min(...run.map((b) => b.x0)),
      y0: Math.min(...run.map((b) => b.y0)),
      x1: Math.max(...run.map((b) => b.x1)),
      y1: Math.max(...run.map((b) => b.y1)),
      digitH: run.reduce((s, b) => s + bh(b), 0) / run.length,
      count,
    };
    // Odometers have 5–7 digits; prefer rows near that, then taller digits.
    if (!best || score(row) > score(best)) best = row;
  }
  return best;
}

/** Removes ink blobs that touch the border (bezel edges, cut-off neighbours) and specks. */
function cleanMask(m: Uint8Array, w: number, h: number, digitH: number): Uint8Array {
  const { blobs, label } = components(m, w, h);
  const keep = [false, ...blobs.map((b) => !b.edge && !(b.area < (digitH * digitH) / 400 && bh(b) < digitH / 4))];
  const out = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) if (m[i] && keep[label[i]]) out[i] = 1;
  return out;
}

/** Renders a mask as black ink on white with padding, ready for Tesseract. */
function maskToCanvas(m: Uint8Array, w: number, h: number, pad: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w + pad * 2;
  c.height = h + pad * 2;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(c.width, c.height);
  const d = img.data;
  d.fill(255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue;
      const o = ((y + pad) * c.width + x + pad) * 4;
      d[o] = d[o + 1] = d[o + 2] = 0;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// ---------- seven-segment decoder ----------

const SEGMENTS: Record<string, string> = {
  abcdef: '0', bc: '1', abdeg: '2', abcdg: '3', bcfg: '4', acdfg: '5', acdefg: '6', cdefg: '6',
  abc: '7', abcf: '7', abcdefg: '8', abcdfg: '9', abcfg: '9',
};

/** Shears the mask horizontally to undo italic slant (common on LCD odometers). */
function deslant(m: Uint8Array, w: number, h: number): Uint8Array {
  let best = { s: 0, cols: Infinity };
  for (let s = -0.3; s <= 0.3001; s += 0.05) {
    const used = new Uint8Array(w + h);
    for (let y = 0; y < h; y++) {
      const off = Math.round((y - h / 2) * s) + (h >> 1);
      for (let x = 0; x < w; x++) if (m[y * w + x]) used[x + off] = 1;
    }
    const cols = used.reduce((a, v) => a + v, 0);
    if (cols < best.cols - 0.5) best = { s, cols };
  }
  if (Math.abs(best.s) < 0.01) return m;
  const out = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) {
    const off = Math.round((y - h / 2) * best.s);
    for (let x = 0; x < w; x++) {
      const nx = x + off;
      if (m[y * w + x] && nx >= 0 && nx < w) out[y * w + nx] = 1;
    }
  }
  return out;
}

/** Reads a seven-segment display; returns undefined unless every digit is a clean, known pattern. */
function decodeSevenSegment(mask: Uint8Array, w: number, h: number, digitH: number): string | undefined {
  const m = deslant(mask, w, h);
  // Join each digit's segments into one blob (segment gaps are small, digit spacing larger).
  const { blobs } = components(close(m, w, h, Math.max(1, Math.round(digitH / 18))), w, h);
  const digits = blobs.filter((b) => !b.edge && bh(b) >= 0.75 * digitH && bh(b) <= 1.3 * digitH).sort((a, b) => a.x0 - b.x0);
  if (digits.length < 4 || digits.length > 8) return undefined;
  const wide = digits.filter((b) => bw(b) / bh(b) > 0.3).map(bw).sort((a, b) => a - b);
  if (!wide.length) return undefined;
  const cellW = wide[wide.length >> 1];
  const fill = (x0: number, y0: number, x1: number, y1: number) => {
    let n = 0, ink = 0;
    for (let y = Math.round(y0); y < Math.round(y1); y++)
      for (let x = Math.round(x0); x < Math.round(x1); x++) {
        n++;
        ink += m[y * w + x];
      }
    return n ? ink / n : 0;
  };
  let out = '';
  for (const b of digits) {
    const H = bh(b);
    if (bw(b) < 0.5 * cellW) {
      // A "1": a narrow, solid, full-height bar.
      if (fill(b.x0, b.y0, b.x1 + 1, b.y1 + 1) < 0.5) return undefined;
      out += '1';
      continue;
    }
    if (bw(b) > 1.35 * cellW) return undefined; // merged digits
    const W = bw(b), x = b.x0, y = b.y0;
    const zones: Record<string, number> = {
      a: fill(x + 0.3 * W, y, x + 0.7 * W, y + 0.14 * H),
      g: fill(x + 0.3 * W, y + 0.43 * H, x + 0.7 * W, y + 0.57 * H),
      d: fill(x + 0.3 * W, y + 0.86 * H, x + 0.7 * W, y + H),
      f: fill(x, y + 0.17 * H, x + 0.22 * W, y + 0.38 * H),
      b: fill(x + 0.78 * W, y + 0.17 * H, x + W, y + 0.38 * H),
      e: fill(x, y + 0.62 * H, x + 0.22 * W, y + 0.83 * H),
      c: fill(x + 0.78 * W, y + 0.62 * H, x + W, y + 0.83 * H),
    };
    // The two "holes" of an 8 must be empty; curved/diagonal strokes of normal fonts land there.
    if (fill(x + 0.35 * W, y + 0.2 * H, x + 0.65 * W, y + 0.36 * H) > 0.12) return undefined;
    if (fill(x + 0.35 * W, y + 0.64 * H, x + 0.65 * W, y + 0.8 * H) > 0.12) return undefined;
    let key = '';
    for (const s of 'abcdefg') {
      const f = zones[s];
      if (f > 0.4) key += s;
      else if (f > 0.12) return undefined; // ambiguous
    }
    const digit = SEGMENTS[key];
    if (!digit) return undefined;
    out += digit;
  }
  return out;
}

// ---------- frame preparation ----------

interface Prepared {
  /** Seven-segment decodes from different thresholds (may be empty). */
  segReads: string[];
  /** Binarized images for Tesseract, most promising first. */
  variants: HTMLCanvasElement[];
}

const TARGET_DIGIT_H = 44;

function prepare(frame: HTMLCanvasElement): Prepared {
  // 1. Locate the digits on a downscaled copy.
  const detScale = Math.min(1, 700 / frame.width, 260 / frame.height);
  const det = toGray(frame, detScale);
  let found: { row: Row; lightInk: boolean; method: Method } | undefined;
  for (const method of ['otsu', 'adaptive'] as Method[]) {
    for (const lightInk of [true, false]) {
      const m = threshold(det, method, lightInk);
      // Small closing for solid/segment digits, larger one so dot-matrix digits become blobs.
      for (const closeR of [1, Math.max(2, Math.round(det.h / 50))]) {
        const row = findDigitRow(m, det.w, det.h, closeR);
        if (!row) continue;
        const k = (r: Row) => Math.min(r.count, 7) * 10000 + (r.x1 - r.x0) * 10 + r.digitH;
        if (!found || k(row) > k(found.row) * 1.02) found = { row, lightInk, method };
      }
    }
  }

  // 2. Crop to the digit row (with margin) at full resolution, scaled to the target digit height.
  let rect: Rect = { x: 0, y: 0, w: frame.width, h: frame.height };
  let digitH = frame.height * 0.5;
  if (found) {
    const { row } = found;
    const mx = row.digitH * 0.8, my = row.digitH * 0.35;
    const x0 = Math.max(0, (row.x0 - mx) / detScale), y0 = Math.max(0, (row.y0 - my) / detScale);
    const x1 = Math.min(frame.width, (row.x1 + 1 + mx) / detScale);
    const y1 = Math.min(frame.height, (row.y1 + 1 + my) / detScale);
    rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    digitH = row.digitH / detScale;
  }
  const scale = Math.min(6, TARGET_DIGIT_H / digitH);
  const g = toGray(frame, scale, rect);
  const dH = digitH * scale;
  const pad = Math.round(dH * 0.5);

  const light = found ? found.lightInk : true;
  const methods: Method[] = found?.method === 'adaptive' ? ['adaptive', 'otsu'] : ['otsu', 'adaptive'];
  const masks = methods.map((method) => {
    const m = threshold(g, method, light);
    return found ? cleanMask(m, g.w, g.h, dH) : m;
  });

  // 3. Seven-segment reads.
  const segReads: string[] = [];
  if (found) {
    for (const m of masks) {
      const s = decodeSevenSegment(m, g.w, g.h, dH);
      if (s) segReads.push(s);
    }
  }

  // 4. Tesseract variants.
  const variants = [
    maskToCanvas(masks[0], g.w, g.h, pad),
    maskToCanvas(close(masks[0], g.w, g.h, Math.max(1, Math.round(dH / 12))), g.w, g.h, pad), // join dots/segments
    maskToCanvas(masks[1], g.w, g.h, pad),
    maskToCanvas(dilate(masks[0], g.w, g.h, Math.max(1, Math.round(dH / 22))), g.w, g.h, pad), // bolder thin strokes
  ];
  if (!found) {
    const m = threshold(g, methods[0], !light); // polarity unknown: try the other one too
    variants.push(maskToCanvas(m, g.w, g.h, pad), maskToCanvas(close(m, g.w, g.h, Math.max(1, Math.round(dH / 12))), g.w, g.h, pad));
  }
  return { segReads, variants };
}

// ---------- reading ----------

/** Picks the most plausible odometer value among the digit groups Tesseract found. */
function pickValue(text: string, lastOdo?: number): number | undefined {
  const runs: string[] = text.match(/\d+/g) ?? [];
  const candidates = new Set<string>(runs);
  // Tesseract sometimes splits one number ("152 379"); joining is a fallback, not preferred.
  if (runs.length > 1) candidates.add(runs.join(''));
  const values = [...candidates].filter((s) => s.length >= 2 && s.length <= 7);
  if (!values.length) return undefined;
  if (lastOdo !== undefined) {
    const plausible = values.map(Number).filter((v) => v >= lastOdo && v - lastOdo < 5000);
    if (plausible.length) return plausible.sort((a, b) => a - b)[0];
  }
  const rank = (s: string) => (runs.includes(s) ? 10 : 0) + (s.length >= 5 ? 20 : 0) + s.length;
  return Number(values.sort((a, b) => rank(b) - rank(a))[0]);
}

export interface OcrResult {
  value?: number;
  confidence: number;
  /** The camera frame the result came from (for showing in the confirm sheet). */
  frame: HTMLCanvasElement;
}

/**
 * Reads the odometer. `grabFrame` is called for the first frame and again when that one gives no
 * agreeing reads (a new frame has different glare/noise/shake), up to `maxFrames` frames.
 */
export async function readOdometer(
  grabFrame: () => HTMLCanvasElement,
  lastOdo?: number,
  maxFrames = 2,
): Promise<OcrResult> {
  const worker = await preloadOcr();
  const isPlausible = (v?: number) =>
    v !== undefined && (lastOdo === undefined || (v >= lastOdo && v - lastOdo < 5000));

  const votes = new Map<number, { n: number; conf: number; frame: HTMLCanvasElement }>();
  const vote = (value: number, weight: number, conf: number, frame: HTMLCanvasElement) => {
    const v = votes.get(value) ?? { n: 0, conf: 0, frame };
    v.n += weight;
    v.conf = Math.max(v.conf, conf);
    votes.set(value, v);
    return v.n >= 2 && isPlausible(value) && String(value).length >= 4; // confident enough to stop
  };
  let firstFrame: HTMLCanvasElement | undefined;

  for (let f = 0; f < maxFrames; f++) {
    if (f > 0) await new Promise((r) => setTimeout(r, 120));
    const frame = grabFrame();
    if (frame.width < 8 || frame.height < 8) break; // camera stopped meanwhile
    firstFrame ??= frame;
    const { segReads, variants } = prepare(frame);
    for (const s of segReads) {
      // A clean seven-segment read is strong evidence on its own.
      if (vote(Number(s), 2, 90, frame)) return { value: Number(s), confidence: 90, frame };
    }
    for (const img of variants) {
      const { data } = await worker.recognize(img);
      const value = pickValue(data.text, lastOdo);
      if (value === undefined) continue;
      if (vote(value, 1, data.confidence, frame)) {
        const v = votes.get(value)!;
        return { value, confidence: v.conf, frame: v.frame };
      }
    }
  }

  const s = (v: number, x: { n: number; conf: number }) =>
    (isPlausible(v) ? 100000 : 0) + x.n * 1000 + Math.min(String(v).length, 7) * 100 + x.conf;
  const ranked = [...votes.entries()].sort(([va, a], [vb, b]) => s(vb, b) - s(va, a));
  if (!ranked.length) {
    if (!firstFrame) throw new Error('No camera frame');
    return { confidence: 0, frame: firstFrame };
  }
  const [value, v] = ranked[0];
  return { value, confidence: v.conf, frame: v.frame };
}

