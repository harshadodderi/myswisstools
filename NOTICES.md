# Third-party software

The `vendor/` folder contains unmodified builds of these projects, each under its own license.

| Project | License |
| --- | --- |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | MIT |
| [PDF.js](https://github.com/mozilla/pdf.js) | Apache-2.0 |
| [qpdf](https://github.com/qpdf/qpdf) via [qpdf-wasm](https://github.com/neslinesli93/qpdf-wasm) | Apache-2.0 (qpdf), ISC (wrapper) |
| [Tesseract.js](https://github.com/naptha/tesseract.js) and tesseract.js-core | Apache-2.0 |
| tesseract.js language data | MIT (packaging); trained data from the Tesseract project, Apache-2.0 |
| [JSZip](https://github.com/Stuk/jszip) | MIT (chosen from MIT or GPL-3.0) |
| [mammoth.js](https://github.com/mwilliamson/mammoth.js) | BSD-2-Clause |
| [SheetJS Community Edition](https://sheetjs.com) | Apache-2.0 |
| [PptxGenJS](https://github.com/gitbrent/PptxGenJS) | MIT |
| [docx](https://github.com/dolanmiu/docx) | MIT |
| [marked](https://github.com/markedjs/marked) | MIT |
| [foliate-js](https://github.com/johnfactotum/foliate-js) | MIT |
| [fflate](https://github.com/101arrowz/fflate) | MIT |
| [TensorFlow.js](https://github.com/tensorflow/tfjs) | Apache-2.0 |
| [UpscalerJS](https://github.com/thekevinscott/upscalerjs) and the ESRGAN Slim model | MIT |
| [face-api](https://github.com/vladmandic/face-api) and its SSD MobileNet model | MIT |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) | MIT |
| [U²-Net](https://github.com/xuebinqin/U-2-Net) u2netp model, in `models/` | Apache-2.0 |
| [libheif-js](https://github.com/catdad-experiments/libheif-js) | LGPL-3.0, shipped unmodified as a separate file with its license in `vendor/LICENSE-libheif.txt` |
| [gifuct-js](https://github.com/matt-way/gifuct-js), [gifenc](https://github.com/mattdesl/gifenc), [UTIF.js](https://github.com/photopea/UTIF.js), [UPNG.js](https://github.com/photopea/UPNG.js), [ag-psd](https://github.com/Agamnentzar/ag-psd), [pako](https://github.com/nodeca/pako), [SVGO](https://github.com/svg/svgo) | MIT (pako: MIT and Zlib) |

## Fonts

Every font shipped with this site is free to use and redistribute under an open-source license, with no fee. Each license sits next to its font files.

| Font | Used for | License | License file |
| --- | --- | --- | --- |
| [Plus Jakarta Sans](https://github.com/tokotype/PlusJakartaSans) | App interface | SIL Open Font License 1.1 | `vendor/fonts/OFL.txt` |
| Anton | Meme captions and the Poster font | SIL Open Font License 1.1 | `vendor/fonts/OFL-anton.txt` |
| Liberation Sans | Displaying PDFs with PDF.js | GPL v2 with a font exception (Red Hat) | `vendor/pdfjs/standard_fonts/LICENSE_LIBERATION` |
| Foxit standard fonts | Displaying PDFs with PDF.js | BSD-style (PDFium) | `vendor/pdfjs/standard_fonts/LICENSE_FOXIT` |

Other font names in the code, such as Arial, Times New Roman, Courier New and SF Mono, are not shipped. They only ask the browser to use a font already installed on the visitor's device. PDFs created here refer to the standard PDF fonts Helvetica, Times and Courier by name and do not embed them.

Liberation Sans and the Foxit fonts come unmodified from PDF.js and are only used to display PDFs on screen, so they are not embedded in files this app creates.
