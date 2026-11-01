// Copies runtime libraries out of node_modules so the deployed site never touches a CDN.
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const nm = 'node_modules', out = 'vendor';
rmSync(out, { recursive: true, force: true });
const copy = (from, to) => {
  const src = join(nm, from), dst = join(out, to);
  if (!existsSync(src)) throw new Error(`missing ${src}`);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true });
};

copy('pdf-lib/dist/pdf-lib.esm.min.js', 'pdf-lib.esm.min.js');
copy('pdfjs-dist/build/pdf.min.mjs', 'pdfjs/pdf.min.mjs');
copy('pdfjs-dist/build/pdf.worker.min.mjs', 'pdfjs/pdf.worker.min.mjs');
for (const d of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) copy(`pdfjs-dist/${d}`, `pdfjs/${d}`);
copy('jszip/dist/jszip.min.js', 'jszip.min.js');
copy('@neslinesli93/qpdf-wasm/dist/qpdf.js', 'qpdf/qpdf.js');
copy('@neslinesli93/qpdf-wasm/dist/qpdf.wasm', 'qpdf/qpdf.wasm');
copy('mammoth/mammoth.browser.min.js', 'mammoth.browser.min.js');
copy('xlsx/dist/xlsx.full.min.js', 'xlsx.full.min.js');
copy('pptxgenjs/dist/pptxgen.bundle.js', 'pptxgen.bundle.js');
copy('docx/dist/index.iife.js', 'docx.iife.js');
copy('tesseract.js/dist/tesseract.min.js', 'tesseract/tesseract.min.js');
copy('tesseract.js/dist/worker.min.js', 'tesseract/worker.min.js');
for (const v of ['tesseract-core-lstm', 'tesseract-core-simd-lstm', 'tesseract-core-relaxedsimd-lstm']) {
  copy(`tesseract.js-core/${v}.wasm.js`, `tesseract/core/${v}.wasm.js`);
}
for (const l of ['eng', 'hin', 'spa', 'fra', 'deu']) {
  copy(`@tesseract.js-data/${l}/4.0.0/${l}.traineddata.gz`, `tesseract/lang/${l}.traineddata.gz`);
}
console.log('vendor/ refreshed');
