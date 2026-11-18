// On-device odometer OCR with Tesseract.js (digits only).
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
    });
    return w;
  })();
  workerPromise.catch(() => (workerPromise = null));
  return workerPromise;
}

/** Grayscale + Otsu threshold, scaled to a size Tesseract likes, with the background forced to white. */
function binarize(src: HTMLCanvasElement, invert: boolean): HTMLCanvasElement {
  const targetH = 90;
  const scale = targetH / src.height;
  const w = Math.max(1, Math.round(src.width * scale));
  const pad = 20;
  const c = document.createElement('canvas');
  c.width = w + pad * 2;
  c.height = targetH + pad * 2;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, pad, pad, w, targetH);

  const img = ctx.getImageData(pad, pad, w, targetH);
  const d = img.data;
  const gray = new Uint8Array(w * targetH);
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) {
    const g = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
    gray[i] = g;
    hist[g]++;
  }
  // Otsu threshold
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = gray.length - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) [best, thr] = [between, t];
  }
  let dark = 0;
  for (const g of gray) if (g <= thr) dark++;
  // Background is the majority; make it white. `invert` tries the opposite polarity.
  const darkIsText = (dark < gray.length / 2) !== invert;
  for (let i = 0; i < gray.length; i++) {
    const isDark = gray[i] <= thr;
    const v = isDark === darkIsText ? 0 : 255;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
  }
  ctx.putImageData(img, pad, pad);
  return c;
}

/** Picks the most plausible odometer value among the digit groups found. */
function pickValue(text: string, lastOdo?: number): number | undefined {
  const runs = text.match(/\d+/g) ?? [];
  const candidates = new Set<string>(runs);
  if (runs.length > 1) candidates.add(runs.join(''));
  const values = [...candidates].filter((s) => s.length >= 2 && s.length <= 7).map(Number);
  if (!values.length) return undefined;
  if (lastOdo !== undefined) {
    const plausible = values.filter((v) => v >= lastOdo && v - lastOdo < 5000);
    if (plausible.length) return plausible.sort((a, b) => a - lastOdo - (b - lastOdo))[0];
  }
  return values.sort((a, b) => String(b).length - String(a).length)[0];
}

export interface OcrResult {
  value?: number;
  confidence: number;
}

export async function readOdometer(crop: HTMLCanvasElement, lastOdo?: number): Promise<OcrResult> {
  const worker = await preloadOcr();
  const isPlausible = (v?: number) =>
    v !== undefined && (lastOdo === undefined || (v >= lastOdo && v - lastOdo < 5000));
  // Score: plausible values first, then any value, then OCR confidence.
  const score = (r: OcrResult) => (isPlausible(r.value) ? 2000 : r.value !== undefined ? 1000 : 0) + r.confidence;
  let best: OcrResult = { confidence: 0 };
  for (const invert of [false, true]) {
    const { data } = await worker.recognize(binarize(crop, invert));
    const result = { value: pickValue(data.text, lastOdo), confidence: data.confidence };
    if (score(result) > score(best)) best = result;
    if (isPlausible(best.value) && best.confidence >= 70) break; // good enough, skip second pass
  }
  return best;
}
