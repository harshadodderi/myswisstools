// Copies runtime libraries out of node_modules so the deployed site never touches a CDN.
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildSync } from 'esbuild';

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
copy('marked/lib/marked.umd.js', 'marked.umd.js');
copy('foliate-js/mobi.js', 'foliate-mobi.js');
copy('fflate/esm/browser.js', 'fflate.js');
copy('@fontsource-variable/plus-jakarta-sans/files/plus-jakarta-sans-latin-wght-normal.woff2', 'fonts/plus-jakarta-sans.woff2');
copy('@fontsource-variable/plus-jakarta-sans/LICENSE', 'fonts/OFL.txt');
copy('tesseract.js/dist/tesseract.min.js', 'tesseract/tesseract.min.js');
copy('tesseract.js/dist/worker.min.js', 'tesseract/worker.min.js');
for (const v of ['tesseract-core-lstm', 'tesseract-core-simd-lstm', 'tesseract-core-relaxedsimd-lstm']) {
  copy(`tesseract.js-core/${v}.wasm.js`, `tesseract/core/${v}.wasm.js`);
}
for (const l of ['eng', 'hin', 'spa', 'fra', 'deu']) {
  copy(`@tesseract.js-data/${l}/4.0.0/${l}.traineddata.gz`, `tesseract/lang/${l}.traineddata.gz`);
}
copy('@fontsource/anton/files/anton-latin-400-normal.woff2', 'fonts/anton.woff2');
copy('@fontsource/anton/LICENSE', 'fonts/OFL-anton.txt');
copy('libheif-js/libheif-wasm/libheif-bundle.mjs', 'libheif-bundle.mjs');
copy('libheif-js/LICENSE', 'LICENSE-libheif.txt');
copy('svgo/dist/svgo.browser.js', 'svgo.js');
for (const f of ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) copy(`onnxruntime-web/dist/${f}`, `ort/${f}`);
for (const s of ['x2', 'x4']) for (const f of ['model.json', 'group1-shard1of1.bin']) copy(`@upscalerjs/esrgan-slim/models/${s}/${f}`, `models/esrgan/${s}/${f}`);
for (const f of ['ssd_mobilenetv1_model.bin', 'ssd_mobilenetv1_model-weights_manifest.json']) copy(`@vladmandic/face-api/model/${f}`, `models/face/${f}`);

// Libraries without a browser module build are bundled here. Nothing else needs a build step.
for (const name of ['imagekit', 'aikit']) {
  buildSync({
    entryPoints: [`scripts/${name}-entry.js`], outfile: join(out, `${name}.js`), bundle: true, format: 'esm', minify: true,
    platform: 'browser', target: 'es2020', logLevel: 'warning', legalComments: 'none',
    alias: { '@tensorflow/tfjs/dist/tf.es2017.js': '@tensorflow/tfjs', '@tensorflow/tfjs-backend-wasm/dist/index.js': './scripts/empty-wasm-backend.js' },
    define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
  });
}
console.log('vendor/ refreshed');
