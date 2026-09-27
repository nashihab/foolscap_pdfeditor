/* =========================================================
   Foolscap - a fully client-side PDF editor
   Built on pdf.js (rendering + inspection), pdf-lib (writing),
   fontkit (embedding real fonts) and JSZip (bulk export).
   No file is ever sent anywhere: everything below runs in this tab.
   ========================================================= */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const { PDFDocument, rgb, degrees, StandardFonts } = PDFLib;
const HAS_FONTKIT = typeof window.fontkit !== "undefined";

const A4 = { width: 595.28, height: 841.89 };

/* ---------------------------------------------------------
   State
--------------------------------------------------------- */
const state = {
  documents: new Map(),      // docId -> { name, pdfBytes, pdfjsDoc }
  pages: [],                 // ordered working document
  annotations: new Map(),    // pageId -> array of annotation objects
  runCache: new Map(),       // pageId -> { textRuns, imageRegions } in PDF point space
  activePageId: null,
  selectedPageIds: new Set(),
  activeTool: "select",
  pendingImage: null,        // { dataUrl, img } waiting to be placed by a click
  pendingImageTarget: null,  // set when an edit-mode image click is waiting on the file picker
  viewportCache: new Map(),  // pageId -> viewport info for coordinate math
  zoom: 1,
  history: [],               // page-array snapshots for undo
};

let uidCounter = 1;
const uid = (prefix) => `${prefix}${uidCounter++}`;

/* ---------------------------------------------------------
   Small helpers
--------------------------------------------------------- */
function toast(msg, ms = 2600) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), ms);
}

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function hexToRgbFloat(hex) {
  const m = hex.replace("#", "");
  const bigint = parseInt(m, 16);
  return [((bigint >> 16) & 255) / 255, ((bigint >> 8) & 255) / 255, (bigint & 255) / 255];
}

function rgbFloatToHex(r, g, b) {
  const c = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

async function newPdfDocument() {
  const doc = await PDFDocument.create();
  if (HAS_FONTKIT) doc.registerFontkit(window.fontkit);
  return doc;
}

/* ---------------------------------------------------------
   Loading files
--------------------------------------------------------- */
async function openNewFile(file) {
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
    await loadPdfFile(file, { replace: true });
  } else if (/^image\//.test(file.type)) {
    await imageToPdfAndLoad(file);
  } else {
    toast("Unsupported file type. Please use a PDF, PNG or JPG.");
  }
}

async function loadPdfFile(file, { replace }) {
  try {
    const buf = await readFileAsArrayBuffer(file);
    const bytesForPdfLib = new Uint8Array(buf.slice(0));
    const pdfjsDoc = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;

    const docId = uid("doc");
    state.documents.set(docId, { name: file.name, pdfBytes: bytesForPdfLib, pdfjsDoc });

    const newPages = [];
    for (let i = 0; i < pdfjsDoc.numPages; i++) {
      newPages.push({ id: uid("page"), docId, srcIndex: i, rotation: 0, blank: false });
    }

    if (replace) {
      state.pages = newPages;
      state.selectedPageIds.clear();
      state.annotations.clear();
      state.runCache.clear();
      state.history = [];
    } else {
      pushHistory();
      state.pages = state.pages.concat(newPages);
    }

    document.getElementById("btn-download").disabled = false;
    showStageChrome();
    await renderRail();
    setActivePage(newPages[0] ? newPages[0].id : state.pages[0]?.id);
    toast(replace ? `Opened ${file.name}` : `Added ${pdfjsDoc.numPages} page(s) from ${file.name}`);
  } catch (err) {
    console.error(err);
    toast("Could not read that PDF. It may be encrypted or corrupted.");
  }
}

async function imageToPdfAndLoad(file) {
  try {
    const dataUrl = await readFileAsDataURL(file);
    const img = await loadImageFromDataUrl(dataUrl);
    const doc = await newPdfDocument();
    const embedded = /png/i.test(file.type) ? await doc.embedPng(dataUrl) : await doc.embedJpg(dataUrl);
    const page = doc.addPage([embedded.width, embedded.height]);
    page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
    const bytes = await doc.save();
    const blob = new Blob([bytes], { type: "application/pdf" });
    const pseudoFile = new File([blob], file.name.replace(/\.\w+$/, "") + ".pdf", { type: "application/pdf" });
    await loadPdfFile(pseudoFile, { replace: state.pages.length === 0 });
  } catch (err) {
    console.error(err);
    toast("Could not convert that image.");
  }
}

/* ---------------------------------------------------------
   Undo (page order / rotation / deletion / inserts only)
--------------------------------------------------------- */
function pushHistory() {
  state.history.push(state.pages.map((p) => ({ ...p })));
  if (state.history.length > 30) state.history.shift();
  document.getElementById("btn-undo").disabled = state.history.length === 0;
}

function undo() {
  const prev = state.history.pop();
  if (!prev) return;
  state.pages = prev;
  document.getElementById("btn-undo").disabled = state.history.length === 0;
  if (!state.pages.find((p) => p.id === state.activePageId)) {
    state.activePageId = state.pages[0]?.id || null;
  }
  renderRail();
  if (state.activePageId) renderStagePage();
  toast("Undone.");
}

/* ---------------------------------------------------------
   Rail (thumbnails)
--------------------------------------------------------- */
async function renderRail() {
  const list = document.getElementById("page-list");
  const empty = document.getElementById("rail-empty");
  document.getElementById("page-count").textContent = state.pages.length;

  if (state.pages.length === 0) {
    list.innerHTML = "";
    list.appendChild(empty);
    return;
  }
  if (empty.parentNode) empty.remove();
  list.innerHTML = "";

  for (const page of state.pages) {
    const card = document.createElement("div");
    card.className =
      "thumb" +
      (page.id === state.activePageId ? " active" : "") +
      (state.selectedPageIds.has(page.id) ? " selected" : "");
    card.draggable = true;
    card.dataset.pageId = page.id;

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "thumb-check";
    check.checked = state.selectedPageIds.has(page.id);
    check.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSelected(page.id, check.checked);
    });

    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 160;

    const meta = document.createElement("div");
    meta.className = "thumb-meta";
    const idx = state.pages.indexOf(page) + 1;
    meta.innerHTML = `<span>#${idx}</span>`;

    const remove = document.createElement("button");
    remove.className = "thumb-remove";
    remove.textContent = "\u00d7";
    remove.title = "Remove this page";
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      removePages([page.id]);
    });

    card.appendChild(check);
    card.appendChild(canvas);
    card.appendChild(meta);
    card.appendChild(remove);
    list.appendChild(card);

    card.addEventListener("click", () => setActivePage(page.id));
    wireDragReorder(card, page.id);

    renderThumbCanvas(page, canvas).catch(() => {});
  }
}

async function renderThumbCanvas(page, canvas) {
  const ctx = canvas.getContext("2d");
  if (page.blank) {
    const size = page.blankSize || A4;
    const scale = canvas.width / size.width;
    canvas.height = size.height * scale;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#DAD5C8";
    ctx.strokeRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const docEntry = state.documents.get(page.docId);
  if (!docEntry) return;
  const pdfPage = await docEntry.pdfjsDoc.getPage(page.srcIndex + 1);
  const totalRotation = (pdfPage.rotate + page.rotation + 360) % 360;
  const baseViewport = pdfPage.getViewport({ scale: 1, rotation: totalRotation });
  const scale = canvas.width / baseViewport.width;
  const viewport = pdfPage.getViewport({ scale, rotation: totalRotation });
  canvas.height = viewport.height;
  await pdfPage.render({ canvasContext: ctx, viewport }).promise;
}

function toggleSelected(pageId, on) {
  if (on) state.selectedPageIds.add(pageId);
  else state.selectedPageIds.delete(pageId);
  renderRail();
}

let dragSourceId = null;
function wireDragReorder(card, pageId) {
  card.addEventListener("dragstart", () => {
    dragSourceId = pageId;
  });
  card.addEventListener("dragover", (e) => {
    e.preventDefault();
    card.classList.add("drag-over");
  });
  card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
  card.addEventListener("drop", (e) => {
    e.preventDefault();
    card.classList.remove("drag-over");
    if (!dragSourceId || dragSourceId === pageId) return;
    const from = state.pages.findIndex((p) => p.id === dragSourceId);
    const to = state.pages.findIndex((p) => p.id === pageId);
    if (from === -1 || to === -1) return;
    pushHistory();
    const [moved] = state.pages.splice(from, 1);
    state.pages.splice(to, 0, moved);
    dragSourceId = null;
    renderRail();
  });
}

/* ---------------------------------------------------------
   Stage (main viewer)
--------------------------------------------------------- */
function showStageChrome() {
  document.getElementById("stage-empty").classList.add("hidden");
  document.getElementById("stage-toolbar").classList.remove("hidden");
  document.getElementById("stage-canvas-wrap").classList.remove("hidden");
}

async function setActivePage(pageId) {
  if (!pageId) return;
  state.activePageId = pageId;
  await renderStagePage();
  renderRail();
}

async function renderStagePage() {
  const page = state.pages.find((p) => p.id === state.activePageId);
  const canvas = document.getElementById("page-canvas");
  const frame = document.getElementById("page-frame");
  const hint = document.getElementById("stage-hint");
  if (!page) {
    canvas.width = 0;
    canvas.height = 0;
    return;
  }
  hint.textContent = `Page ${state.pages.indexOf(page) + 1} of ${state.pages.length}`;

  const ctx = canvas.getContext("2d");
  const baseWidth = Math.min(760, document.getElementById("stage-canvas-scroll").clientWidth - 48);
  const targetWidth = Math.max(120, baseWidth * state.zoom);

  let info;
  if (page.blank) {
    const size = page.blankSize || A4;
    const scale = targetWidth / size.width;
    canvas.width = size.width * scale;
    canvas.height = size.height * scale;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    info = {
      scale,
      rotation: 0,
      pageWidthPt: size.width,
      pageHeightPt: size.height,
      convertClickToPdf(x, y) {
        return [x / scale, size.height - y / scale];
      },
      toPixel(xPt, yPt) {
        return [xPt * scale, (size.height - yPt) * scale];
      },
    };
  } else {
    const docEntry = state.documents.get(page.docId);
    const pdfPage = await docEntry.pdfjsDoc.getPage(page.srcIndex + 1);
    const totalRotation = (pdfPage.rotate + page.rotation + 360) % 360;
    const unscaled = pdfPage.getViewport({ scale: 1, rotation: totalRotation });
    const scale = targetWidth / unscaled.width;
    const viewport = pdfPage.getViewport({ scale, rotation: totalRotation });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await pdfPage.render({ canvasContext: ctx, viewport }).promise;
    info = {
      scale,
      rotation: totalRotation,
      pageWidthPt: unscaled.width,
      pageHeightPt: unscaled.height,
      pdfPage,
      viewport,
      convertClickToPdf(x, y) {
        return viewport.convertToPdfPoint(x, y);
      },
      toPixel(xPt, yPt) {
        return viewport.convertToViewportPoint(xPt, yPt);
      },
    };
  }
  frame.style.width = canvas.width + "px";
  frame.style.height = canvas.height + "px";
  state.viewportCache.set(page.id, info);
  document.getElementById("zoom-value").textContent = Math.round(state.zoom * 100) + "%";

  renderOverlays(page.id);
  if (state.activeTool === "edit" && !page.blank) {
    await renderEditTargets(page);
  } else {
    clearEditTargets();
  }
}

/* ---------------------------------------------------------
   Overlay annotations (added text / images / signatures / text edits)
--------------------------------------------------------- */
function renderOverlays(pageId) {
  const layer = document.getElementById("overlay-layer");
  layer.querySelectorAll(".overlay-item").forEach((el) => el.remove());
  const anns = state.annotations.get(pageId) || [];
  for (const ann of anns) {
    layer.appendChild(buildOverlayEl(pageId, ann));
  }
}

function buildOverlayEl(pageId, ann) {
  const info = state.viewportCache.get(pageId);
  const el = document.createElement("div");
  el.className = "overlay-item overlay-" + ann.kind;

  const removeBtn = document.createElement("button");
  removeBtn.className = "overlay-remove";
  removeBtn.textContent = "\u00d7";
  removeBtn.title = ann.kind === "textEdit" ? "Revert to original text" : "Remove";
  removeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const list = state.annotations.get(pageId) || [];
    state.annotations.set(pageId, list.filter((a) => a.id !== ann.id));
    renderOverlays(pageId);
    if (state.activeTool === "edit") {
      const page = state.pages.find((p) => p.id === pageId);
      if (page) renderEditTargets(page);
    }
  });

  if (ann.kind === "text") {
    const [px, py] = info.toPixel(ann.xPt, ann.yPt);
    el.style.left = px + "px";
    el.style.top = py - ann.size * info.scale + "px";
    const inner = document.createElement("div");
    inner.className = "overlay-text";
    inner.textContent = ann.text;
    inner.style.fontSize = ann.size * info.scale + "px";
    inner.style.color = ann.color;
    inner.style.fontFamily = familyStack(ann.family);
    inner.style.fontWeight = ann.bold ? "700" : "400";
    inner.style.fontStyle = ann.italic ? "italic" : "normal";
    el.appendChild(inner);
    el.appendChild(removeBtn);
    makeDraggable(el, pageId, ann, info);
  } else if (ann.kind === "textEdit") {
    const [px, py] = info.toPixel(ann.xPt, ann.yPt);
    el.style.left = px + "px";
    el.style.top = py - ann.size * info.scale + "px";
    el.style.background = ann.bgColor;
    el.style.width = Math.max(ann.wPt, ann.size * ann.newText.length * 0.5) * info.scale + "px";
    el.style.height = ann.size * info.scale * 1.25 + "px";
    const inner = document.createElement("div");
    inner.className = "overlay-text";
    inner.textContent = ann.newText;
    inner.style.fontSize = ann.size * info.scale + "px";
    inner.style.color = ann.color;
    inner.style.fontFamily = familyStack(ann.fontRef.family);
    inner.style.fontWeight = ann.fontRef.bold ? "700" : "400";
    inner.style.fontStyle = ann.fontRef.italic ? "italic" : "normal";
    el.appendChild(inner);
    el.appendChild(removeBtn);
    el.addEventListener("click", (e) => {
      if (e.target.closest(".overlay-remove")) return;
      if (state.activeTool === "edit") {
        openInlineEditor(pageId, ann.runId, ann);
      }
    });
    makeDraggable(el, pageId, ann, info);
  } else if (ann.kind === "image") {
    const [px, py] = info.toPixel(ann.xPt, ann.yPt + ann.hPt);
    el.style.left = px + "px";
    el.style.top = py + "px";
    el.style.width = ann.wPt * info.scale + "px";
    el.style.height = ann.hPt * info.scale + "px";
    el.style.opacity = ann.opacity;
    const img = document.createElement("img");
    img.src = ann.dataUrl;
    el.appendChild(img);
    el.appendChild(removeBtn);
    const resize = document.createElement("div");
    resize.className = "overlay-resize";
    el.appendChild(resize);
    makeDraggable(el, pageId, ann, info, resize);
  }
  return el;
}

function familyStack(family) {
  if (family === "serif") return "var(--serif), Georgia, 'Times New Roman', serif";
  if (family === "mono") return "var(--mono), 'Courier New', monospace";
  return "var(--sans), Arial, sans-serif";
}

function makeDraggable(el, pageId, ann, info, resizeHandle) {
  el.addEventListener("mousedown", (e) => {
    if (e.target === resizeHandle) return startResize(e);
    if (e.target.closest(".overlay-remove")) return;
    e.preventDefault();
    el.classList.add("dragging");
    const startX = e.clientX, startY = e.clientY;
    const startLeft = parseFloat(el.style.left);
    const startTop = parseFloat(el.style.top);
    function onMove(ev) {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      el.style.left = startLeft + dx + "px";
      el.style.top = startTop + dy + "px";
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      el.classList.remove("dragging");
      const left = parseFloat(el.style.left);
      const top = parseFloat(el.style.top);
      if (ann.kind === "text" || ann.kind === "textEdit") {
        ann.xPt = left / info.scale;
        ann.yPt = info.pageHeightPt - top / info.scale - ann.size;
      } else {
        ann.xPt = left / info.scale;
        ann.yPt = info.pageHeightPt - (top + parseFloat(el.style.height)) / info.scale;
      }
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  function startResize(e) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = parseFloat(el.style.width);
    const startH = parseFloat(el.style.height);
    const aspect = startW / startH;
    function onMove(ev) {
      const dx = ev.clientX - startX;
      const newW = Math.max(20, startW + dx);
      const newH = newW / aspect;
      el.style.width = newW + "px";
      el.style.height = newH + "px";
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      ann.wPt = parseFloat(el.style.width) / info.scale;
      ann.hPt = parseFloat(el.style.height) / info.scale;
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }
  if (resizeHandle) resizeHandle.addEventListener("mousedown", startResize);
}

/* Clicking the page places whatever "add" tool is active */
document.getElementById("overlay-layer").addEventListener("click", async (e) => {
  if (e.target.closest(".overlay-item")) return;
  if (e.target.closest(".edit-target")) return; // handled by its own listener
  const page = state.pages.find((p) => p.id === state.activePageId);
  if (!page) return;
  const info = state.viewportCache.get(page.id);
  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const [xPt, yPt] = info.convertClickToPdf(x, y);

  if (state.activeTool === "text") {
    const text = document.getElementById("text-input").value.trim();
    if (!text) return toast("Type some text in the panel first.");
    const size = Number(document.getElementById("text-size").value);
    const color = document.getElementById("text-color").value;
    const family = document.querySelector("#text-family .segmented-btn.active").dataset.family;
    const bold = document.querySelector('#text-style .segmented-btn[data-style="bold"]').classList.contains("active");
    const italic = document.querySelector('#text-style .segmented-btn[data-style="italic"]').classList.contains("active");
    addTextAnnotation(page.id, { text, size, color, xPt, yPt, family, bold, italic });
  } else if (state.activeTool === "image" && state.pendingImage) {
    const applyAll = document.getElementById("image-all-pages").checked;
    const opacity = Number(document.getElementById("image-opacity").value) / 100;
    const { dataUrl, img } = state.pendingImage;
    const wPt = Math.min(200, info.pageWidthPt * 0.4);
    const hPt = wPt * (img.height / img.width);
    if (applyAll) {
      for (const p of state.pages) addImageAnnotation(p.id, { dataUrl, opacity, xPt, yPt, wPt, hPt });
      toast(`Stamped on all ${state.pages.length} pages.`);
    } else {
      addImageAnnotation(page.id, { dataUrl, opacity, xPt, yPt, wPt, hPt });
    }
  }
});

function addTextAnnotation(pageId, { text, size, color, xPt, yPt, family, bold, italic }) {
  const list = state.annotations.get(pageId) || [];
  list.push({ id: uid("ann"), kind: "text", text, size, color, xPt, yPt, family, bold, italic });
  state.annotations.set(pageId, list);
  if (pageId === state.activePageId) renderOverlays(pageId);
}

function addImageAnnotation(pageId, { dataUrl, opacity, xPt, yPt, wPt, hPt }) {
  const list = state.annotations.get(pageId) || [];
  list.push({ id: uid("ann"), kind: "image", dataUrl, opacity, xPt, yPt: yPt - hPt, wPt, hPt });
  state.annotations.set(pageId, list);
  if (pageId === state.activePageId) renderOverlays(pageId);
}

/* ---------------------------------------------------------
   Detecting existing text runs and image regions
   (all coordinates below are in PDF point space, unrotated)
--------------------------------------------------------- */
async function getRunData(page) {
  if (page.blank) return { textRuns: [], imageRegions: [] };
  if (state.runCache.has(page.id)) return state.runCache.get(page.id);

  const docEntry = state.documents.get(page.docId);
  const pdfPage = await docEntry.pdfjsDoc.getPage(page.srcIndex + 1);

  const textRuns = [];
  const content = await pdfPage.getTextContent();
  for (const item of content.items) {
    if (!item.str || !item.str.trim()) continue;
    const tx = item.transform;
    textRuns.push({
      id: uid("run"),
      str: item.str,
      xPt: tx[4],
      yPt: tx[5],
      widthPt: item.width || 1,
      heightPt: item.height || Math.hypot(tx[2], tx[3]) || 10,
      fontName: item.fontName,
      pageNum: page.srcIndex + 1,
    });
  }

  const imageRegions = [];
  try {
    const opList = await pdfPage.getOperatorList();
    const OPS = pdfjsLib.OPS;
    const stack = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i];
      const args = opList.argsArray[i];
      if (fn === OPS.save) {
        stack.push(ctm.slice());
      } else if (fn === OPS.restore) {
        ctm = stack.pop() || ctm;
      } else if (fn === OPS.transform) {
        ctm = pdfjsLib.Util.transform(ctm, args);
      } else if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
        const corners = [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ].map(([ux, uy]) => pdfjsLib.Util.applyTransform([ux, uy], ctm));
        const xs = corners.map((c) => c[0]);
        const ys = corners.map((c) => c[1]);
        const xPt = Math.min(...xs);
        const yPt = Math.min(...ys);
        const wPt = Math.max(...xs) - xPt;
        const hPt = Math.max(...ys) - yPt;
        if (wPt > 4 && hPt > 4) {
          imageRegions.push({ id: uid("img"), xPt, yPt, wPt, hPt });
        }
      }
    }
  } catch (err) {
    console.warn("Could not scan images on this page", err);
  }

  const data = { textRuns, imageRegions };
  state.runCache.set(page.id, data);
  return data;
}

function guessFontStyle(fontObj) {
  const nameParts = [fontObj?.name, fontObj?.fallbackName, fontObj?.loadedName]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const bold = /bold|black|heavy|semibold/.test(nameParts);
  const italic = /italic|oblique/.test(nameParts);
  let family = "sans";
  if (/times|georgia|garamond|minion|cambria|book|roman/.test(nameParts) || fontObj?.fallbackName === "serif") {
    family = "serif";
  }
  if (/courier|mono|consolas|typewriter/.test(nameParts) || fontObj?.fallbackName === "monospace") {
    family = "mono";
  }
  return { family, bold, italic };
}

/* Sample ink and background colour directly from the rendered canvas
   so a redrawn edit blends in even on tinted or non-white backgrounds. */
function sampleColors(pixelBox) {
  const canvas = document.getElementById("page-canvas");
  const ctx = canvas.getContext("2d");
  const x = Math.max(0, Math.floor(pixelBox.left));
  const y = Math.max(0, Math.floor(pixelBox.top));
  const w = Math.max(1, Math.min(canvas.width - x, Math.ceil(pixelBox.width)));
  const h = Math.max(1, Math.min(canvas.height - y, Math.ceil(pixelBox.height)));
  try {
    const data = ctx.getImageData(x, y, w, h).data;
    const counts = new Map();
    let rSum = 0, gSum = 0, bSum = 0, darkCount = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    let bgKey = null, bgCount = -1;
    for (const [k, c] of counts) {
      if (c > bgCount) { bgCount = c; bgKey = k; }
    }
    const [br, bg2, bb] = bgKey.split("-").map((v) => parseInt(v, 16) * 16 + 8);
    const bgLuminance = 0.299 * br + 0.587 * bg2 + 0.114 * bb;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (Math.abs(lum - bgLuminance) > 60) {
        rSum += r; gSum += g; bSum += b; darkCount++;
      }
    }
    const inkHex = darkCount > 0
      ? rgbFloatToHex(rSum / darkCount, gSum / darkCount, bSum / darkCount)
      : (bgLuminance > 128 ? "#16202A" : "#F5F4F0");
    const bgHex = rgbFloatToHex(br, bg2, bb);
    return { ink: inkHex, bg: bgHex };
  } catch (err) {
    return { ink: "#16202A", bg: "#FFFFFF" };
  }
}

/* ---------------------------------------------------------
   Edit mode: hover targets for existing text and images
--------------------------------------------------------- */
function clearEditTargets() {
  document.querySelectorAll(".edit-target").forEach((el) => el.remove());
}

async function renderEditTargets(page) {
  clearEditTargets();
  const info = state.viewportCache.get(page.id);
  if (!info) return;
  const { textRuns, imageRegions } = await getRunData(page);
  const layer = document.getElementById("overlay-layer");
  const anns = state.annotations.get(page.id) || [];
  const editedRunIds = new Set(anns.filter((a) => a.kind === "textEdit").map((a) => a.runId));
  const replacedRegionIds = new Set(anns.filter((a) => a.kind === "image" && a.replacesRegionId).map((a) => a.replacesRegionId));

  for (const run of textRuns) {
    if (editedRunIds.has(run.id)) continue;
    const padTop = run.heightPt * 0.25;
    const padBottom = run.heightPt * 0.22;
    const corners = [
      [run.xPt, run.yPt - padBottom],
      [run.xPt + run.widthPt, run.yPt - padBottom],
      [run.xPt, run.yPt + run.heightPt + padTop],
      [run.xPt + run.widthPt, run.yPt + run.heightPt + padTop],
    ].map(([px, py]) => info.toPixel(px, py));
    const box = boundingBoxOf(corners);
    const el = document.createElement("div");
    el.className = "edit-target";
    el.style.left = box.left + "px";
    el.style.top = box.top + "px";
    el.style.width = box.width + "px";
    el.style.height = box.height + "px";
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      openInlineEditor(page.id, run.id, null, run, box);
    });
    layer.appendChild(el);
  }

  for (const region of imageRegions) {
    if (replacedRegionIds.has(region.id)) continue;
    const corners = [
      [region.xPt, region.yPt],
      [region.xPt + region.wPt, region.yPt],
      [region.xPt, region.yPt + region.hPt],
      [region.xPt + region.wPt, region.yPt + region.hPt],
    ].map(([px, py]) => info.toPixel(px, py));
    const box = boundingBoxOf(corners);
    const el = document.createElement("div");
    el.className = "edit-target edit-target-image";
    el.style.left = box.left + "px";
    el.style.top = box.top + "px";
    el.style.width = box.width + "px";
    el.style.height = box.height + "px";
    const badge = document.createElement("span");
    badge.className = "edit-target-badge";
    badge.textContent = "replace image";
    el.appendChild(badge);
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      triggerImageReplace(page.id, region);
    });
    layer.appendChild(el);
  }
}

function boundingBoxOf(pixelCorners) {
  const xs = pixelCorners.map((c) => c[0]);
  const ys = pixelCorners.map((c) => c[1]);
  const left = Math.min(...xs), top = Math.min(...ys);
  return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

/* Opening the inline editor over an existing run (fresh or re-editing) */
async function openInlineEditor(pageId, runId, existingAnn, run, box) {
  const page = state.pages.find((p) => p.id === pageId);
  const info = state.viewportCache.get(pageId);
  const { textRuns } = await getRunData(page);
  run = run || textRuns.find((r) => r.id === runId);
  if (!run) return;

  let pixelBox = box;
  if (!pixelBox) {
    const corners = [
      [run.xPt, run.yPt - run.heightPt * 0.2],
      [run.xPt + run.widthPt, run.yPt + run.heightPt],
    ].map(([px, py]) => info.toPixel(px, py));
    pixelBox = boundingBoxOf(corners);
  }

  let fontRef = existingAnn?.fontRef;
  if (!fontRef) {
    let guess = { family: "sans", bold: false, italic: false };
    try {
      const fontObj = info.pdfPage.commonObjs.get(run.fontName);
      guess = guessFontStyle(fontObj);
    } catch (err) {
      /* font not resolvable yet, fall back to the sans-serif guess */
    }
    fontRef = { docId: page.docId, fontName: run.fontName, pageNum: run.pageNum, ...guess };
  }

  const colors = existingAnn
    ? { ink: existingAnn.color, bg: existingAnn.bgColor }
    : sampleColors(pixelBox);

  const sizePx = pixelBox.height * 0.78;

  const editor = document.createElement("textarea");
  editor.className = "inline-editor";
  editor.value = existingAnn ? existingAnn.newText : run.str;
  editor.style.left = pixelBox.left + "px";
  editor.style.top = pixelBox.top + "px";
  editor.style.width = Math.max(pixelBox.width, 40) + "px";
  editor.style.height = Math.max(pixelBox.height, 18) + "px";
  editor.style.fontSize = sizePx + "px";
  editor.style.color = colors.ink;
  editor.style.background = colors.bg;
  editor.style.fontFamily = familyStack(fontRef.family);
  editor.style.fontWeight = fontRef.bold ? "700" : "400";
  editor.style.fontStyle = fontRef.italic ? "italic" : "normal";
  document.getElementById("overlay-layer").appendChild(editor);
  editor.focus();
  editor.select();

  function commit() {
    editor.removeEventListener("blur", commit);
    const newText = editor.value;
    editor.remove();
    if (!newText || newText === run.str) {
      if (!existingAnn) return; // untouched, nothing to record
    }
    const list = state.annotations.get(pageId) || [];
    const filtered = list.filter((a) => a.id !== existingAnn?.id);
    filtered.push({
      id: existingAnn?.id || uid("ann"),
      kind: "textEdit",
      runId: run.id,
      originalStr: run.str,
      newText: newText || run.str,
      xPt: run.xPt,
      yPt: run.yPt,
      wPt: run.widthPt,
      size: run.heightPt * 0.92,
      color: colors.ink,
      bgColor: colors.bg,
      fontRef,
    });
    state.annotations.set(pageId, filtered);
    renderOverlays(pageId);
    renderEditTargets(page);
  }

  editor.addEventListener("blur", commit);
  editor.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      editor.blur();
    }
    if (e.key === "Escape") {
      editor.removeEventListener("blur", commit);
      editor.remove();
    }
  });
}

/* Replacing an existing image: open a file picker, then place the new
   image at exactly the detected region so it fully covers the original. */
function triggerImageReplace(pageId, region) {
  state.pendingImageTarget = { pageId, region };
  document.getElementById("image-replace-input").click();
}

const imageReplaceInput = document.createElement("input");
imageReplaceInput.type = "file";
imageReplaceInput.accept = "image/png,image/jpeg";
imageReplaceInput.id = "image-replace-input";
imageReplaceInput.hidden = true;
document.body.appendChild(imageReplaceInput);
imageReplaceInput.addEventListener("change", async () => {
  const file = imageReplaceInput.files[0];
  const target = state.pendingImageTarget;
  imageReplaceInput.value = "";
  if (!file || !target) return;
  const dataUrl = await readFileAsDataURL(file);
  const { pageId, region } = target;
  const list = state.annotations.get(pageId) || [];
  list.push({
    id: uid("ann"),
    kind: "image",
    dataUrl,
    opacity: 1,
    xPt: region.xPt,
    yPt: region.yPt,
    wPt: region.wPt,
    hPt: region.hPt,
    replacesRegionId: region.id,
  });
  state.annotations.set(pageId, list);
  state.pendingImageTarget = null;
  renderOverlays(pageId);
  const page = state.pages.find((p) => p.id === pageId);
  if (page && state.activeTool === "edit") renderEditTargets(page);
  toast("Image replaced. Drag or resize it if needed.");
});

/* ---------------------------------------------------------
   Tools (toolbar)
--------------------------------------------------------- */
function setActiveTool(tool) {
  state.activeTool = tool;
  document.querySelectorAll(".tool-btn").forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
  ["panel-empty", "panel-edit", "panel-text", "panel-image", "panel-sign"].forEach((id) =>
    document.getElementById(id).classList.add("hidden")
  );
  const map = { select: "panel-empty", edit: "panel-edit", text: "panel-text", image: "panel-image", sign: "panel-sign" };
  document.getElementById(map[tool]).classList.remove("hidden");

  const page = state.pages.find((p) => p.id === state.activePageId);
  if (page && !page.blank) {
    if (tool === "edit") renderEditTargets(page);
    else clearEditTargets();
  }
  openDrawer("panel");
}

document.querySelectorAll(".tool-btn").forEach((btn) => {
  btn.addEventListener("click", () => setActiveTool(btn.dataset.tool));
});

document.querySelectorAll("#text-family .segmented-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#text-family .segmented-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
  });
});
document.querySelectorAll("#text-style .segmented-btn").forEach((btn) => {
  btn.addEventListener("click", () => btn.classList.toggle("active"));
});

document.getElementById("text-size").addEventListener("input", (e) => {
  document.getElementById("text-size-value").textContent = e.target.value + "pt";
});
document.getElementById("image-opacity").addEventListener("input", (e) => {
  document.getElementById("image-opacity-value").textContent = e.target.value + "%";
});

document.getElementById("image-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const dataUrl = await readFileAsDataURL(file);
  const img = await loadImageFromDataUrl(dataUrl);
  state.pendingImage = { dataUrl, img };
  document.getElementById("image-preview").src = dataUrl;
  document.getElementById("image-preview-wrap").classList.remove("hidden");
  toast("Click the page to place the image.");
});

/* Signature pad */
(function setupSignaturePad() {
  const canvas = document.getElementById("sign-pad");
  const ctx = canvas.getContext("2d");
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.strokeStyle = "#16202A";
  let drawing = false;

  function pos(e) {
    const rect = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
  }
  function start(e) {
    drawing = true;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    e.preventDefault();
  }
  function move(e) {
    if (!drawing) return;
    const p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    e.preventDefault();
  }
  function end() {
    drawing = false;
  }
  canvas.addEventListener("mousedown", start);
  canvas.addEventListener("mousemove", move);
  window.addEventListener("mouseup", end);
  canvas.addEventListener("touchstart", start, { passive: false });
  canvas.addEventListener("touchmove", move, { passive: false });
  canvas.addEventListener("touchend", end);

  document.getElementById("btn-sign-clear").addEventListener("click", () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  });
  document.getElementById("btn-sign-use").addEventListener("click", async () => {
    const dataUrl = canvas.toDataURL("image/png");
    const img = await loadImageFromDataUrl(dataUrl);
    state.pendingImage = { dataUrl, img };
    setActiveTool("image");
    document.getElementById("image-preview").src = dataUrl;
    document.getElementById("image-preview-wrap").classList.remove("hidden");
    toast("Click the page to place your signature.");
  });
})();

/* ---------------------------------------------------------
   Page-level operations
--------------------------------------------------------- */
function currentTargets() {
  return state.selectedPageIds.size > 0
    ? [...state.selectedPageIds]
    : state.activePageId
    ? [state.activePageId]
    : [];
}

function rotatePages(delta) {
  const targets = currentTargets();
  if (targets.length === 0) return toast("Select a page first.");
  pushHistory();
  for (const id of targets) {
    const page = state.pages.find((p) => p.id === id);
    if (page) page.rotation = (page.rotation + delta + 360) % 360;
  }
  renderRail();
  renderStagePage();
}

function removePages(ids) {
  pushHistory();
  const idSet = new Set(ids);
  state.pages = state.pages.filter((p) => !idSet.has(p.id));
  ids.forEach((id) => {
    state.selectedPageIds.delete(id);
    state.annotations.delete(id);
    state.runCache.delete(id);
  });
  if (idSet.has(state.activePageId)) {
    state.activePageId = state.pages[0]?.id || null;
  }
  renderRail();
  if (state.activePageId) renderStagePage();
  else {
    document.getElementById("page-canvas").getContext("2d").clearRect(0, 0, 9999, 9999);
    document.getElementById("overlay-layer").innerHTML = "";
  }
  if (state.pages.length === 0) {
    document.getElementById("btn-download").disabled = true;
    document.getElementById("stage-empty").classList.remove("hidden");
    document.getElementById("stage-toolbar").classList.add("hidden");
    document.getElementById("stage-canvas-wrap").classList.add("hidden");
  }
}

function insertBlankPage() {
  pushHistory();
  const page = { id: uid("page"), docId: null, srcIndex: -1, rotation: 0, blank: true, blankSize: A4 };
  const activeIdx = state.pages.findIndex((p) => p.id === state.activePageId);
  if (activeIdx === -1) state.pages.push(page);
  else state.pages.splice(activeIdx + 1, 0, page);
  showStageChrome();
  document.getElementById("btn-download").disabled = false;
  renderRail();
  setActivePage(page.id);
}

/* ---------------------------------------------------------
   Building an output PDFDocument from current state
--------------------------------------------------------- */
function pickStandardFont(family, bold, italic) {
  if (family === "serif") {
    if (bold && italic) return StandardFonts.TimesRomanBoldItalic;
    if (bold) return StandardFonts.TimesRomanBold;
    if (italic) return StandardFonts.TimesRomanItalic;
    return StandardFonts.TimesRoman;
  }
  if (family === "mono") {
    if (bold && italic) return StandardFonts.CourierBoldOblique;
    if (bold) return StandardFonts.CourierBold;
    if (italic) return StandardFonts.CourierOblique;
    return StandardFonts.Courier;
  }
  if (bold && italic) return StandardFonts.HelveticaBoldOblique;
  if (bold) return StandardFonts.HelveticaBold;
  if (italic) return StandardFonts.HelveticaOblique;
  return StandardFonts.Helvetica;
}

async function resolveEditFont(out, ann, cache) {
  const canReuseGlyphs =
    HAS_FONTKIT &&
    [...ann.newText].every((ch) => ch === " " || ann.originalStr.includes(ch));

  if (canReuseGlyphs) {
    const cacheKey = "embed:" + ann.fontRef.docId + ":" + ann.fontRef.fontName;
    if (cache.has(cacheKey)) {
      const cached = cache.get(cacheKey);
      if (cached) return cached;
    } else {
      try {
        const docEntry = state.documents.get(ann.fontRef.docId);
        const pdfPage = await docEntry.pdfjsDoc.getPage(ann.fontRef.pageNum);
        const fontObj = pdfPage.commonObjs.get(ann.fontRef.fontName);
        if (fontObj && fontObj.data && fontObj.data.length) {
          const embedded = await out.embedFont(fontObj.data, { subset: false });
          cache.set(cacheKey, embedded);
          return embedded;
        }
        cache.set(cacheKey, null);
      } catch (err) {
        cache.set(cacheKey, null);
      }
    }
  }

  const stdFont = pickStandardFont(ann.fontRef.family, ann.fontRef.bold, ann.fontRef.italic);
  const stdKey = "std:" + stdFont;
  if (!cache.has(stdKey)) cache.set(stdKey, await out.embedFont(stdFont));
  return cache.get(stdKey);
}

async function buildPdfFromPages(pageList) {
  const out = await newPdfDocument();
  const embeddedImageCache = new Map();
  const fontCache = new Map();
  const stdFontCache = new Map();
  const newPageByOldId = new Map();

  const byDoc = new Map();
  pageList.forEach((page, i) => {
    if (page.blank) return;
    if (!byDoc.has(page.docId)) byDoc.set(page.docId, []);
    byDoc.get(page.docId).push({ page, orderIndex: i });
  });

  const copiedForOrder = new Array(pageList.length).fill(null);
  for (const [docId, entries] of byDoc.entries()) {
    const srcBytes = state.documents.get(docId).pdfBytes;
    const srcDoc = await PDFDocument.load(srcBytes);
    const indices = entries.map((e) => e.page.srcIndex);
    const copied = await out.copyPages(srcDoc, indices);
    entries.forEach((e, i) => {
      copiedForOrder[e.orderIndex] = copied[i];
    });
  }

  for (let i = 0; i < pageList.length; i++) {
    const page = pageList[i];
    let newPage;
    if (page.blank) {
      const size = page.blankSize || A4;
      newPage = out.addPage([size.width, size.height]);
    } else {
      newPage = out.addPage(copiedForOrder[i]);
      const docEntry = state.documents.get(page.docId);
      const src = await docEntry.pdfjsDoc.getPage(page.srcIndex + 1);
      const totalRotation = (src.rotate + page.rotation + 360) % 360;
      newPage.setRotation(degrees(totalRotation));
    }
    newPageByOldId.set(page.id, newPage);
  }

  if (!stdFontCache.has("Helvetica")) stdFontCache.set("Helvetica", await out.embedFont(StandardFonts.Helvetica));
  const helv = stdFontCache.get("Helvetica");

  for (const page of pageList) {
    const anns = state.annotations.get(page.id) || [];
    if (anns.length === 0) continue;
    const newPage = newPageByOldId.get(page.id);

    for (const ann of anns) {
      if (ann.kind === "textEdit") {
        const [br, bg2, bb] = hexToRgbFloat(ann.bgColor);
        const padTop = ann.size * 0.35;
        const padBottom = ann.size * 0.3;
        newPage.drawRectangle({
          x: ann.xPt - 1,
          y: ann.yPt - padBottom,
          width: Math.max(ann.wPt, helv.widthOfTextAtSize(ann.newText, ann.size)) + 2,
          height: ann.size + padTop + padBottom,
          color: rgb(br, bg2, bb),
        });
        const font = await resolveEditFont(out, ann, fontCache);
        const [r, g, b] = hexToRgbFloat(ann.color);
        newPage.drawText(ann.newText, {
          x: ann.xPt,
          y: ann.yPt,
          size: ann.size,
          font,
          color: rgb(r, g, b),
        });
      } else if (ann.kind === "text") {
        const stdFont = pickStandardFont(ann.family, ann.bold, ann.italic);
        if (!stdFontCache.has(stdFont)) stdFontCache.set(stdFont, await out.embedFont(stdFont));
        const font = stdFontCache.get(stdFont);
        const [r, g, b] = hexToRgbFloat(ann.color);
        newPage.drawText(ann.text, { x: ann.xPt, y: ann.yPt, size: ann.size, font, color: rgb(r, g, b) });
      } else if (ann.kind === "image") {
        let embedded = embeddedImageCache.get(ann.dataUrl);
        if (!embedded) {
          embedded = /^data:image\/png/i.test(ann.dataUrl) ? await out.embedPng(ann.dataUrl) : await out.embedJpg(ann.dataUrl);
          embeddedImageCache.set(ann.dataUrl, embedded);
        }
        newPage.drawImage(embedded, { x: ann.xPt, y: ann.yPt, width: ann.wPt, height: ann.hPt, opacity: ann.opacity });
      }
    }
  }

  return out;
}

async function exportAndDownload(pageList, filename) {
  try {
    toast("Building your PDF...");
    const doc = await buildPdfFromPages(pageList);
    const bytes = await doc.save();
    downloadBlob(new Blob([bytes], { type: "application/pdf" }), filename);
    toast(`Saved ${filename}`);
  } catch (err) {
    console.error(err);
    toast("Something went wrong building that PDF.");
  }
}

/* ---------------------------------------------------------
   Toolbar actions: extract / split / text extraction / page numbers
--------------------------------------------------------- */
async function extractSelection() {
  const ids = currentTargets();
  if (ids.length === 0) return toast("Select one or more pages first.");
  const idSet = new Set(ids);
  const list = state.pages.filter((p) => idSet.has(p.id));
  await exportAndDownload(list, "extracted-pages.pdf");
}

async function splitAllPages() {
  if (state.pages.length === 0) return toast("Nothing to split.");
  if (state.pages.length === 1) return extractSelection();
  const zip = new JSZip();
  for (let i = 0; i < state.pages.length; i++) {
    const doc = await buildPdfFromPages([state.pages[i]]);
    const bytes = await doc.save();
    zip.file(`page-${String(i + 1).padStart(2, "0")}.pdf`, bytes);
  }
  const blob = await zip.generateAsync({ type: "blob" });
  downloadBlob(blob, "split-pages.zip");
  toast(`Split into ${state.pages.length} files.`);
}

async function extractAllText() {
  if (state.pages.length === 0) return toast("Nothing to extract from.");
  let out = "";
  for (let i = 0; i < state.pages.length; i++) {
    const page = state.pages[i];
    out += `\n----- Page ${i + 1} -----\n`;
    if (page.blank) continue;
    const docEntry = state.documents.get(page.docId);
    const pdfPage = await docEntry.pdfjsDoc.getPage(page.srcIndex + 1);
    const content = await pdfPage.getTextContent();
    out += content.items.map((it) => it.str).join(" ");
    out += "\n";
  }
  downloadBlob(new Blob([out], { type: "text/plain" }), "extracted-text.txt");
  toast("Text file downloaded.");
}

function applyPageNumbers({ start, format, position }) {
  const total = state.pages.length;
  state.pages.forEach((page, i) => {
    const n = start + i;
    let text = String(n);
    if (format === "n-of-total") text = `${n} of ${total}`;
    if (format === "dash") text = `- ${n} -`;
    addPageNumberAnnotation(page, text, position);
  });
  if (state.activePageId) renderOverlays(state.activePageId);
  toast("Page numbers added to every page.");
}

async function addPageNumberAnnotation(page, text, position) {
  let widthPt, heightPt;
  if (page.blank) {
    widthPt = (page.blankSize || A4).width;
    heightPt = (page.blankSize || A4).height;
  } else {
    const docEntry = state.documents.get(page.docId);
    const pdfPage = await docEntry.pdfjsDoc.getPage(page.srcIndex + 1);
    const totalRotation = (pdfPage.rotate + page.rotation + 360) % 360;
    const vp = pdfPage.getViewport({ scale: 1, rotation: totalRotation });
    widthPt = vp.width;
    heightPt = vp.height;
  }
  const size = 11;
  const margin = 28;
  let x = widthPt / 2 - text.length * size * 0.28;
  let y = margin;
  if (position === "bottom-right") x = widthPt - margin - text.length * size * 0.55;
  if (position === "bottom-left") x = margin;
  if (position === "top-right") {
    x = widthPt - margin - text.length * size * 0.55;
    y = heightPt - margin;
  }
  const list = state.annotations.get(page.id) || [];
  const filtered = list.filter((a) => !a.autoPageNumber);
  filtered.push({
    id: uid("ann"),
    kind: "text",
    text,
    size,
    color: "#16202A",
    family: "sans",
    bold: false,
    italic: false,
    xPt: x,
    yPt: y,
    autoPageNumber: true,
  });
  state.annotations.set(page.id, filtered);
}

/* ---------------------------------------------------------
   Zoom
--------------------------------------------------------- */
function setZoom(z) {
  state.zoom = Math.max(0.4, Math.min(3, z));
  renderStagePage();
}
document.getElementById("btn-zoom-in").addEventListener("click", () => setZoom(state.zoom + 0.15));
document.getElementById("btn-zoom-out").addEventListener("click", () => setZoom(state.zoom - 0.15));
document.getElementById("btn-zoom-fit").addEventListener("click", () => setZoom(1));

/* ---------------------------------------------------------
   Mobile drawers
--------------------------------------------------------- */
function openDrawer(which) {
  if (window.innerWidth > 980) return;
  const el = document.getElementById(which === "rail" ? "rail" : "panel");
  el.classList.add("open");
  document.getElementById("drawer-backdrop").classList.add("show");
}
function closeDrawers() {
  document.getElementById("rail").classList.remove("open");
  document.getElementById("panel").classList.remove("open");
  document.getElementById("drawer-backdrop").classList.remove("show");
}
document.getElementById("btn-open-rail").addEventListener("click", () => openDrawer("rail"));
document.getElementById("btn-open-panel").addEventListener("click", () => openDrawer("panel"));
document.getElementById("btn-close-rail").addEventListener("click", closeDrawers);
document.getElementById("btn-close-panel").addEventListener("click", closeDrawers);
document.getElementById("drawer-backdrop").addEventListener("click", closeDrawers);

/* ---------------------------------------------------------
   Wiring: buttons, drag & drop, file inputs, shortcuts
--------------------------------------------------------- */
document.getElementById("input-open").addEventListener("change", (e) => {
  if (e.target.files[0]) openNewFile(e.target.files[0]);
});
document.getElementById("input-open-2").addEventListener("change", (e) => {
  if (e.target.files[0]) openNewFile(e.target.files[0]);
});
document.getElementById("input-merge").addEventListener("change", async (e) => {
  for (const file of e.target.files) await loadPdfFile(file, { replace: false });
});

document.getElementById("btn-insert-blank").addEventListener("click", insertBlankPage);
document.getElementById("btn-undo").addEventListener("click", undo);
document.getElementById("btn-clear").addEventListener("click", () => {
  if (!confirm("Start over? Everything you have done will be lost.")) return;
  state.documents.clear();
  state.pages = [];
  state.annotations.clear();
  state.runCache.clear();
  state.selectedPageIds.clear();
  state.activePageId = null;
  state.history = [];
  document.getElementById("btn-undo").disabled = true;
  document.getElementById("btn-download").disabled = true;
  document.getElementById("stage-empty").classList.remove("hidden");
  document.getElementById("stage-toolbar").classList.add("hidden");
  document.getElementById("stage-canvas-wrap").classList.add("hidden");
  renderRail();
});

document.getElementById("btn-rotate-left").addEventListener("click", () => rotatePages(-90));
document.getElementById("btn-rotate-right").addEventListener("click", () => rotatePages(90));
document.getElementById("btn-delete-pages").addEventListener("click", () => {
  const targets = currentTargets();
  if (targets.length === 0) return toast("Select a page first.");
  removePages(targets);
});

document.getElementById("btn-extract").addEventListener("click", extractSelection);
document.getElementById("btn-split").addEventListener("click", splitAllPages);
document.getElementById("btn-extract-text").addEventListener("click", extractAllText);

document.getElementById("btn-page-numbers").addEventListener("click", () => {
  document.getElementById("modal-pagenumbers").classList.remove("hidden");
});
document.getElementById("pn-cancel").addEventListener("click", () => {
  document.getElementById("modal-pagenumbers").classList.add("hidden");
});
document.getElementById("pn-apply").addEventListener("click", () => {
  const start = Number(document.getElementById("pn-start").value) || 1;
  const format = document.getElementById("pn-format").value;
  const position = document.getElementById("pn-position").value;
  applyPageNumbers({ start, format, position });
  document.getElementById("modal-pagenumbers").classList.add("hidden");
});

document.getElementById("btn-download").addEventListener("click", () => {
  exportAndDownload(state.pages, "edited-document.pdf");
});

let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (![...e.dataTransfer.types].includes("Files")) return;
  dragDepth++;
  document.getElementById("drop-veil").classList.remove("hidden");
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) document.getElementById("drop-veil").classList.add("hidden");
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.getElementById("drop-veil").classList.add("hidden");
  const file = e.dataTransfer.files[0];
  if (file) openNewFile(file);
});

window.addEventListener("resize", () => {
  if (state.activePageId) renderStagePage();
  if (window.innerWidth > 980) closeDrawers();
});

window.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName;
  const typing = tag === "TEXTAREA" || tag === "INPUT" || document.activeElement?.isContentEditable;
  if (typing) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undo();
  } else if ((e.key === "Delete" || e.key === "Backspace") && currentTargets().length) {
    e.preventDefault();
    removePages(currentTargets());
  } else if (e.key === "Escape") {
    closeDrawers();
  }
});

setActiveTool("select");
