# Foolscap

**A complete PDF editor that runs entirely in your browser. No backend, no build step, no upload.**

Edit the text that is already in a document, swap its images, merge, split, reorder, annotate, watermark, sign and **compress**. Foolscap is three static files, so it deploys to GitHub Pages in about a minute, and the PDFs your visitors open never leave their own device.

Under the hood it uses [pdf.js](https://mozilla.github.io/pdf.js/) to read and render, [pdf-lib](https://pdf-lib.js.org/) and [fontkit](https://github.com/Hopding/fontkit) to write, and [JSZip](https://stuk.github.io/jszip/) for bulk exports.

---

## Contents

- [Features](#features)
- [Compression](#compression)
- [Editing existing text and images](#editing-existing-text-and-images)
- [Quick start](#quick-start)
- [Deploying to GitHub Pages](#deploying-to-github-pages)
- [Custom domain](#custom-domain)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Responsive design](#responsive-design)
- [Project structure](#project-structure)
- [Architecture notes](#architecture-notes)
- [Known limitations](#known-limitations)
- [License](#license)

---

## Features

| Area | What you can do |
|---|---|
| Open | Open a PDF, drop one anywhere on the page, or turn a PNG or JPG into a one page PDF. |
| Merge | Add more PDFs at any time, or drop several at once. |
| Pages | Reorder by dragging (or with the up and down arrows on touch screens), rotate, delete, duplicate, insert blank pages, multi select with checkboxes, Shift click and Ctrl click. |
| **Edit existing text** | Click a line of text and retype it in place, matched to the original font where that is safely possible. |
| **Replace images** | Click an existing image and swap in a new one at exactly the same position and size. |
| Add text | Sans, serif or monospace, bold and italic, any size and colour. Bengali, Arabic, emoji and other scripts the standard PDF fonts cannot encode are rendered as crisp images automatically, so they never come out as blank boxes. |
| Shapes | Boxes, ovals and lines with outline, thickness, fill and fill opacity. |
| Highlight | Five colours with adjustable strength. |
| Redact | Solid black boxes (see the redaction note below). |
| Sign | Draw a signature with a mouse, finger or stylus, in black, blue or red ink. It is cropped automatically and placed like an image. |
| Image and watermark | Place an image on one page or stamp it on every page, with opacity and a resize handle. |
| Text watermark | Diagonal text across every page with size, angle, opacity and colour. |
| Page numbers | Four formats, five positions, applied to the whole document. |
| **Compress** | Three levels with a live before and after size. See below. |
| Export | Download the PDF, extract selected pages, split into single pages (ZIP), export every page as PNG (ZIP), or extract all text to a `.txt` file. |
| History | Undo and redo for every change, including edits, shapes and page operations. |
| Comfort | Light and dark themes, zoom, a page pager, crisp rendering on high density screens, and an unsaved changes warning when you close the tab. |

## Compression

Open **Compress** from the top bar. Foolscap shows the current size, lets you pick a level, runs it, and shows the new size and percentage saved before you download anything. If a setting cannot make the file smaller, it tells you rather than handing you a bigger file.

| Level | What it does | Best for | Text stays selectable |
|---|---|---|---|
| **Light** | Rebuilds the file structure. No visual change at all. | Files that are already lean | Yes |
| **Balanced** (default) | Re-encodes embedded images as JPEG at your chosen quality (25 to 92 percent) and caps their longest side (800, 1200, 1600, 2400 px or original). Only replaces an image when the result is actually smaller. | Photos, brochures, reports, most everyday PDFs | Yes |
| **Maximum** | Renders every page to an image at 72, 100, 150 or 200 dpi and rebuilds the PDF from those images. Optionally keeps an invisible text layer so the document stays searchable. | Scans, and anything where size matters more than anything else | Searchable only (optional) |

Balanced mode handles 8 bit JPEG and Flate encoded RGB and grayscale images, including ICC profiled ones, and leaves transparency masks intact. It deliberately skips masks, CMYK, indexed colour and 1 bit scan formats (CCITT and JBIG2), since re-encoding those risks changing how the page looks. For scanned documents that use those formats, use **Maximum**.

Compression runs on the document exactly as you have edited it, so your text edits, shapes and watermarks are included.

## Editing existing text and images

This is the hardest thing a browser only tool can attempt, so here is exactly what happens.

1. With the **Edit** tool active, Foolscap reads each line's position, size and internal font straight out of the PDF using pdf.js.
2. It samples the rendered pixels around that line to work out the true ink and background colours, so edits blend in on tinted backgrounds, not just white pages.
3. When you confirm an edit, it checks whether every character you typed already appeared in the original line.
   - **Yes:** the actual embedded font program is extracted and re-embedded, so the replacement renders in the literal original font.
   - **No:** it falls back to the closest standard typeface, matched on weight and slant (serif, sans or monospace, bold, italic). If a character cannot be encoded at all, it is drawn as an image instead, so nothing renders as a blank box.
4. On export the original line is covered by a rectangle in the sampled background colour and the new text is drawn on top at the same baseline.

PDF fonts are usually embedded as subsets containing only the glyphs the document used. Reusing them blindly for arbitrary new text is how other tools produce garbled output, which is why the character check exists.

**Images** are simpler. Foolscap finds the exact position and size of every image on the page by replaying the drawing operators, and your replacement is drawn at the same spot, fully covering the original. Replacement images are fully editable afterwards: drag and resize them like any other image.

> **A note on redaction.** The Redact tool draws a black box over content. That hides it visually but the underlying text can still exist in the file. For true removal, run **Compress, Maximum**, which flattens every page into an image and permanently discards anything hidden.

## Quick start

No Node, no npm, no build. It is plain HTML, CSS and JavaScript.

```bash
git clone https://github.com/<your-username>/<your-repo>.git
cd <your-repo>
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploying to GitHub Pages

1. **Create a repository** on GitHub, for example `foolscap`.
2. **Add the files** `index.html`, `styles.css`, `app.js`, `README.md` and `LICENSE` to the repository root (or to a `/docs` folder).
3. **Commit and push:**
   ```bash
   git init
   git add .
   git commit -m "Add Foolscap"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```
4. **Enable Pages:** open the repository, go to **Settings, Pages**. Under **Build and deployment**, set **Source** to **Deploy from a branch**, choose `main` and the folder you used (root or `/docs`), then **Save**.
5. **Wait about a minute.** GitHub shows your live address:
   ```
   https://<your-username>.github.io/<your-repo>/
   ```
   A repository named `<your-username>.github.io` is served at `https://<your-username>.github.io/` with no path.
6. **Open it.** pdf.js, pdf-lib, fontkit, JSZip and the Inter font load from public CDNs over HTTPS, so there is nothing else to configure. Every push to the branch redeploys automatically.

The CDN scripts are pinned to exact versions. If you would rather not depend on a CDN, download those four files into the repository and change the `<script>` tags in `index.html` to point at them. Remember to point `GlobalWorkerOptions.workerSrc` at the local pdf.js worker in `app.js` as well.

## Custom domain

In **Settings, Pages**, enter your domain under **Custom domain** and add the DNS records GitHub shows you: a `CNAME` pointing at `<your-username>.github.io` for a subdomain, or the listed `A` records for an apex domain. GitHub issues a free HTTPS certificate once DNS propagates.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `V` `E` `T` `I` `U` `H` `X` `G` | Select, Edit existing, Text, Image, Shape, Highlight, Redact, Sign |
| `Ctrl/Cmd + Z`, `Ctrl/Cmd + Y` | Undo, redo |
| `Ctrl/Cmd + S` | Download |
| `[` and `]`, or `Page Up` and `Page Down` | Previous and next page |
| `+` and `-`, or `Ctrl` + scroll | Zoom |
| `Delete` | Remove the selected item, or the selected pages |
| `Esc` | Close dialogs and drawers |

## Responsive design

- **Desktop (wider than 1100 px):** three columns with the page rail, the canvas and the tool options side by side.
- **Tablet (up to 1100 px):** the rail and options become slide in drawers behind a backdrop.
- **Phone (up to 700 px):** the tools move into a thumb friendly dock at the bottom of the screen, the options open as a bottom sheet, buttons collapse to icons, and move and delete controls stay visible because there is no hover on touch screens.
- Pointer events power every drag, resize and draw interaction, so mouse, touch and stylus all behave the same way. The layout respects safe areas on notched devices and honours `prefers-reduced-motion` and `prefers-color-scheme`.

## Project structure

```
.
├── index.html   # Layout, icon sprite, tool options and dialogs
├── styles.css   # Design tokens, light and dark themes, responsive layouts
├── app.js       # State, rendering, editing, export and compression
├── README.md
└── LICENSE
```

There is deliberately no framework and no bundler, so the whole thing can be read top to bottom and is easy to fork.

## Architecture notes

- **One state object.** `pages` describes the working document (each entry points at a page of a loaded PDF, or is a blank page), and `annotations` holds everything placed or edited, keyed by page. Undo and redo snapshot both, plus the watermark.
- **PDF point space everywhere.** Every stored position is in the document's own coordinates and is converted to screen pixels only at render time through the pdf.js viewport. Rotation and zoom can therefore never corrupt a stored position, and annotations placed on rotated pages still come out upright.
- **Detecting existing content.** Text runs come from pdf.js text content. Images are found by replaying the page's drawing operators while tracking the transform stack, which also locates rotated and nested images.
- **One export path.** `buildPdfFromPages` creates a fresh pdf-lib document, copies the right pages in the right order with the right rotation, masks and redraws edited text, draws every annotation, and applies the watermark. Download, Extract, Split, Export as PNG and every compression level all start from it, so what you see is what you get.
- **Compression** lives in `recompressImages` (Balanced) and `flattenToImages` (Maximum), with `runCompression` coordinating them and reporting progress to the dialog.
- **Nothing leaves the tab.** The only network requests are the one time library and font loads.

## Known limitations

- **Password protected files** cannot be opened, because pdf-lib cannot decrypt them. Exported files are not password protected either.
- **Form fields.** Filling AcroForm fields through a form UI is not included. You can still type over fields with the Text tool.
- **Edited text uses a single line per detected run.** Reflowing multi line paragraphs is not attempted.
- **Replaced images on pages you have rotated** are positioned correctly in the saved file, but the on screen preview of that one case can look offset. Rotate pages first, then edit, or replace images before rotating.
- **Balanced compression** skips image formats it cannot re-encode safely (see above). Use Maximum for those.
- Very long documents render thumbnails lazily as you scroll, but compressing or flattening hundreds of pages will take a while because it all happens in your browser.

## License

MIT. Use it, change it and ship it, including in commercial projects.
