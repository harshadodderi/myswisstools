# myswisstools

57 PDF, ebook and image tools that run entirely in the browser, on desktop and on phones. Files are never uploaded: everything happens in the tab, and the page's Content-Security-Policy stops it from sending data to any other server.

**Use it:** https://harshadodderi.github.io/myswisstools/

**Source:** https://github.com/harshadodderi/myswisstools

## Deploy your own copy

The repo is a plain static site with no build step, so any static host works. To host it on GitHub Pages:

1. Fork this repository, or create a **public** one and push this folder to `main`.
2. In the repository, open **Settings → Pages**.
3. Under **Build and deployment**, set the source to **GitHub Actions**. The included workflow deploys every push to `main`.
4. The site appears at `https://<username>.github.io/<repo>/` within a minute or two.

All paths are relative, so it works from a repository subpath. The `vendor/` folder (about 87 MB) must be committed; it is what makes the site independent of CDNs.

## Tools

The PDF / IMG pill at the top switches between the two sets.

### PDF (44)

| Group | Tools |
| --- | --- |
| Organize | Merge, Split, Remove pages, Extract pages, Organize, Rotate |
| Optimize | Compress, Repair, OCR |
| Convert from PDF | Word, PowerPoint, Excel, JPG/PNG, PDF/A, EPUB, AZW3, Text, Markdown, HTML, CSV |
| Convert to PDF | Word, PowerPoint, Excel, JPG, HTML, Scan (camera), EPUB, AZW3/MOBI, Markdown, Text, ODT, RTF |
| Ebooks | EPUB to AZW3, AZW3/MOBI to EPUB |
| Edit | Edit, Sign, Redact, Crop, Watermark, Page numbers, Compare |
| Security | Protect (AES-256), Unlock, Edit metadata |

Password-protected PDFs work in every tool: the app asks for the password and uses it only in that tab.

Edit, Sign and Redact can open several PDFs at once, each in its own tab, and a signature made in one is ready in the others. Watermark, Page numbers, Compress, Protect, OCR and the conversion tools can process many files in one run and offer the results as a ZIP.

### Images (13)

| Group | Tools |
| --- | --- |
| Optimize | Compress, Upscale (AI), Remove background (AI) |
| Create | Meme generator |
| Edit | Resize, Crop, Rotate, Photo editor |
| Convert | Convert to JPG, Convert from JPG, HTML to image |
| Security | Watermark, Blur face (AI) |

Input formats include JPG, PNG, WebP, GIF (animated too), SVG, HEIC, TIFF, PSD and camera RAW. The AI models also run on the device, so nothing is uploaded.

## How it behaves

- **Protect** is real AES-256 encryption through qpdf. A lost password cannot be recovered.
- **Unlock** needs the password. It does not crack PDFs.
- **Compress** re-encodes images and optimizes the file structure. Text, fonts and vectors are untouched, so text stays selectable. If nothing can be saved, it returns the original.
- **Redact** rebuilds marked pages as images, so hidden content is removed from the file, not covered. Text on those pages is no longer selectable; other pages keep theirs.
- **Watermark, page numbers and edit text** work in any script. Latin text stays real text; other scripts are drawn with the device's fonts and embedded as images.

## Known limits

- **Images on phones:** photos over about 16 megapixels are reduced to fit in memory, because phones lose larger canvases. AI tools are slower on phones, and Upscale reduces oversized images first.
- **Remove background:** uses a small model so it can run on a phone. It works best with one clear subject. Busy group photos can lose parts.
- **Blur face:** detection can miss small, turned or covered faces, so always check the result. Blur can sometimes be reversed; use Solid block for anything truly sensitive.
- **RAW files:** use the full-size preview stored by the camera rather than developing the sensor data.
- **WebP output:** Safari cannot write WebP, so it saves PNG instead and names the file accordingly.
- **HTML to image:** uses the same layout engine as HTML to PDF, so fonts map to Helvetica, Times or Courier.

- **Not included:** AI Translate and AI Summarize. They need a large language model, which does not fit a static, on-device site.
- **PDF to Word/PowerPoint/Excel:** layouts are rebuilt, not copied exactly. Multi-column pages and tables without clear column gaps can come out rough. Scans need OCR first.
- **Word/PowerPoint/Excel to PDF:** there is no Office engine in the browser, so documents are re-laid out. Word headers, footers and exact page breaks can differ. PowerPoint charts, gradients and SmartArt, and Excel charts, are not drawn. Legacy `.doc` and `.ppt` files must be re-saved as `.docx` or `.pptx`. Fonts map to Helvetica, Times or Courier.
- **HTML to PDF:** no URL fetching, because browsers block it. Scripts do not run, and remote images and stylesheets are removed.
- **EPUB and AZW3:** PDF sources are rebuilt as reflowable text, so multi-column pages and repeated headers can come out rough; scans need OCR first. Book-to-PDF uses a clean reading layout rather than the book's own styling. DRM-protected books are refused, and KFX is not supported.
- **AZW3 output is experimental:** files are uncompressed and have no table-of-contents menu. They parse in two independent readers but have not been tried on a physical Kindle or checked with Calibre. EPUB output has not been run through EPUBCheck.
- **ODT and RTF to PDF:** ODT keeps text, basic styling, lists, tables and images. RTF keeps text, bold and italic only.
- **PDF/A:** produces a PDF/A-2B structure with pages stored as images. It has not been checked with a validator such as veraPDF, so verify it if conformance is a legal requirement.
- **Sign:** adds a visible signature, not a certificate-based digital signature.
- **Large files:** limited by the device's memory, especially on phones.

## Development

```bash
npm install
npm run vendor   # refresh vendor/ from node_modules
npm run serve    # http://localhost:8123
npm test         # drives every tool in Chrome, then repeats key flows with phone touch emulation
```

`BROWSER=firefox npm test` and `BROWSER=webkit npm test` run the suite on other engines (run it once in Chrome first, which generates the fixtures, and install them with `npx playwright install firefox webkit`). `npm test -- ocr sign` runs only matching tests.

Libraries without a browser build are bundled by `scripts/vendor.mjs`. The background removal model lives in `models/`.

When app files change, bump `VERSION` in `sw.js`. Third-party licenses are in [NOTICES.md](NOTICES.md).
