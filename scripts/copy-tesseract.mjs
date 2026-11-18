// Copies the Tesseract worker and WASM cores into public/ so OCR runs from our own origin (works offline).
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const out = 'public/tesseract';
mkdirSync(out, { recursive: true });

const tjs = dirname(require.resolve('tesseract.js/package.json'));
const core = dirname(require.resolve('tesseract.js-core/package.json'));
copyFileSync(join(tjs, 'dist/worker.min.js'), join(out, 'worker.min.js'));
for (const f of ['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js']) {
  copyFileSync(join(core, f), join(out, f));
}
console.log('Tesseract files copied to', out);
