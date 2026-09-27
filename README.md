# Foolscap

**A complete PDF editor that runs entirely in your browser. No backend, no build step, no upload.**

Foolscap is three static files. Open them from any static host, including GitHub Pages, and you get a full PDF editor: merge, split, reorder, rotate, watermark, sign, add page numbers, and, crucially, **edit the text that is already in the document, in something close to its own font**, and **swap out images already in the document** without recreating the layout around them.

Every one of those operations happens on the visitor's own machine using [pdf.js](https://mozilla.github.io/pdf.js/) to read and render, [pdf-lib](https://pdf-lib.js.org/) and [fontkit](https://github.com/Hopding/fontkit) to write, and [JSZip](https://stuk.github.io/jszip/) for bulk exports. The PDF a visitor opens never leaves their device, which also happens to be the only sane way to run a PDF tool on a platform like GitHub Pages that can't run a server anyway.

---

## Contents

- [Features](#features)
- [How the "edit existing text" feature actually works](#how-the-edit-existing-text-feature-actually-works)
- [Quick start](#quick-start)
- [Deploying to GitHub Pages](#deploying-to-github-pages)
- [Custom domain](#custom-domain)
- [Project structure](#project-structure)
- [Architecture notes](#architecture-notes)
- [Browser support](#browser-support)
- [Known limitations](#known-limitations)
- [Extending it](#extending-it)
- [License](#license)

---

## Features

| Category | What it does |
|---|---|
| Open | Load any PDF, or drop one anywhere on the page. Convert a PNG or JPG straight into a one-page PDF. |
| Merge | Add more PDFs; their pages append to the working document. |
| Reorder | Drag thumbnails in the page rail into any order. |
| Rotate / delete | Rotate or remove one page or a multi-selection at once. |
| Insert | Add blank A4 pages anywhere in the document. |
| **Edit existing text** | Click any line of existing text and retype it in place, matched to the original font whenever that's safely possible (see below). |
| **Replace existing images** | Click any existing image or photo and swap in a new one at the exact same position and size. |
| Add new text | Drop new text anywhere, in a sans, serif or monospace family, bold and/or italic, any size and colour. |
| Watermark | Stamp an image or logo on one page or on every page at once, with adjustable opacity. |
| Sign | Draw a signature with a mouse or a finger and place it like an image. |
| Page numbers | Add numbering in three formats and four positions, across the whole document in one click. |
| Extract | Export just the selected pages as a new PDF. |
| Split | Export every page as its own PDF, delivered as a single `.zip`. |
| Extract text | Pull all the text out of the document as a `.txt` file. |
| Zoom | Zoom the page view in and out, independent of your export resolution. |
| Undo | Step back through page-level changes (reordering, rotating, deleting, inserting). |
| Responsive | The page rail and tool panel become slide-in drawers on phones and tablets; every control is touch-friendly. |
| Download | Save the fully edited PDF at any point. |

## How the "edit existing text" feature actually works

Editing text that's already baked into a PDF is the hardest thing a browser-only tool can attempt, so it's worth being precise about what Foolscap actually does, rather than overselling it.

1. When you click a line of text with the **Edit** tool active, Foolscap reads that line's exact position, size and the internal font it was drawn with, straight out of the PDF using pdf.js.
2. It samples the rendered pixels around that line to work out the real ink colour and background colour, so a replacement blends in even on a shaded or coloured background, not just plain white pages.
3. When you confirm your edit, Foolscap checks whether every character in your new text already appeared somewhere in the original line. Most real edits (fixing a typo, correcting a number, swapping a name for one made of the same letters) pass this check.
   - **If it passes**, Foolscap extracts the actual embedded font program from the source PDF and re-embeds it in the output, so your replacement text renders in the *literal original font*.
   - **If it doesn't** (you typed a character that line never used), Foolscap falls back to the closest standard typeface, matched on weight and slant (bold, italic, serif, sans or monospace) by inspecting the original font's name and metrics. Nothing ever silently renders as a missing-glyph box.
4. On export, the original line is covered with a rectangle in the sampled background colour and the new text is drawn on top at the same baseline.

This is why the guarantee is "the original font whenever it's safely reusable", not "always". PDF fonts are frequently embedded as subsets containing only the glyphs the document actually used, so blindly reusing them for arbitrary new text is how other tools produce garbled or blank output. Checking the character set first is what keeps this reliable.

Image replacement is much simpler and has no such caveat: Foolscap finds the exact position and size of every image already painted on the page, and drawing your replacement at that same position and size fully covers the original for the vast majority of PDFs.

## Quick start

No Node, no npm, no build step. It's plain HTML, CSS and JavaScript.

```bash
git clone https://github.com/<your-username>/<your-repo>.git
cd <your-repo>
python3 -m http.server 8000
# now open http://localhost:8000
```

Double-clicking `index.html` also works in most browsers, though a local server avoids the handful of browser restrictions that apply to the `file://` protocol.

## Deploying to GitHub Pages

1. **Create a repository** on GitHub, for example `pdf-editor`.
2. **Add the project files** (`index.html`, `styles.css`, `app.js`, this `README.md`) to the repository root, or to a `/docs` folder if you'd rather keep them out of the root.
3. **Commit and push:**
   ```bash
   git init
   git add index.html styles.css app.js README.md
   git commit -m "Add Foolscap"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```
4. **Turn on GitHub Pages:**
   - Open the repository on GitHub, then **Settings → Pages**.
   - Under **Build and deployment → Source**, choose **Deploy from a branch**.
   - Under **Branch**, choose `main` and the folder you used (root, or `/docs`), then **Save**.
5. **Wait about a minute**, then reload the Pages settings tab. GitHub shows a green banner with your live URL:
   ```
   https://<your-username>.github.io/<your-repo>/
   ```
   If the repository itself is named `<your-username>.github.io`, the site is served at `https://<your-username>.github.io/` with no extra path segment.
6. **Open that URL.** pdf.js, pdf-lib, fontkit and JSZip all load from public CDNs over HTTPS, so there's nothing else to configure. Every future push to that branch redeploys automatically within a minute or two.

## Custom domain

In **Settings → Pages**, enter your domain under **Custom domain** and add the DNS records GitHub displays (a `CNAME` record pointing at `<your-username>.github.io` for a subdomain, or the listed `A` records for an apex domain). GitHub provisions a free HTTPS certificate for the domain automatically once DNS has propagated.

## Project structure

```
.
├── index.html   # Layout: masthead, page rail, canvas viewer, tool panel, modals
├── styles.css   # All styling, including the responsive drawer breakpoints
├── app.js       # Application logic: state, rendering, editing, export
└── README.md
```

There's deliberately no framework and no bundler, so the whole thing is readable top to bottom in one sitting and easy to fork.

## Architecture notes

- **State** lives in a single `state` object in `app.js`: a `pages` array describing the working document (each entry points at a page from a loaded PDF, or is a freshly inserted blank page), and an `annotations` map keyed by page holding everything placed or edited on it (new text, new images, signatures, and in-place text edits).
- **Coordinates** are always tracked in PDF point space (the document's own coordinate system), and converted to on-screen pixels only at render time via pdf.js's viewport transform. That keeps rotation, zoom and page size changes from ever corrupting a stored position.
- **Detecting existing content** (for the Edit tool) walks pdf.js's text content and operator list for the active page: text runs come with their exact position and the internal font reference already in hand; images are found by replaying the page's drawing operators to track the transform in effect at each image paint, which also correctly locates rotated images.
- **Exporting** always goes through one function, `buildPdfFromPages`, which builds a fresh pdf-lib document, copies in the right source pages in the right order with the right rotation, masks and redraws any edited text, draws every placed annotation on top, and serialises the result. Download, Extract selection and Split all all call this same function with a different page list.
- **Nothing is ever sent over the network.** The only requests the page makes are the one-time library and font loads from their CDNs; your PDF stays in memory in your tab.

## Browser support

Any current version of Chrome, Edge, Firefox or Safari. The signature pad and drag-and-drop reordering both work with touch as well as mouse input. Internet Explorer is not supported.

## Known limitations

- **No password or encryption support.** pdf-lib can't decrypt or encrypt PDFs, so protected files can't be opened, and output files aren't password-protected.
- **No true file-size compression.** Recompressing a scanned PDF means re-encoding its embedded images, which is out of scope here; large scanned documents will stay large.
- **No AcroForm field-filling interface.** pdf-lib can read and fill form fields programmatically, but this build doesn't expose a form UI for it.
- **Font reuse for edited text depends on character reuse**, as explained above; new characters that never appeared in the original line fall back to a matched standard typeface rather than the exact original font.
- Very long documents (hundreds of pages) will render thumbnails more slowly, since each one is rasterised in the browser.

## Extending it

The codebase is intentionally flat. To add a new tool, follow the pattern already used for `text` or `image` in `app.js`: add a button with a `data-tool` attribute, a matching panel section in `index.html`, a case in `setActiveTool`, and a handler in the canvas click listener. Pull requests and forks are welcome.

## License

MIT. Do whatever you like with it, including using it as the base for something you sell.
