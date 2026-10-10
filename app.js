/* =========================================================
   Foolscap: a fully client-side PDF editor.
   pdf.js reads and renders, pdf-lib writes, fontkit embeds real
   fonts, JSZip bundles bulk exports. Nothing leaves this tab.
   ========================================================= */
"use strict";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const {
  PDFDocument, PDFName, PDFNumber, PDFArray, PDFRawStream,
  rgb, degrees, StandardFonts, decodePDFRawStream,
} = PDFLib;

const HAS_FONTKIT = typeof window.fontkit !== "undefined";
const A4 = { width: 595.28, height: 841.89 };
const NS = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);
const COMPACT = () => window.innerWidth <= 1100;
const PHONE = () => window.innerWidth <= 700;

/* ---------------------------------------------------------
   State
--------------------------------------------------------- */
const state = {
  documents: new Map(),     // docId -> { name, pdfBytes, pdfjsDoc }
  pages: [],                // ordered working document
  annotations: new Map(),   // pageId -> annotation[]
  runCache: new Map(),      // pageId -> { textRuns, imageRegions } (PDF point space)
  viewportCache: new Map(), // pageId -> geometry helpers for the rendered page
  activePageId: null,
  selectedPageIds: new Set(),
  lastClickedIndex: -1,
  activeTool: "select",
  pendingImage: null,
  pendingImageTarget: null,
  selectedAnn: null,        // { pageId, id }
  zoom: 1,
  undoStack: [],
  redoStack: [],
  watermark: null,
  docName: "",
};

let uidCounter = 1;
const uid = (p) => `${p}${uidCounter++}`;

/* ---------------------------------------------------------
   Small helpers
--------------------------------------------------------- */
function toast(msg, ms = 2800) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), ms);
}

let busyCount = 0;
function setBusy(on) {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  $("busy-bar").classList.toggle("hidden", busyCount === 0);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function readFileAsArrayBuffer(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsArrayBuffer(file);
  });
}
function readFileAsDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}
function loadImageFromDataUrl(url) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = url;
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
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
function hexToRgbFloat(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function rgbToHex(r, g, b) {
  const c = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}
function baseName(name) {
  return (name || "document").replace(/\.pdf$/i, "");
}
async function newPdfDocument() {
  const doc = await PDFDocument.create();
  if (HAS_FONTKIT) doc.registerFontkit(window.fontkit);
  return doc;
}
function boundingBoxOf(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const left = Math.min(...xs), top = Math.min(...ys);
  return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}
const measureCtx = document.createElement("canvas").getContext("2d");
function familyStack(family) {
  if (family === "serif") return "Georgia, 'Times New Roman', 'Noto Serif Bengali', serif";
  if (family === "mono") return "'Courier New', ui-monospace, monospace";
  return "var(--font)";
}
function measureTextPt(text, size, family, bold, italic) {
  const fam = family === "serif" ? "Georgia, serif" : family === "mono" ? "'Courier New', monospace" : "Arial, sans-serif";
  measureCtx.font = `${italic ? "italic " : ""}${bold ? "700 " : "400 "}${size}px ${fam}`;
  return Math.max(...String(text).split("\n").map((l) => measureCtx.measureText(l).width));
}

/* ---------------------------------------------------------
   History (pages, annotations and watermark)
--------------------------------------------------------- */
function cloneAnn(a) {
  return { ...a, fontRef: a.fontRef ? { ...a.fontRef } : undefined };
}
function snapshot() {
  const ann = new Map();
  for (const [k, v] of state.annotations) ann.set(k, v.map(cloneAnn));
  return {
    pages: state.pages.map((p) => ({ ...p })),
    annotations: ann,
    watermark: state.watermark ? { ...state.watermark } : null,
  };
}
function commitSnapshot(snap) {
  state.undoStack.push(snap);
  if (state.undoStack.length > 60) state.undoStack.shift();
  state.redoStack = [];
  updateChrome();
}
function pushHistory() {
  commitSnapshot(snapshot());
}
function restoreSnapshot(s) {
  state.pages = s.pages;
  state.annotations = s.annotations;
  state.watermark = s.watermark;
  const ids = new Set(state.pages.map((p) => p.id));
  state.selectedPageIds = new Set([...state.selectedPageIds].filter((id) => ids.has(id)));
  if (!ids.has(state.activePageId)) state.activePageId = state.pages[0]?.id || null;
  state.selectedAnn = null;
  renderRail();
  updateChrome();
  if (state.activePageId) renderStagePage();
}
function undo() {
  const prev = state.undoStack.pop();
  if (!prev) return;
  state.redoStack.push(snapshot());
  restoreSnapshot(prev);
  toast("Undone");
}
function redo() {
  const next = state.redoStack.pop();
  if (!next) return;
  state.undoStack.push(snapshot());
  restoreSnapshot(next);
  toast("Redone");
}

/* ---------------------------------------------------------
   Chrome (buttons enabled/disabled, titles, empty state)
--------------------------------------------------------- */
function updateChrome() {
  const has = state.pages.length > 0;
  $("btn-download").disabled = !has;
  $("btn-compress").disabled = !has;
  $("btn-undo").disabled = state.undoStack.length === 0;
  $("btn-redo").disabled = state.redoStack.length === 0;
  $("stage-empty").classList.toggle("hidden", has);
  $("stage-ui").classList.toggle("hidden", !has);
  $("doc-name").textContent = has ? state.docName || "Untitled" : "No document open";
  $("doc-meta").textContent = has ? `${state.pages.length} page${state.pages.length === 1 ? "" : "s"}` : "";
  $("page-count").textContent = state.pages.length;
}

function setBusyBlock(promiseFn) {
  setBusy(true);
  return Promise.resolve()
    .then(promiseFn)
    .finally(() => setBusy(false));
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
    toast("Unsupported file type. Use a PDF, PNG or JPG.");
  }
}

async function loadPdfFile(file, { replace }) {
  setBusy(true);
  try {
    const buf = await readFileAsArrayBuffer(file);
    const bytes = new Uint8Array(buf.slice(0));
    const pdfjsDoc = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
    const docId = uid("doc");
    state.documents.set(docId, { name: file.name, pdfBytes: bytes, pdfjsDoc });

    const newPages = [];
    for (let i = 0; i < pdfjsDoc.numPages; i++) {
      newPages.push({ id: uid("page"), docId, srcIndex: i, rotation: 0, blank: false });
    }

    if (replace) {
      state.pages = newPages;
      state.selectedPageIds.clear();
      state.annotations.clear();
      state.runCache.clear();
      state.undoStack = [];
      state.redoStack = [];
      state.watermark = null;
      state.docName = file.name;
      state.zoom = 1;
    } else {
      pushHistory();
      state.pages = state.pages.concat(newPages);
      if (!state.docName) state.docName = file.name;
    }
    updateChrome();
    renderRail();
    await setActivePage(newPages[0]?.id || state.pages[0]?.id);
    toast(replace ? `Opened ${file.name}` : `Added ${pdfjsDoc.numPages} page(s) from ${file.name}`);
  } catch (err) {
    console.error(err);
    toast("Could not read that PDF. It may be password protected or damaged.", 4200);
  } finally {
    setBusy(false);
  }
}

async function imageToPdfAndLoad(file) {
  try {
    const dataUrl = await readFileAsDataURL(file);
    const doc = await newPdfDocument();
    const emb = /png/i.test(file.type) ? await doc.embedPng(dataUrl) : await doc.embedJpg(dataUrl);
    const page = doc.addPage([emb.width, emb.height]);
    page.drawImage(emb, { x: 0, y: 0, width: emb.width, height: emb.height });
    const bytes = await doc.save();
    const pseudo = new File([new Blob([bytes], { type: "application/pdf" })], file.name.replace(/\.\w+$/, "") + ".pdf", {
      type: "application/pdf",
    });
    await loadPdfFile(pseudo, { replace: state.pages.length === 0 });
  } catch (err) {
    console.error(err);
    toast("Could not convert that image.");
  }
}

/* ---------------------------------------------------------
   Rail (page thumbnails, lazy rendered and cached)
--------------------------------------------------------- */
const thumbCache = new Map();
let thumbObserver = null;

function thumbKey(page) {
  return page.blank ? `${page.id}|blank` : `${page.docId}:${page.srcIndex}|${page.rotation}`;
}

async function paintThumb(page, canvas) {
  const key = thumbKey(page);
  const ctx = canvas.getContext("2d");
  const cached = thumbCache.get(key);
  if (cached) {
    canvas.width = cached.width;
    canvas.height = cached.height;
    ctx.drawImage(cached, 0, 0);
    return;
  }
  const W = 220;
  if (page.blank) {
    const s = page.blankSize || A4;
    canvas.width = W;
    canvas.height = Math.round((s.height / s.width) * W);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  } else {
    const entry = state.documents.get(page.docId);
    if (!entry) return;
    const pdfPage = await entry.pdfjsDoc.getPage(page.srcIndex + 1);
    const rot = (pdfPage.rotate + page.rotation + 360) % 360;
    const base = pdfPage.getViewport({ scale: 1, rotation: rot });
    const vp = pdfPage.getViewport({ scale: W / base.width, rotation: rot });
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    await pdfPage.render({ canvasContext: ctx, viewport: vp }).promise;
  }
  const copy = document.createElement("canvas");
  copy.width = canvas.width;
  copy.height = canvas.height;
  copy.getContext("2d").drawImage(canvas, 0, 0);
  thumbCache.set(key, copy);
}

function renderRail() {
  const list = $("page-list");
  const empty = $("rail-empty");
  $("page-count").textContent = state.pages.length;
  if (thumbObserver) thumbObserver.disconnect();
  if (state.pages.length === 0) {
    list.innerHTML = "";
    list.appendChild(empty);
    return;
  }
  list.innerHTML = "";
  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        thumbObserver.unobserve(en.target);
        const page = state.pages.find((p) => p.id === en.target.dataset.pageId);
        if (page) paintThumb(page, en.target.querySelector("canvas")).catch(() => {});
      }
    },
    { root: list, rootMargin: "300px" }
  );

  state.pages.forEach((page, index) => {
    const card = document.createElement("div");
    card.className = "thumb";
    card.dataset.pageId = page.id;
    card.draggable = true;

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "thumb-check";
    check.setAttribute("aria-label", `Select page ${index + 1}`);
    check.addEventListener("click", (e) => {
      e.stopPropagation();
      if (check.checked) state.selectedPageIds.add(page.id);
      else state.selectedPageIds.delete(page.id);
      refreshRail();
    });

    const canvas = document.createElement("canvas");
    canvas.width = 220;
    canvas.height = 290;

    const foot = document.createElement("div");
    foot.className = "thumb-foot";
    const label = document.createElement("span");
    label.textContent = String(index + 1);
    const move = document.createElement("div");
    move.className = "thumb-move";
    const up = document.createElement("button");
    up.textContent = "\u25B2";
    up.title = "Move up";
    up.setAttribute("aria-label", "Move page up");
    up.addEventListener("click", (e) => { e.stopPropagation(); movePage(page.id, -1); });
    const down = document.createElement("button");
    down.textContent = "\u25BC";
    down.title = "Move down";
    down.setAttribute("aria-label", "Move page down");
    down.addEventListener("click", (e) => { e.stopPropagation(); movePage(page.id, 1); });
    move.append(up, down);
    foot.append(label, move);

    const remove = document.createElement("button");
    remove.className = "thumb-remove";
    remove.title = "Delete page";
    remove.setAttribute("aria-label", "Delete page");
    remove.innerHTML = '<svg class="i"><use href="#i-x"/></svg>';
    remove.addEventListener("click", (e) => { e.stopPropagation(); removePages([page.id]); });

    card.append(check, canvas, foot, remove);
    list.appendChild(card);
    thumbObserver.observe(card);

    card.addEventListener("click", (e) => {
      const idx = state.pages.findIndex((p) => p.id === page.id);
      if (e.shiftKey && state.lastClickedIndex >= 0) {
        const [a, b] = [state.lastClickedIndex, idx].sort((x, y) => x - y);
        for (let i = a; i <= b; i++) state.selectedPageIds.add(state.pages[i].id);
        refreshRail();
      } else if (e.ctrlKey || e.metaKey) {
        if (state.selectedPageIds.has(page.id)) state.selectedPageIds.delete(page.id);
        else state.selectedPageIds.add(page.id);
        refreshRail();
      }
      state.lastClickedIndex = idx;
      setActivePage(page.id);
      if (COMPACT() && !e.shiftKey && !e.ctrlKey && !e.metaKey) closeDrawers();
    });
    wireDragReorder(card, page.id);
  });
  refreshRail();
}

function refreshRail() {
  document.querySelectorAll(".thumb").forEach((card) => {
    const id = card.dataset.pageId;
    card.classList.toggle("active", id === state.activePageId);
    card.classList.toggle("selected", state.selectedPageIds.has(id));
    card.querySelector("input").checked = state.selectedPageIds.has(id);
  });
}

let dragSourceId = null;
function wireDragReorder(card, pageId) {
  card.addEventListener("dragstart", (e) => {
    dragSourceId = pageId;
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", pageId); } catch (_) {}
  });
  card.addEventListener("dragover", (e) => {
    if (!dragSourceId) return;
    e.preventDefault();
    card.classList.add("drag-over");
  });
  card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
  card.addEventListener("drop", (e) => {
    if (!dragSourceId) return;
    e.preventDefault();
    e.stopPropagation();
    card.classList.remove("drag-over");
    const from = state.pages.findIndex((p) => p.id === dragSourceId);
    const to = state.pages.findIndex((p) => p.id === pageId);
    dragSourceId = null;
    if (from === -1 || to === -1 || from === to) return;
    pushHistory();
    const [moved] = state.pages.splice(from, 1);
    state.pages.splice(to, 0, moved);
    renderRail();
    updatePager();
  });
  card.addEventListener("dragend", () => { dragSourceId = null; });
}

function movePage(id, dir) {
  const i = state.pages.findIndex((p) => p.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= state.pages.length) return;
  pushHistory();
  [state.pages[i], state.pages[j]] = [state.pages[j], state.pages[i]];
  renderRail();
  updatePager();
}

/* ---------------------------------------------------------
   Stage: rendering the active page
--------------------------------------------------------- */
let renderToken = 0;
let currentRenderTask = null;

const activePage = () => state.pages.find((p) => p.id === state.activePageId);

async function setActivePage(pageId) {
  if (!pageId) return;
  state.activePageId = pageId;
  state.selectedAnn = null;
  refreshRail();
  const card = document.querySelector(`.thumb[data-page-id="${pageId}"]`);
  if (card && card.scrollIntoView) card.scrollIntoView({ block: "nearest" });
  await renderStagePage();
}

function updatePager() {
  const idx = state.pages.findIndex((p) => p.id === state.activePageId);
  $("stage-hint").textContent = idx < 0 ? "" : `Page ${idx + 1} of ${state.pages.length}`;
  $("btn-prev").disabled = idx <= 0;
  $("btn-next").disabled = idx < 0 || idx >= state.pages.length - 1;
}

async function renderStagePage() {
  const token = ++renderToken;
  const page = activePage();
  const canvas = $("page-canvas");
  const frame = $("page-frame");
  if (!page) {
    canvas.width = 0;
    canvas.height = 0;
    $("overlay-layer").innerHTML = "";
    updatePager();
    return;
  }
  updatePager();

  const avail = Math.max(160, $("canvas-scroll").clientWidth - (COMPACT() ? 28 : 56));
  const cssW = Math.max(140, Math.min(900, avail) * state.zoom);
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const buf = document.createElement("canvas");
  let info;

  if (page.blank) {
    const s = page.blankSize || A4;
    const scale = cssW / s.width;
    const cssH = s.height * scale;
    buf.width = Math.round(cssW * dpr);
    buf.height = Math.round(cssH * dpr);
    const g = buf.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, buf.width, buf.height);
    info = {
      scale, rotation: 0, cssW, cssH, dpr,
      pageWidthPt: s.width, pageHeightPt: s.height,
      convertClickToPdf: (x, y) => [x / scale, s.height - y / scale],
      toPixel: (x, y) => [x * scale, (s.height - y) * scale],
    };
  } else {
    const entry = state.documents.get(page.docId);
    const pdfPage = await entry.pdfjsDoc.getPage(page.srcIndex + 1);
    if (token !== renderToken) return;
    const rot = (pdfPage.rotate + page.rotation + 360) % 360;
    const base = pdfPage.getViewport({ scale: 1, rotation: rot });
    const scale = cssW / base.width;
    const cssVp = pdfPage.getViewport({ scale, rotation: rot });
    const rVp = pdfPage.getViewport({ scale: scale * dpr, rotation: rot });
    buf.width = Math.round(rVp.width);
    buf.height = Math.round(rVp.height);
    if (currentRenderTask) {
      try { currentRenderTask.cancel(); } catch (_) {}
    }
    const task = pdfPage.render({ canvasContext: buf.getContext("2d"), viewport: rVp });
    currentRenderTask = task;
    try {
      await task.promise;
    } catch (e) {
      if (e && e.name === "RenderingCancelledException") return;
      throw e;
    }
    if (token !== renderToken) return;
    info = {
      scale, rotation: rot, cssW: cssVp.width, cssH: cssVp.height, dpr,
      pageWidthPt: base.width, pageHeightPt: base.height,
      pdfPage, viewport: cssVp,
      convertClickToPdf: (x, y) => cssVp.convertToPdfPoint(x, y),
      toPixel: (x, y) => cssVp.convertToViewportPoint(x, y),
    };
  }

  canvas.width = buf.width;
  canvas.height = buf.height;
  canvas.style.width = info.cssW + "px";
  canvas.style.height = info.cssH + "px";
  canvas.getContext("2d").drawImage(buf, 0, 0);
  frame.style.width = info.cssW + "px";
  frame.style.height = info.cssH + "px";
  state.viewportCache.set(page.id, info);
  $("zoom-value").textContent = Math.round(state.zoom * 100) + "%";

  renderOverlays(page.id);
  if (state.activeTool === "edit" && !page.blank) await renderEditTargets(page);
  else clearEditTargets();
}

/* Geometry for any page without rendering it (used by exports and auto placement) */
async function getPageGeometry(page) {
  if (page.blank) {
    const s = page.blankSize || A4;
    return { rot: 0, widthPt: s.width, heightPt: s.height, toPdf: (x, y) => [x, s.height - y] };
  }
  const entry = state.documents.get(page.docId);
  const pdfPage = await entry.pdfjsDoc.getPage(page.srcIndex + 1);
  const rot = (pdfPage.rotate + page.rotation + 360) % 360;
  const vp = pdfPage.getViewport({ scale: 1, rotation: rot });
  return { rot, widthPt: vp.width, heightPt: vp.height, toPdf: (x, y) => vp.convertToPdfPoint(x, y) };
}

/* ---------------------------------------------------------
   Annotation model helpers
   text      : xPt,yPt = baseline-left anchor, rot = page rotation at placement
   image     : xPt,yPt = bottom-left anchor, wPt,hPt, rot
   shape     : x0,y0,x1,y1 corner points
   textEdit  : replaces an existing run (ox,oy = original anchor, xPt,yPt = new anchor)
--------------------------------------------------------- */
const isShape = (a) => a.kind === "shape";
function getAnchors(a) {
  return isShape(a) ? [[a.x0, a.y0], [a.x1, a.y1]] : [[a.xPt, a.yPt]];
}
function setAnchors(a, pts) {
  if (isShape(a)) {
    [a.x0, a.y0] = pts[0];
    [a.x1, a.y1] = pts[1];
  } else {
    [a.xPt, a.yPt] = pts[0];
  }
}
function removeAnnotation(pageId, annId) {
  const list = state.annotations.get(pageId) || [];
  state.annotations.set(pageId, list.filter((a) => a.id !== annId));
}

/* ---------------------------------------------------------
   Overlays
--------------------------------------------------------- */
function renderOverlays(pageId) {
  const layer = $("overlay-layer");
  layer.querySelectorAll(".overlay-item,.overlay-cover,.watermark-preview").forEach((e) => e.remove());
  const info = state.viewportCache.get(pageId);
  if (!info) return;
  if (state.watermark) layer.appendChild(buildWatermarkEl(info));
  const anns = state.annotations.get(pageId) || [];
  for (const ann of anns) {
    for (const el of buildOverlayEls(pageId, ann, info)) layer.appendChild(el);
  }
  // keep edit targets on top
  layer.querySelectorAll(".edit-target").forEach((e) => layer.appendChild(e));
}

function makeRemoveBtn(pageId, ann) {
  const btn = document.createElement("button");
  btn.className = "overlay-remove";
  btn.title = ann.kind === "textEdit" ? "Revert to original" : "Remove";
  btn.setAttribute("aria-label", btn.title);
  btn.innerHTML = '<svg class="i"><use href="#i-x"/></svg>';
  btn.addEventListener("pointerdown", (e) => e.stopPropagation());
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    pushHistory();
    removeAnnotation(pageId, ann.id);
    renderOverlays(pageId);
    if (state.activeTool === "edit") {
      const page = state.pages.find((p) => p.id === pageId);
      if (page) renderEditTargets(page);
    }
  });
  return btn;
}

function buildOverlayEls(pageId, ann, info) {
  switch (ann.kind) {
    case "text": return [buildTextEl(pageId, ann, info)];
    case "image": return [buildImageEl(pageId, ann, info)];
    case "shape": return [buildShapeEl(pageId, ann, info, false)];
    case "textEdit": return buildTextEditEls(pageId, ann, info);
    default: return [];
  }
}

function newOverlayItem(kind, ann) {
  const el = document.createElement("div");
  el.className = `overlay-item overlay-${kind}`;
  if (state.selectedAnn && state.selectedAnn.id === ann.id) el.classList.add("selected");
  return el;
}

function buildTextEl(pageId, ann, info) {
  const el = newOverlayItem("text", ann);
  const [px, py] = info.toPixel(ann.xPt, ann.yPt);
  const fs = ann.size * info.scale;
  el.style.left = px + "px";
  el.style.top = py - fs * 0.92 + "px";
  const inner = document.createElement("div");
  inner.className = "overlay-text-inner";
  inner.textContent = ann.text;
  inner.style.fontSize = fs + "px";
  inner.style.lineHeight = "1.2";
  inner.style.color = ann.color;
  inner.style.fontFamily = familyStack(ann.family);
  inner.style.fontWeight = ann.bold ? "700" : "400";
  inner.style.fontStyle = ann.italic ? "italic" : "normal";
  el.append(inner, makeRemoveBtn(pageId, ann));
  attachInteractions(el, pageId, ann, info, {});
  return el;
}

function buildImageEl(pageId, ann, info) {
  const el = newOverlayItem("image", ann);
  const [px, py] = info.toPixel(ann.xPt, ann.yPt);
  el.style.left = px + "px";
  el.style.top = py - ann.hPt * info.scale + "px";
  el.style.width = ann.wPt * info.scale + "px";
  el.style.height = ann.hPt * info.scale + "px";
  el.style.opacity = ann.opacity;
  const img = document.createElement("img");
  img.src = ann.dataUrl;
  img.draggable = false;
  img.style.cssText = "width:100%;height:100%;display:block;pointer-events:none;";
  const handle = document.createElement("div");
  handle.className = "overlay-resize";
  el.append(img, makeRemoveBtn(pageId, ann), handle);
  attachInteractions(el, pageId, ann, info, { resizeImage: handle });
  return el;
}

function buildShapeEl(pageId, ann, info, preview) {
  const P0 = info.toPixel(ann.x0, ann.y0);
  const P1 = info.toPixel(ann.x1, ann.y1);
  const bb = boundingBoxOf([P0, P1]);
  const sw = (ann.strokeWidth || 0) * info.scale;
  const pad = ann.shape === "line" ? 8 : Math.ceil(sw / 2) + 1;
  const el = preview ? document.createElement("div") : newOverlayItem("shape", ann);
  if (preview) el.className = "overlay-preview";
  el.style.left = bb.left - pad + "px";
  el.style.top = bb.top - pad + "px";
  el.style.width = bb.width + pad * 2 + "px";
  el.style.height = bb.height + pad * 2 + "px";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", bb.width + pad * 2);
  svg.setAttribute("height", bb.height + pad * 2);
  svg.style.pointerEvents = "none";
  const fill = ann.fillOn && ann.shape !== "line" ? ann.fill : "none";
  const stroke = ann.strokeWidth > 0 ? ann.stroke : "none";
  let shape;
  if (ann.shape === "ellipse") {
    shape = document.createElementNS(NS, "ellipse");
    shape.setAttribute("cx", pad + bb.width / 2);
    shape.setAttribute("cy", pad + bb.height / 2);
    shape.setAttribute("rx", bb.width / 2);
    shape.setAttribute("ry", bb.height / 2);
  } else if (ann.shape === "line") {
    shape = document.createElementNS(NS, "line");
    shape.setAttribute("x1", P0[0] - bb.left + pad);
    shape.setAttribute("y1", P0[1] - bb.top + pad);
    shape.setAttribute("x2", P1[0] - bb.left + pad);
    shape.setAttribute("y2", P1[1] - bb.top + pad);
    shape.setAttribute("stroke-linecap", "round");
  } else {
    shape = document.createElementNS(NS, "rect");
    shape.setAttribute("x", pad);
    shape.setAttribute("y", pad);
    shape.setAttribute("width", bb.width);
    shape.setAttribute("height", bb.height);
  }
  shape.setAttribute("fill", fill);
  shape.setAttribute("fill-opacity", ann.fillOpacity);
  shape.setAttribute("stroke", stroke);
  shape.setAttribute("stroke-width", sw);
  svg.appendChild(shape);
  el.appendChild(svg);
  if (!preview) {
    const handle = document.createElement("div");
    handle.className = "overlay-resize";
    el.append(makeRemoveBtn(pageId, ann), handle);
    attachInteractions(el, pageId, ann, info, { resizeShape: handle });
  }
  return el;
}

function coverRectPt(ann) {
  const moved = Math.abs(ann.xPt - ann.ox) > 0.5 || Math.abs(ann.yPt - ann.oy) > 0.5;
  const w = (moved ? ann.wPt : Math.max(ann.wPt, ann.coverW || 0)) + 2;
  return { x: ann.ox - 1, y: ann.oy - ann.size * 0.3, w, h: ann.size * 1.65 };
}

function buildTextEditEls(pageId, ann, info) {
  const c = coverRectPt(ann);
  const bb = boundingBoxOf([
    info.toPixel(c.x, c.y), info.toPixel(c.x + c.w, c.y),
    info.toPixel(c.x, c.y + c.h), info.toPixel(c.x + c.w, c.y + c.h),
  ]);
  const cover = document.createElement("div");
  cover.className = "overlay-cover";
  cover.style.cssText = `left:${bb.left}px;top:${bb.top}px;width:${bb.width}px;height:${bb.height}px;background:${ann.bgColor};`;

  const el = newOverlayItem("textedit", ann);
  const [px, py] = info.toPixel(ann.xPt, ann.yPt);
  const fs = ann.size * info.scale;
  const w = Math.max(measureTextPt(ann.newText || " ", ann.size, ann.fontRef.family, ann.fontRef.bold, ann.fontRef.italic), 6) * info.scale;
  el.style.left = px + "px";
  el.style.top = py + "px";
  el.style.width = w + "px";
  el.style.height = fs * 0.3 + "px";
  el.style.transformOrigin = "0 0";
  if (info.rotation) el.style.transform = `rotate(${info.rotation}deg)`;
  const inner = document.createElement("div");
  inner.className = "overlay-text-inner";
  inner.textContent = ann.newText || "\u00a0";
  inner.style.cssText += `position:absolute;left:0;top:${-fs * 0.82}px;line-height:1;`;
  inner.style.fontSize = fs + "px";
  inner.style.color = ann.color;
  inner.style.fontFamily = familyStack(ann.fontRef.family);
  inner.style.fontWeight = ann.fontRef.bold ? "700" : "400";
  inner.style.fontStyle = ann.fontRef.italic ? "italic" : "normal";
  el.append(inner, makeRemoveBtn(pageId, ann));
  attachInteractions(el, pageId, ann, info, {
    onClick: () => {
      if (state.activeTool === "edit") openInlineEditor(pageId, ann.runId, ann);
    },
  });
  return [cover, el];
}

function buildWatermarkEl(info) {
  const wm = state.watermark;
  const el = document.createElement("div");
  el.className = "watermark-preview";
  el.textContent = wm.text;
  el.style.fontSize = wm.size * info.scale + "px";
  el.style.color = wm.color;
  el.style.opacity = wm.opacity;
  el.style.transform = `translate(-50%,-50%) rotate(${-wm.angle}deg)`;
  return el;
}

/* Pointer interactions shared by all overlay items */
function attachInteractions(el, pageId, ann, info, opts) {
  const select = () => {
    state.selectedAnn = { pageId, id: ann.id };
    document.querySelectorAll(".overlay-item.selected").forEach((n) => n.classList.remove("selected"));
    el.classList.add("selected");
  };

  el.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".overlay-remove") || e.target.closest(".overlay-resize")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    select();
    const sx = e.clientX, sy = e.clientY;
    const snap = snapshot();
    const base = getAnchors(ann).map((p) => p.slice());
    let moved = false;
    const move = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      if (moved) el.style.translate = `${dx}px ${dy}px`;
    };
    const up = (ev) => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
      if (moved) {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        const pts = base.map(([x, y]) => {
          const [px, py] = info.toPixel(x, y);
          return info.convertClickToPdf(px + dx, py + dy);
        });
        setAnchors(ann, pts);
        commitSnapshot(snap);
        renderOverlays(pageId);
        if (state.activeTool === "edit") {
          const pg = state.pages.find((p) => p.id === pageId);
          if (pg) renderEditTargets(pg);
        }
      } else if (opts.onClick) {
        opts.onClick();
      }
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
  });

  if (opts.resizeImage) {
    opts.resizeImage.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const sx = e.clientX;
      const w0 = ann.wPt, h0 = ann.hPt;
      const bottom = parseFloat(el.style.top) + h0 * info.scale;
      const snap = snapshot();
      let nw = w0;
      const move = (ev) => {
        nw = Math.max(8, w0 + (ev.clientX - sx) / info.scale);
        const nh = nw * (h0 / w0);
        el.style.width = nw * info.scale + "px";
        el.style.height = nh * info.scale + "px";
        el.style.top = bottom - nh * info.scale + "px";
      };
      const up = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        document.removeEventListener("pointercancel", up);
        if (nw !== w0) {
          ann.wPt = nw;
          ann.hPt = nw * (h0 / w0);
          commitSnapshot(snap);
        }
        renderOverlays(pageId);
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
      document.addEventListener("pointercancel", up);
    });
  }

  if (opts.resizeShape) {
    opts.resizeShape.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const sx = e.clientX, sy = e.clientY;
      const snap = snapshot();
      const P = getAnchors(ann).map(([x, y]) => info.toPixel(x, y));
      const maxX = Math.max(...P.map((p) => p[0]));
      const maxY = Math.max(...P.map((p) => p[1]));
      let changed = false;
      const apply = (dx, dy) => {
        const pts = P.map(([px, py]) =>
          info.convertClickToPdf(px >= maxX - 0.01 ? px + dx : px, py >= maxY - 0.01 ? py + dy : py)
        );
        setAnchors(ann, pts);
      };
      const move = (ev) => {
        changed = true;
        apply(ev.clientX - sx, ev.clientY - sy);
        renderOverlays(pageId);
      };
      const up = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        document.removeEventListener("pointercancel", up);
        if (changed) commitSnapshot(snap);
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
      document.addEventListener("pointercancel", up);
    });
  }
}

/* ---------------------------------------------------------
   Placing content on the page: click (text, image), drag (shapes)
--------------------------------------------------------- */
function activeSeg(containerId, attr) {
  const b = document.querySelector(`#${containerId} .active`);
  return b ? b.dataset[attr] : null;
}

function currentShapeStyle(tool) {
  if (tool === "highlight") {
    return {
      shape: "rect", stroke: "#000000", strokeWidth: 0, fillOn: true,
      fill: activeSeg("hl-swatches", "color") || "#FFE066",
      fillOpacity: Number($("hl-opacity").value) / 100, highlight: true,
    };
  }
  if (tool === "redact") {
    return { shape: "rect", stroke: "#000000", strokeWidth: 0, fillOn: true, fill: "#000000", fillOpacity: 1, redact: true };
  }
  return {
    shape: activeSeg("shape-kind", "shape") || "rect",
    stroke: $("shape-stroke").value,
    strokeWidth: Number($("shape-width").value),
    fillOn: $("shape-fill-on").checked,
    fill: $("shape-fill").value,
    fillOpacity: Number($("shape-opacity").value) / 100,
  };
}

const layerEl = $("overlay-layer");
let drawing = null;

layerEl.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  if (e.target.closest(".overlay-item,.edit-target,.inline-editor")) return;
  state.selectedAnn = null;
  document.querySelectorAll(".overlay-item.selected").forEach((n) => n.classList.remove("selected"));
  const tool = state.activeTool;
  if (!["shape", "highlight", "redact"].includes(tool)) return;
  const page = activePage();
  const info = page && state.viewportCache.get(page.id);
  if (!info) return;
  const rect = layerEl.getBoundingClientRect();
  drawing = { pageId: page.id, info, start: [e.clientX - rect.left, e.clientY - rect.top], preview: null, tool };
  layerEl.setPointerCapture(e.pointerId);
  e.preventDefault();
});

function drawingAnn(end) {
  const { info, start, tool } = drawing;
  const a = info.convertClickToPdf(start[0], start[1]);
  const b = info.convertClickToPdf(end[0], end[1]);
  return { id: uid("ann"), kind: "shape", x0: a[0], y0: a[1], x1: b[0], y1: b[1], ...currentShapeStyle(tool) };
}

layerEl.addEventListener("pointermove", (e) => {
  if (!drawing) return;
  const rect = layerEl.getBoundingClientRect();
  const end = [e.clientX - rect.left, e.clientY - rect.top];
  if (drawing.preview) drawing.preview.remove();
  drawing.preview = buildShapeEl(drawing.pageId, drawingAnn(end), drawing.info, true);
  layerEl.appendChild(drawing.preview);
});

function finishDrawing(e) {
  if (!drawing) return;
  const d = drawing;
  drawing = null;
  if (d.preview) d.preview.remove();
  try { layerEl.releasePointerCapture(e.pointerId); } catch (_) {}
  const rect = layerEl.getBoundingClientRect();
  const end = [e.clientX - rect.left, e.clientY - rect.top];
  if (Math.hypot(end[0] - d.start[0], end[1] - d.start[1]) < 4) return;
  drawing = d;
  const ann = drawingAnn(end);
  drawing = null;
  pushHistory();
  const list = state.annotations.get(d.pageId) || [];
  list.push(ann);
  state.annotations.set(d.pageId, list);
  renderOverlays(d.pageId);
}
layerEl.addEventListener("pointerup", finishDrawing);
layerEl.addEventListener("pointercancel", () => {
  if (drawing && drawing.preview) drawing.preview.remove();
  drawing = null;
});

layerEl.addEventListener("click", async (e) => {
  if (e.target.closest(".overlay-item,.edit-target,.inline-editor")) return;
  const page = activePage();
  const info = page && state.viewportCache.get(page.id);
  if (!info) return;
  const rect = layerEl.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;

  if (state.activeTool === "text") {
    const text = $("text-input").value;
    if (!text.trim()) return toast("Type some text in the options panel first.");
    const size = Number($("text-size").value);
    const [xPt, yPt] = info.convertClickToPdf(cx, cy + size * info.scale * 0.92);
    pushHistory();
    const list = state.annotations.get(page.id) || [];
    list.push({
      id: uid("ann"), kind: "text", text, size,
      color: $("text-color").value,
      family: activeSeg("text-family", "family") || "sans",
      bold: document.querySelector('#text-style [data-style="bold"]').classList.contains("active"),
      italic: document.querySelector('#text-style [data-style="italic"]').classList.contains("active"),
      xPt, yPt, rot: info.rotation,
    });
    state.annotations.set(page.id, list);
    renderOverlays(page.id);
  } else if (state.activeTool === "image" && state.pendingImage) {
    const { dataUrl, img } = state.pendingImage;
    const opacity = Number($("image-opacity").value) / 100;
    const all = $("image-all-pages").checked;
    const wPt = Math.min(200, info.pageWidthPt * 0.4);
    const hPt = wPt * (img.height / img.width);
    const fx = cx / info.cssW, fy = cy / info.cssH;
    const targets = all ? state.pages : [page];
    pushHistory();
    for (const p of targets) {
      const g = await getPageGeometry(p);
      const [xPt, yPt] = g.toPdf(fx * g.widthPt, fy * g.heightPt + hPt);
      const list = state.annotations.get(p.id) || [];
      list.push({ id: uid("ann"), kind: "image", dataUrl, opacity, xPt, yPt, wPt, hPt, rot: g.rot });
      state.annotations.set(p.id, list);
    }
    renderOverlays(page.id);
    if (all) toast(`Stamped on all ${state.pages.length} pages`);
  }
});

/* ---------------------------------------------------------
   Detecting existing text and images (PDF point space)
--------------------------------------------------------- */
async function getRunData(page) {
  if (page.blank) return { textRuns: [], imageRegions: [] };
  if (state.runCache.has(page.id)) return state.runCache.get(page.id);

  const entry = state.documents.get(page.docId);
  const pdfPage = await entry.pdfjsDoc.getPage(page.srcIndex + 1);

  const textRuns = [];
  const content = await pdfPage.getTextContent();
  for (const item of content.items) {
    if (!item.str || !item.str.trim()) continue;
    const tx = item.transform;
    textRuns.push({
      id: uid("run"), str: item.str,
      xPt: tx[4], yPt: tx[5],
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
      if (fn === OPS.save) stack.push(ctm.slice());
      else if (fn === OPS.restore) ctm = stack.pop() || ctm;
      else if (fn === OPS.transform) ctm = pdfjsLib.Util.transform(ctm, args);
      else if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat || fn === OPS.paintInlineImageXObject) {
        const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map((p) => pdfjsLib.Util.applyTransform(p, ctm));
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        const xPt = Math.min(...xs), yPt = Math.min(...ys);
        const wPt = Math.max(...xs) - xPt, hPt = Math.max(...ys) - yPt;
        if (wPt > 6 && hPt > 6) imageRegions.push({ id: uid("img"), xPt, yPt, wPt, hPt });
      }
    }
  } catch (err) {
    console.warn("Image scan failed", err);
  }

  const data = { textRuns, imageRegions };
  state.runCache.set(page.id, data);
  return data;
}

function guessFontStyle(fontObj) {
  const names = [fontObj && fontObj.name, fontObj && fontObj.fallbackName, fontObj && fontObj.loadedName]
    .filter(Boolean).join(" ").toLowerCase();
  const bold = /bold|black|heavy|semibold|demi/.test(names);
  const italic = /italic|oblique/.test(names);
  let family = "sans";
  if (/times|georgia|garamond|minion|cambria|book|roman|serif/.test(names) && !/sans/.test(names)) family = "serif";
  if (fontObj && fontObj.fallbackName === "serif") family = "serif";
  if (/courier|mono|consolas|typewriter/.test(names) || (fontObj && fontObj.fallbackName === "monospace")) family = "mono";
  return { family, bold, italic };
}

/* Sample ink and background colour from the rendered canvas */
function sampleColors(box, info) {
  const canvas = $("page-canvas");
  const ctx = canvas.getContext("2d");
  const k = canvas.width / info.cssW;
  const x = Math.max(0, Math.floor(box.left * k));
  const y = Math.max(0, Math.floor(box.top * k));
  const w = Math.max(1, Math.min(canvas.width - x, Math.ceil(box.width * k)));
  const h = Math.max(1, Math.min(canvas.height - y, Math.ceil(box.height * k)));
  try {
    const data = ctx.getImageData(x, y, w, h).data;
    const counts = new Map();
    for (let i = 0; i < data.length; i += 4) {
      const key = `${data[i] >> 4}-${data[i + 1] >> 4}-${data[i + 2] >> 4}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    let bgKey = null, best = -1;
    for (const [kk, c] of counts) if (c > best) { best = c; bgKey = kk; }
    const [br, bg, bb] = bgKey.split("-").map((v) => parseInt(v, 10) * 16 + 8);
    const bgLum = 0.299 * br + 0.587 * bg + 0.114 * bb;
    let rs = 0, gs = 0, bs = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (Math.abs(lum - bgLum) > 90) { rs += data[i]; gs += data[i + 1]; bs += data[i + 2]; n++; }
    }
    // Quantising to 16 levels would tint plain white pages, so snap near-white to pure white
    const bgHex = bgLum > 244 ? "#FFFFFF" : rgbToHex(br, bg, bb);
    const ink = n > 0 ? rgbToHex(rs / n, gs / n, bs / n) : bgLum > 128 ? "#111827" : "#F5F5F5";
    return { ink, bg: bgHex };
  } catch (err) {
    return { ink: "#111827", bg: "#FFFFFF" };
  }
}

/* ---------------------------------------------------------
   Edit mode: hover targets and the inline editor
--------------------------------------------------------- */
function clearEditTargets() {
  document.querySelectorAll(".edit-target").forEach((el) => el.remove());
}

async function renderEditTargets(page) {
  clearEditTargets();
  const info = state.viewportCache.get(page.id);
  if (!info) return;
  const { textRuns, imageRegions } = await getRunData(page);
  if (state.activePageId !== page.id) return;
  const anns = state.annotations.get(page.id) || [];
  const edited = new Set(anns.filter((a) => a.kind === "textEdit").map((a) => a.runId));
  const replaced = new Set(anns.filter((a) => a.kind === "image" && a.replacesRegionId).map((a) => a.replacesRegionId));

  for (const run of textRuns) {
    if (edited.has(run.id)) continue;
    const box = runPixelBox(run, info);
    const el = document.createElement("div");
    el.className = "edit-target";
    el.style.cssText = `left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;`;
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      openInlineEditor(page.id, run.id, null, run, box);
    });
    layerEl.appendChild(el);
  }

  for (const r of imageRegions) {
    if (replaced.has(r.id)) continue;
    const box = boundingBoxOf([
      info.toPixel(r.xPt, r.yPt), info.toPixel(r.xPt + r.wPt, r.yPt),
      info.toPixel(r.xPt, r.yPt + r.hPt), info.toPixel(r.xPt + r.wPt, r.yPt + r.hPt),
    ]);
    const el = document.createElement("div");
    el.className = "edit-target is-image";
    el.style.cssText = `left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;`;
    const badge = document.createElement("span");
    badge.className = "edit-badge";
    badge.textContent = "Replace image";
    el.appendChild(badge);
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      state.pendingImageTarget = { pageId: page.id, region: r };
      imageReplaceInput.click();
    });
    layerEl.appendChild(el);
  }
}

function runPixelBox(run, info) {
  const padT = run.heightPt * 0.25, padB = run.heightPt * 0.22;
  return boundingBoxOf([
    info.toPixel(run.xPt, run.yPt - padB), info.toPixel(run.xPt + run.widthPt, run.yPt - padB),
    info.toPixel(run.xPt, run.yPt + run.heightPt + padT), info.toPixel(run.xPt + run.widthPt, run.yPt + run.heightPt + padT),
  ]);
}

async function openInlineEditor(pageId, runId, existingAnn, runArg, boxArg) {
  const page = state.pages.find((p) => p.id === pageId);
  const info = state.viewportCache.get(pageId);
  if (!page || !info) return;
  const { textRuns } = await getRunData(page);
  const run = runArg || textRuns.find((r) => r.id === runId);
  if (!run) return;
  const box = boxArg || runPixelBox(run, info);

  let fontRef = existingAnn && existingAnn.fontRef;
  if (!fontRef) {
    let guess = { family: "sans", bold: false, italic: false };
    try { guess = guessFontStyle(info.pdfPage.commonObjs.get(run.fontName)); } catch (_) {}
    fontRef = { docId: page.docId, fontName: run.fontName, pageNum: run.pageNum, ...guess };
  }
  const colors = existingAnn ? { ink: existingAnn.color, bg: existingAnn.bgColor } : sampleColors(box, info);

  layerEl.querySelectorAll(".inline-editor").forEach((n) => n.remove());
  const editor = document.createElement("textarea");
  editor.className = "inline-editor";
  editor.rows = 1;
  editor.value = existingAnn ? existingAnn.newText : run.str;
  editor.style.cssText = `left:${box.left}px;top:${box.top}px;min-width:${Math.max(box.width, 40)}px;height:${Math.max(box.height, 20)}px;` +
    `font-size:${box.height * 0.76}px;color:${colors.ink};background:${colors.bg};`;
  editor.style.fontFamily = familyStack(fontRef.family);
  editor.style.fontWeight = fontRef.bold ? "700" : "400";
  editor.style.fontStyle = fontRef.italic ? "italic" : "normal";
  const grow = () => { editor.style.width = Math.max(box.width, editor.value.length * box.height * 0.5 + 12) + "px"; };
  grow();
  editor.addEventListener("input", grow);
  layerEl.appendChild(editor);
  editor.focus();
  editor.select();

  const snap = snapshot();
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const text = editor.value.replace(/\n/g, " ");
    editor.remove();
    const list = state.annotations.get(pageId) || [];
    if (existingAnn) {
      if (text === run.str) {
        state.annotations.set(pageId, list.filter((a) => a.id !== existingAnn.id));
        commitSnapshot(snap);
      } else if (text !== existingAnn.newText) {
        existingAnn.newText = text;
        existingAnn.coverW = measureTextPt(text, existingAnn.size, fontRef.family, fontRef.bold, fontRef.italic);
        commitSnapshot(snap);
      }
    } else if (text !== run.str) {
      const size = run.heightPt * 0.92;
      list.push({
        id: uid("ann"), kind: "textEdit", runId: run.id,
        originalStr: run.str, newText: text,
        ox: run.xPt, oy: run.yPt, xPt: run.xPt, yPt: run.yPt,
        wPt: run.widthPt, size,
        coverW: measureTextPt(text, size, fontRef.family, fontRef.bold, fontRef.italic),
        color: colors.ink, bgColor: colors.bg, fontRef,
      });
      state.annotations.set(pageId, list);
      commitSnapshot(snap);
    }
    renderOverlays(pageId);
    renderEditTargets(page);
  };
  editor.addEventListener("blur", commit);
  editor.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); editor.blur(); }
    if (e.key === "Escape") { done = true; editor.remove(); }
    e.stopPropagation();
  });
}

/* Replacing an existing image */
const imageReplaceInput = document.createElement("input");
imageReplaceInput.type = "file";
imageReplaceInput.accept = "image/png,image/jpeg";
imageReplaceInput.hidden = true;
document.body.appendChild(imageReplaceInput);
imageReplaceInput.addEventListener("change", async () => {
  const file = imageReplaceInput.files[0];
  const target = state.pendingImageTarget;
  imageReplaceInput.value = "";
  if (!file || !target) return;
  const dataUrl = await readFileAsDataURL(file);
  const { pageId, region } = target;
  const page = state.pages.find((p) => p.id === pageId);
  const g = page ? await getPageGeometry(page) : { rot: 0 };
  pushHistory();
  const list = state.annotations.get(pageId) || [];
  list.push({
    id: uid("ann"), kind: "image", dataUrl, opacity: 1,
    xPt: region.xPt, yPt: region.yPt, wPt: region.wPt, hPt: region.hPt,
    rot: 0, replacesRegionId: region.id,
  });
  state.annotations.set(pageId, list);
  state.pendingImageTarget = null;
  renderOverlays(pageId);
  if (page && state.activeTool === "edit") renderEditTargets(page);
  toast("Image replaced. Drag or resize it if needed.");
});

/* ---------------------------------------------------------
   Tools, panels and the signature pad
--------------------------------------------------------- */
const TOOL_TITLES = {
  select: "Select", edit: "Edit existing", text: "Add text", image: "Image",
  shape: "Shape", highlight: "Highlight", redact: "Redact", sign: "Signature",
};

function setActiveTool(tool) {
  state.activeTool = tool;
  document.querySelectorAll(".dock-btn").forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
  document.querySelectorAll(".panel-section").forEach((s) => s.classList.add("hidden"));
  $("panel-" + tool).classList.remove("hidden");
  $("panel-title").textContent = TOOL_TITLES[tool];
  layerEl.classList.toggle("tool-draw", ["shape", "highlight", "redact"].includes(tool));
  layerEl.classList.toggle("tool-place", ["text", "image"].includes(tool));
  const page = activePage();
  if (page) {
    if (tool === "edit" && !page.blank) renderEditTargets(page);
    else clearEditTargets();
    if (tool === "edit" && page.blank) toast("Blank pages have no existing content to edit.");
  }
  if (COMPACT() && ["text", "image", "sign"].includes(tool)) openDrawer("panel");
}

document.querySelectorAll(".dock-btn").forEach((b) => b.addEventListener("click", () => setActiveTool(b.dataset.tool)));

function wireExclusive(selector) {
  document.querySelectorAll(selector).forEach((btn) =>
    btn.addEventListener("click", () => {
      document.querySelectorAll(selector).forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    })
  );
}
wireExclusive("#text-family .seg");
wireExclusive("#shape-kind .seg");
wireExclusive("#hl-swatches .swatch");
document.querySelectorAll("#text-style .seg").forEach((b) => b.addEventListener("click", () => b.classList.toggle("active")));

function bindRange(id, outId, fmt) {
  const el = $(id);
  const out = $(outId);
  const upd = () => (out.textContent = fmt(el.value));
  el.addEventListener("input", upd);
  upd();
}
bindRange("text-size", "text-size-value", (v) => `${v} pt`);
bindRange("image-opacity", "image-opacity-value", (v) => `${v}%`);
bindRange("shape-width", "shape-width-value", (v) => `${v} pt`);
bindRange("shape-opacity", "shape-opacity-value", (v) => `${v}%`);
bindRange("hl-opacity", "hl-opacity-value", (v) => `${v}%`);
bindRange("wm-size", "wm-size-value", (v) => `${v} pt`);
bindRange("wm-angle", "wm-angle-value", (v) => `${v}\u00b0`);
bindRange("wm-opacity", "wm-opacity-value", (v) => `${v}%`);
bindRange("cq", "cq-value", (v) => `${v}%`);
bindRange("cq2", "cq2-value", (v) => `${v}%`);

$("image-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const dataUrl = await readFileAsDataURL(file);
  const img = await loadImageFromDataUrl(dataUrl);
  setPendingImage(dataUrl, img);
  toast("Click the page to place the image.");
});
function setPendingImage(dataUrl, img) {
  state.pendingImage = { dataUrl, img };
  $("image-preview").src = dataUrl;
  $("image-preview-wrap").classList.remove("hidden");
}

/* Signature pad */
(function setupSignaturePad() {
  const canvas = $("sign-pad");
  const ctx = canvas.getContext("2d");
  let drawingSig = false;
  let ink = "#111827";
  const style = () => {
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = ink;
  };
  style();
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) * canvas.width) / r.width, ((e.clientY - r.top) * canvas.height) / r.height];
  };
  canvas.addEventListener("pointerdown", (e) => {
    drawingSig = true;
    canvas.setPointerCapture(e.pointerId);
    style();
    const [x, y] = pos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 0.01, y);
    ctx.stroke();
    e.preventDefault();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drawingSig) return;
    const [x, y] = pos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  });
  const end = () => { drawingSig = false; };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  document.querySelectorAll("#sign-inks .swatch").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll("#sign-inks .swatch").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      ink = b.dataset.color;
    })
  );
  $("btn-sign-clear").addEventListener("click", () => ctx.clearRect(0, 0, canvas.width, canvas.height));
  $("btn-sign-use").addEventListener("click", async () => {
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        if (data[(y * canvas.width + x) * 4 + 3] > 10) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return toast("Draw your signature first.");
    const pad = 6;
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(canvas.width - 1, maxX + pad); maxY = Math.min(canvas.height - 1, maxY + pad);
    const out = document.createElement("canvas");
    out.width = maxX - minX + 1;
    out.height = maxY - minY + 1;
    out.getContext("2d").drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
    const dataUrl = out.toDataURL("image/png");
    const img = await loadImageFromDataUrl(dataUrl);
    setActiveTool("image");
    setPendingImage(dataUrl, img);
    toast("Click the page to place your signature.");
  });
})();

/* ---------------------------------------------------------
   Page level operations
--------------------------------------------------------- */
function currentTargets() {
  if (state.selectedPageIds.size > 0) return state.pages.filter((p) => state.selectedPageIds.has(p.id)).map((p) => p.id);
  return state.activePageId ? [state.activePageId] : [];
}

function rotatePages(delta) {
  const targets = currentTargets();
  if (!targets.length) return;
  pushHistory();
  for (const id of targets) {
    const p = state.pages.find((x) => x.id === id);
    if (p && !p.blank) p.rotation = (p.rotation + delta + 360) % 360;
  }
  renderRail();
  renderStagePage();
}

function removePages(ids) {
  if (!ids.length) return;
  pushHistory();
  const set = new Set(ids);
  const oldIndex = state.pages.findIndex((p) => p.id === state.activePageId);
  state.pages = state.pages.filter((p) => !set.has(p.id));
  ids.forEach((id) => {
    state.selectedPageIds.delete(id);
    state.annotations.delete(id);
    state.runCache.delete(id);
  });
  if (set.has(state.activePageId)) {
    state.activePageId = state.pages[Math.min(Math.max(oldIndex, 0), state.pages.length - 1)]?.id || null;
  }
  updateChrome();
  renderRail();
  renderStagePage();
}

function insertBlankPage() {
  pushHistory();
  const page = { id: uid("page"), docId: null, srcIndex: -1, rotation: 0, blank: true, blankSize: A4 };
  const idx = state.pages.findIndex((p) => p.id === state.activePageId);
  if (idx === -1) state.pages.push(page);
  else state.pages.splice(idx + 1, 0, page);
  updateChrome();
  renderRail();
  setActivePage(page.id);
}

function duplicatePages() {
  const targets = currentTargets();
  if (!targets.length) return toast("Open a document first.");
  pushHistory();
  const set = new Set(targets);
  const next = [];
  for (const p of state.pages) {
    next.push(p);
    if (set.has(p.id)) {
      const copy = { ...p, id: uid("page") };
      next.push(copy);
      state.annotations.set(copy.id, (state.annotations.get(p.id) || []).map((a) => ({ ...cloneAnn(a), id: uid("ann") })));
    }
  }
  state.pages = next;
  updateChrome();
  renderRail();
  toast(`Duplicated ${targets.length} page${targets.length === 1 ? "" : "s"}`);
}

/* ---------------------------------------------------------
   Writing the output PDF
--------------------------------------------------------- */
function pickStandardFont(family, bold, italic) {
  if (family === "serif") {
    return bold && italic ? StandardFonts.TimesRomanBoldItalic : bold ? StandardFonts.TimesRomanBold : italic ? StandardFonts.TimesRomanItalic : StandardFonts.TimesRoman;
  }
  if (family === "mono") {
    return bold && italic ? StandardFonts.CourierBoldOblique : bold ? StandardFonts.CourierBold : italic ? StandardFonts.CourierOblique : StandardFonts.Courier;
  }
  return bold && italic ? StandardFonts.HelveticaBoldOblique : bold ? StandardFonts.HelveticaBold : italic ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica;
}

function canEncode(font, text) {
  try {
    text.split("\n").forEach((l) => font.widthOfTextAtSize(l, 10));
    return true;
  } catch (_) {
    return false;
  }
}

/* Text the standard fonts cannot encode (Bengali, Arabic, emoji...) becomes a crisp image */
function rasterizeText(text, size, color, family, bold, italic) {
  const S = 4;
  const fam = family === "serif" ? "Georgia, 'Noto Serif Bengali', serif" : family === "mono" ? "'Courier New', monospace" : "system-ui, 'Noto Sans Bengali', 'Segoe UI', Arial, sans-serif";
  const font = `${italic ? "italic " : ""}${bold ? "700 " : "400 "}${size * S}px ${fam}`;
  const c = document.createElement("canvas");
  const g = c.getContext("2d");
  g.font = font;
  const lines = text.split("\n");
  const lh = size * 1.25 * S;
  const w = Math.ceil(Math.max(...lines.map((l) => g.measureText(l).width))) + 6;
  const base = size * S * 0.95;
  const h = Math.ceil(base + (lines.length - 1) * lh + size * S * 0.4);
  c.width = w;
  c.height = h;
  g.font = font;
  g.fillStyle = color;
  g.textBaseline = "alphabetic";
  lines.forEach((l, i) => g.fillText(l, 3, base + i * lh));
  return { dataUrl: c.toDataURL("image/png"), wPt: w / S, hPt: h / S, offPt: (h - base) / S };
}

async function drawTextSmart(out, imgCache, page, font, o) {
  if (!o.text) return;
  const [r, g, b] = hexToRgbFloat(o.color);
  if (font && canEncode(font, o.text)) {
    try {
      const opts = { x: o.x, y: o.y, size: o.size, font, color: rgb(r, g, b), lineHeight: o.size * 1.2, rotate: degrees(o.rot || 0) };
      if (o.opacity !== undefined) opts.opacity = o.opacity;
      page.drawText(o.text, opts);
      return;
    } catch (_) { /* fall through to raster */ }
  }
  const ras = rasterizeText(o.text, o.size, o.color, o.family, o.bold, o.italic);
  let emb = imgCache.get(ras.dataUrl);
  if (!emb) { emb = await out.embedPng(ras.dataUrl); imgCache.set(ras.dataUrl, emb); }
  const a = ((o.rot || 0) * Math.PI) / 180;
  const opts = {
    x: o.x + ras.offPt * Math.sin(a), y: o.y - ras.offPt * Math.cos(a),
    width: ras.wPt, height: ras.hPt, rotate: degrees(o.rot || 0),
  };
  if (o.opacity !== undefined) opts.opacity = o.opacity;
  page.drawImage(emb, opts);
}

async function resolveEditFont(out, ann, cache, std) {
  const reuse = HAS_FONTKIT && [...ann.newText].every((ch) => ch === " " || ann.originalStr.includes(ch));
  if (reuse) {
    const key = "embed:" + ann.fontRef.docId + ":" + ann.fontRef.fontName;
    if (cache.has(key)) {
      if (cache.get(key)) return cache.get(key);
    } else {
      try {
        const entry = state.documents.get(ann.fontRef.docId);
        const pdfPage = await entry.pdfjsDoc.getPage(ann.fontRef.pageNum);
        const fontObj = pdfPage.commonObjs.get(ann.fontRef.fontName);
        if (fontObj && fontObj.data && fontObj.data.length) {
          const emb = await out.embedFont(fontObj.data, { subset: false });
          cache.set(key, emb);
          return emb;
        }
      } catch (_) { /* fall back below */ }
      cache.set(key, null);
    }
  }
  return std(pickStandardFont(ann.fontRef.family, ann.fontRef.bold, ann.fontRef.italic));
}

async function buildPdfFromPages(pageList) {
  const out = await newPdfDocument();
  const imgCache = new Map();
  const fontCache = new Map();
  const stdCache = new Map();
  const std = async (k) => {
    if (!stdCache.has(k)) stdCache.set(k, await out.embedFont(k));
    return stdCache.get(k);
  };

  // Copy pages: one batched call per source document, and a fresh copy for repeated pages
  const copied = new Array(pageList.length).fill(null);
  const byDoc = new Map();
  const seen = new Set();
  const repeats = [];
  pageList.forEach((page, i) => {
    if (page.blank) return;
    const key = page.docId + ":" + page.srcIndex;
    if (seen.has(key)) { repeats.push({ page, i }); return; }
    seen.add(key);
    if (!byDoc.has(page.docId)) byDoc.set(page.docId, []);
    byDoc.get(page.docId).push({ page, i });
  });
  const srcDocs = new Map();
  const loadSrc = async (docId) => {
    if (!srcDocs.has(docId)) {
      srcDocs.set(docId, await PDFDocument.load(state.documents.get(docId).pdfBytes, { ignoreEncryption: true, updateMetadata: false }));
    }
    return srcDocs.get(docId);
  };
  for (const [docId, entries] of byDoc) {
    const src = await loadSrc(docId);
    const pages = await out.copyPages(src, entries.map((e) => e.page.srcIndex));
    entries.forEach((e, k) => { copied[e.i] = pages[k]; });
  }
  for (const r of repeats) {
    const src = await loadSrc(r.page.docId);
    const [p] = await out.copyPages(src, [r.page.srcIndex]);
    copied[r.i] = p;
  }

  const outPages = new Map();
  const rotations = new Map();
  for (let i = 0; i < pageList.length; i++) {
    const page = pageList[i];
    let np;
    if (page.blank) {
      const s = page.blankSize || A4;
      np = out.addPage([s.width, s.height]);
      rotations.set(page.id, 0);
    } else {
      np = out.addPage(copied[i]);
      const g = await getPageGeometry(page);
      np.setRotation(degrees(g.rot));
      rotations.set(page.id, g.rot);
    }
    outPages.set(page.id, np);
  }

  for (const page of pageList) {
    const np = outPages.get(page.id);
    const pageRot = rotations.get(page.id) || 0;
    const anns = state.annotations.get(page.id) || [];

    for (const ann of anns) {
      if (ann.kind === "textEdit") {
        const font = await resolveEditFont(out, ann, fontCache, std);
        let textW = Math.max(ann.wPt, ann.coverW || 0);
        try { textW = Math.max(ann.wPt, font.widthOfTextAtSize(ann.newText, ann.size)); } catch (_) {}
        const moved = Math.abs(ann.xPt - ann.ox) > 0.5 || Math.abs(ann.yPt - ann.oy) > 0.5;
        const [br, bg, bb] = hexToRgbFloat(ann.bgColor);
        np.drawRectangle({
          x: ann.ox - 1, y: ann.oy - ann.size * 0.3,
          width: (moved ? ann.wPt : textW) + 2, height: ann.size * 1.65,
          color: rgb(br, bg, bb),
        });
        if (ann.newText) {
          const common = { text: ann.newText, x: ann.xPt, y: ann.yPt, size: ann.size, color: ann.color, family: ann.fontRef.family, bold: ann.fontRef.bold, italic: ann.fontRef.italic, rot: 0 };
          try {
            await drawTextSmart(out, imgCache, np, font, common);
          } catch (_) {
            await drawTextSmart(out, imgCache, np, await std(pickStandardFont(ann.fontRef.family, ann.fontRef.bold, ann.fontRef.italic)), common);
          }
        }
      } else if (ann.kind === "text") {
        const font = await std(pickStandardFont(ann.family, ann.bold, ann.italic));
        await drawTextSmart(out, imgCache, np, font, {
          text: ann.text, x: ann.xPt, y: ann.yPt, size: ann.size, color: ann.color,
          family: ann.family, bold: ann.bold, italic: ann.italic, rot: ann.rot || 0,
        });
      } else if (ann.kind === "image") {
        let emb = imgCache.get(ann.dataUrl);
        if (!emb) {
          emb = /^data:image\/png/i.test(ann.dataUrl) ? await out.embedPng(ann.dataUrl) : await out.embedJpg(ann.dataUrl);
          imgCache.set(ann.dataUrl, emb);
        }
        np.drawImage(emb, {
          x: ann.xPt, y: ann.yPt, width: ann.wPt, height: ann.hPt,
          opacity: ann.opacity, rotate: degrees(ann.rot || 0),
        });
      } else if (ann.kind === "shape") {
        const [sr, sg, sb] = hexToRgbFloat(ann.stroke);
        const [fr, fg, fb] = hexToRgbFloat(ann.fill);
        const x = Math.min(ann.x0, ann.x1), y = Math.min(ann.y0, ann.y1);
        const w = Math.abs(ann.x1 - ann.x0), h = Math.abs(ann.y1 - ann.y0);
        if (ann.shape === "line") {
          np.drawLine({
            start: { x: ann.x0, y: ann.y0 }, end: { x: ann.x1, y: ann.y1 },
            thickness: Math.max(ann.strokeWidth, 0.5), color: rgb(sr, sg, sb),
          });
        } else {
          const o = {};
          if (ann.fillOn) { o.color = rgb(fr, fg, fb); o.opacity = ann.fillOpacity; }
          if (ann.strokeWidth > 0) { o.borderColor = rgb(sr, sg, sb); o.borderWidth = ann.strokeWidth; o.borderOpacity = 1; }
          if (!o.color && !o.borderColor) continue;
          if (ann.shape === "ellipse") np.drawEllipse({ x: x + w / 2, y: y + h / 2, xScale: w / 2, yScale: h / 2, ...o });
          else np.drawRectangle({ x, y, width: w, height: h, ...o });
        }
      }
    }

    if (state.watermark) {
      const wm = state.watermark;
      const font = await std(StandardFonts.HelveticaBold);
      const mb = np.getMediaBox();
      const cx = mb.x + mb.width / 2, cy = mb.y + mb.height / 2;
      const theta = wm.angle + pageRot;
      const a = (theta * Math.PI) / 180;
      if (canEncode(font, wm.text)) {
        const w = font.widthOfTextAtSize(wm.text, wm.size);
        const h = wm.size * 0.7;
        const [r, g, b] = hexToRgbFloat(wm.color);
        np.drawText(wm.text, {
          x: cx - ((w / 2) * Math.cos(a) - (h / 2) * Math.sin(a)),
          y: cy - ((w / 2) * Math.sin(a) + (h / 2) * Math.cos(a)),
          size: wm.size, font, color: rgb(r, g, b), opacity: wm.opacity, rotate: degrees(theta),
        });
      } else {
        const ras = rasterizeText(wm.text, wm.size, wm.color, "sans", true, false);
        const emb = await out.embedPng(ras.dataUrl);
        np.drawImage(emb, {
          x: cx - ((ras.wPt / 2) * Math.cos(a) - (ras.hPt / 2) * Math.sin(a)),
          y: cy - ((ras.wPt / 2) * Math.sin(a) + (ras.hPt / 2) * Math.cos(a)),
          width: ras.wPt, height: ras.hPt, opacity: wm.opacity, rotate: degrees(theta),
        });
      }
    }
  }
  return out;
}

async function exportAndDownload(pageList, filename) {
  setBusy(true);
  try {
    await tick();
    const doc = await buildPdfFromPages(pageList);
    const bytes = await doc.save();
    downloadBlob(new Blob([bytes], { type: "application/pdf" }), filename);
    toast(`Saved ${filename} (${formatBytes(bytes.length)})`);
  } catch (err) {
    console.error(err);
    toast("Something went wrong building that PDF.", 4200);
  } finally {
    setBusy(false);
  }
}

/* ---------------------------------------------------------
   Document actions (menu)
--------------------------------------------------------- */
async function extractSelection() {
  const ids = currentTargets();
  if (!ids.length) return;
  const set = new Set(ids);
  await exportAndDownload(state.pages.filter((p) => set.has(p.id)), `${baseName(state.docName)}-extract.pdf`);
}

async function splitAllPages() {
  if (!state.pages.length) return;
  setBusy(true);
  try {
    const zip = new JSZip();
    for (let i = 0; i < state.pages.length; i++) {
      const doc = await buildPdfFromPages([state.pages[i]]);
      zip.file(`page-${String(i + 1).padStart(2, "0")}.pdf`, await doc.save());
      await tick();
    }
    downloadBlob(await zip.generateAsync({ type: "blob" }), `${baseName(state.docName)}-pages.zip`);
    toast(`Split into ${state.pages.length} files`);
  } catch (err) {
    console.error(err);
    toast("Could not split the document.");
  } finally {
    setBusy(false);
  }
}

async function exportPagesAsImages() {
  if (!state.pages.length) return;
  setBusy(true);
  try {
    const doc = await buildPdfFromPages(state.pages);
    const bytes = await doc.save();
    const src = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    const zip = new JSZip();
    for (let i = 1; i <= src.numPages; i++) {
      const page = await src.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2, 4000 / Math.max(base.width, base.height));
      const vp = page.getViewport({ scale });
      const c = document.createElement("canvas");
      c.width = Math.round(vp.width);
      c.height = Math.round(vp.height);
      await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      zip.file(`page-${String(i).padStart(2, "0")}.png`, blob);
      page.cleanup();
    }
    downloadBlob(await zip.generateAsync({ type: "blob" }), `${baseName(state.docName)}-images.zip`);
    toast("Images exported");
  } catch (err) {
    console.error(err);
    toast("Could not export images.");
  } finally {
    setBusy(false);
  }
}

async function extractAllText() {
  if (!state.pages.length) return;
  setBusy(true);
  try {
    let out = "";
    for (let i = 0; i < state.pages.length; i++) {
      const page = state.pages[i];
      out += `\n===== Page ${i + 1} =====\n`;
      if (page.blank) continue;
      const entry = state.documents.get(page.docId);
      const pdfPage = await entry.pdfjsDoc.getPage(page.srcIndex + 1);
      const content = await pdfPage.getTextContent();
      let line = "";
      for (const it of content.items) {
        line += it.str;
        line += it.hasEOL ? "\n" : " ";
      }
      out += line.trim() + "\n";
    }
    downloadBlob(new Blob([out], { type: "text/plain;charset=utf-8" }), `${baseName(state.docName)}-text.txt`);
    toast("Text downloaded");
  } finally {
    setBusy(false);
  }
}

async function applyPageNumbers({ start, format, position }) {
  pushHistory();
  const total = state.pages.length;
  for (let i = 0; i < total; i++) {
    const page = state.pages[i];
    const n = start + i;
    let text = String(n);
    if (format === "n-of-total") text = `${n} of ${total}`;
    if (format === "dash") text = `- ${n} -`;
    if (format === "page") text = `Page ${n}`;
    const g = await getPageGeometry(page);
    const size = 10.5, margin = 30;
    const w = measureTextPt(text, size, "sans", false, false);
    const [v, h] = position.split("-");
    const vy = v === "bottom" ? g.heightPt - margin : margin + size * 0.8;
    const vx = h === "center" ? (g.widthPt - w) / 2 : h === "left" ? margin : g.widthPt - margin - w;
    const [xPt, yPt] = g.toPdf(vx, vy);
    const list = (state.annotations.get(page.id) || []).filter((a) => !a.autoPageNumber);
    list.push({
      id: uid("ann"), kind: "text", text, size, color: "#374151",
      family: "sans", bold: false, italic: false, xPt, yPt, rot: g.rot, autoPageNumber: true,
    });
    state.annotations.set(page.id, list);
  }
  if (state.activePageId) renderOverlays(state.activePageId);
  toast("Page numbers added to every page");
}

/* ---------------------------------------------------------
   Compression
--------------------------------------------------------- */
const compressState = { baseline: 0, result: null, running: false };

function isImageStream(obj) {
  return obj instanceof PDFRawStream && obj.dict.get(PDFName.of("Subtype")) === PDFName.of("Image");
}

function numberOf(v) {
  return v instanceof PDFNumber ? v.asNumber() : null;
}

async function recompressOne(doc, obj, quality, maxDim) {
  const N = PDFName.of;
  const d = obj.dict;
  const im = d.lookup(N("ImageMask"));
  if (im && String(im) === "true") return null;
  if (d.has(N("Mask")) || d.has(N("Decode"))) return null;

  const w = numberOf(d.lookup(N("Width")));
  const h = numberOf(d.lookup(N("Height")));
  if (!w || !h || w * h < 30000) return null;
  const bpc = numberOf(d.lookup(N("BitsPerComponent")));
  if (bpc !== null && bpc !== 8) return null;

  let f = d.lookup(N("Filter"));
  if (f instanceof PDFArray) {
    if (f.size() !== 1) return null;
    f = f.lookup(0);
  }
  const isJpeg = f === N("DCTDecode");
  const isFlate = f === N("FlateDecode");
  if (!isJpeg && !isFlate) return null;

  const cs = d.lookup(N("ColorSpace"));
  let comps = 0;
  if (cs === N("DeviceRGB")) comps = 3;
  else if (cs === N("DeviceGray")) comps = 1;
  else if (cs instanceof PDFArray && cs.size() >= 2 && cs.lookup(0) === N("ICCBased")) {
    const prof = cs.lookup(1);
    comps = (prof && prof.dict && numberOf(prof.dict.lookup(N("N")))) || 0;
  }
  if (comps !== 1 && comps !== 3) return null;

  let source;
  if (isJpeg) {
    source = await createImageBitmap(new Blob([obj.contents], { type: "image/jpeg" }));
  } else {
    if (typeof decodePDFRawStream !== "function") return null;
    const raw = decodePDFRawStream(obj).decode();
    if (raw.length < w * h * comps) return null;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0, p = 0, q = 0; i < w * h; i++, q += 4) {
      if (comps === 3) { rgba[q] = raw[p++]; rgba[q + 1] = raw[p++]; rgba[q + 2] = raw[p++]; }
      else { const v = raw[p++]; rgba[q] = rgba[q + 1] = rgba[q + 2] = v; }
      rgba[q + 3] = 255;
    }
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;
    tmp.getContext("2d").putImageData(new ImageData(rgba, w, h), 0, 0);
    source = tmp;
  }

  const longest = Math.max(w, h);
  const k = maxDim && longest > maxDim ? maxDim / longest : 1;
  const nw = Math.max(1, Math.round(w * k));
  const nh = Math.max(1, Math.round(h * k));
  const c = document.createElement("canvas");
  c.width = nw;
  c.height = nh;
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, nw, nh);
  g.imageSmoothingQuality = "high";
  g.drawImage(source, 0, 0, nw, nh);
  if (source.close) source.close();

  const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", quality));
  if (!blob) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const before = obj.contents.length;
  if (bytes.length >= before * 0.92) return null;

  const nd = doc.context.obj({
    Type: "XObject", Subtype: "Image", Width: nw, Height: nh,
    ColorSpace: "DeviceRGB", BitsPerComponent: 8, Filter: "DCTDecode",
  });
  if (d.has(N("SMask"))) nd.set(N("SMask"), d.get(N("SMask")));
  return { stream: PDFRawStream.of(nd, bytes), saved: before - bytes.length };
}

async function recompressImages(doc, { quality, maxDim }, onProgress) {
  const ctx = doc.context;
  const candidates = [...ctx.enumerateIndirectObjects()].filter(([, obj]) => isImageStream(obj));
  let done = 0, replaced = 0;
  for (const [ref, obj] of candidates) {
    try {
      const res = await recompressOne(doc, obj, quality, maxDim);
      if (res) { ctx.assign(ref, res.stream); replaced++; }
    } catch (err) {
      console.warn("Skipped an image", err);
    }
    done++;
    onProgress(done / Math.max(1, candidates.length), `Recompressing images (${done} of ${candidates.length})`);
    await tick();
  }
  return replaced;
}

async function flattenToImages(bytes, { dpi, quality, keepText }, onProgress) {
  const src = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const out = await newPdfDocument();
  const helv = keepText ? await out.embedFont(StandardFonts.Helvetica) : null;
  for (let i = 1; i <= src.numPages; i++) {
    const page = await src.getPage(i);
    const vp1 = page.getViewport({ scale: 1 });
    let scale = dpi / 72;
    while (vp1.width * scale * vp1.height * scale > 36e6 && scale > 0.5) scale *= 0.85;
    const vp = page.getViewport({ scale });
    const c = document.createElement("canvas");
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    const g = c.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", quality));
    const emb = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    const np = out.addPage([vp1.width, vp1.height]);
    np.drawImage(emb, { x: 0, y: 0, width: vp1.width, height: vp1.height });
    if (keepText) {
      try {
        const tc = await page.getTextContent();
        for (const it of tc.items) {
          if (!it.str || !it.str.trim()) continue;
          const m = pdfjsLib.Util.transform(vp1.transform, it.transform);
          const size = Math.hypot(m[0], m[1]);
          if (Math.abs(m[1]) > 0.02 * size || size < 1) continue;
          try {
            np.drawText(it.str, { x: m[4], y: vp1.height - m[5], size, font: helv, opacity: 0 });
          } catch (_) { /* unencodable character, skip this run */ }
        }
      } catch (_) {}
    }
    page.cleanup();
    c.width = c.height = 0;
    onProgress(i / src.numPages, `Flattening page ${i} of ${src.numPages}`);
    await tick();
  }
  return out.save({ useObjectStreams: true });
}

async function runCompression(level, onProgress) {
  onProgress(0.02, "Building your document");
  await tick();
  const doc = await buildPdfFromPages(state.pages);
  if (level === "optimize") {
    onProgress(0.7, "Optimising structure");
    return doc.save({ useObjectStreams: true });
  }
  if (level === "smart") {
    const opts = { quality: Number($("cq").value) / 100, maxDim: Number($("cmax").value) };
    await recompressImages(doc, opts, (f, label) => onProgress(0.05 + f * 0.85, label));
    onProgress(0.95, "Saving");
    return doc.save({ useObjectStreams: true });
  }
  const bytes = await doc.save();
  return flattenToImages(
    bytes,
    { dpi: Number($("cdpi").value), quality: Number($("cq2").value) / 100, keepText: $("ckeep").checked },
    (f, label) => onProgress(0.05 + f * 0.9, label)
  );
}

async function openCompress() {
  if (!state.pages.length) return;
  compressState.result = null;
  $("size-current").textContent = "Calculating\u2026";
  $("size-after").textContent = "Not run yet";
  $("cresult").classList.add("hidden");
  $("cprogress").classList.add("hidden");
  $("c-download").classList.add("hidden");
  $("c-run").disabled = false;
  openModal("modal-compress");
  try {
    await tick();
    const doc = await buildPdfFromPages(state.pages);
    const bytes = await doc.save();
    compressState.baseline = bytes.length;
    $("size-current").textContent = formatBytes(bytes.length);
  } catch (err) {
    console.error(err);
    $("size-current").textContent = "Unknown";
  }
}

function syncCompressOptions() {
  const level = document.querySelector('input[name="clevel"]:checked').value;
  $("opts-smart").classList.toggle("hidden", level !== "smart");
  $("opts-max").classList.toggle("hidden", level !== "max");
}
document.querySelectorAll('input[name="clevel"]').forEach((r) => r.addEventListener("change", syncCompressOptions));

$("c-run").addEventListener("click", async () => {
  if (compressState.running) return;
  compressState.running = true;
  const level = document.querySelector('input[name="clevel"]:checked').value;
  $("c-run").disabled = true;
  $("c-download").classList.add("hidden");
  $("cresult").classList.add("hidden");
  $("cprogress").classList.remove("hidden");
  const onProgress = (f, label) => {
    $("cbar").style.width = Math.round(f * 100) + "%";
    $("cstatus").textContent = label;
  };
  try {
    const bytes = await runCompression(level, onProgress);
    compressState.result = new Blob([bytes], { type: "application/pdf" });
    const before = compressState.baseline || bytes.length;
    const after = bytes.length;
    $("size-after").textContent = formatBytes(after);
    const res = $("cresult");
    res.classList.remove("hidden", "good", "neutral");
    if (after < before) {
      const pct = Math.round((1 - after / before) * 100);
      res.classList.add("good");
      res.innerHTML = `<strong>${pct}% smaller.</strong> Saved ${formatBytes(before - after)}. ` +
        (level === "max" ? "Pages are now images." : level === "smart" ? "Text and vectors are untouched." : "Nothing about the look of the file changed.");
    } else {
      res.classList.add("neutral");
      res.innerHTML = "<strong>This file is already well optimised.</strong> This setting could not make it smaller. Try Balanced with lower quality, or Maximum.";
    }
    $("c-download").classList.remove("hidden");
    $("c-run").querySelector("span").textContent = "Run again";
  } catch (err) {
    console.error(err);
    toast("Compression failed for this file.", 4200);
  } finally {
    $("cprogress").classList.add("hidden");
    $("c-run").disabled = false;
    compressState.running = false;
  }
});
$("c-download").addEventListener("click", () => {
  if (compressState.result) {
    downloadBlob(compressState.result, `${baseName(state.docName)}-compressed.pdf`);
    toast("Compressed file saved");
  }
});

/* ---------------------------------------------------------
   Modals, menus, drawers, zoom
--------------------------------------------------------- */
function openModal(id) { $(id).classList.remove("hidden"); }
function closeModals() {
  if (compressState.running) return;
  document.querySelectorAll(".modal-veil").forEach((m) => m.classList.add("hidden"));
}
document.querySelectorAll(".modal-veil").forEach((veil) => {
  veil.addEventListener("pointerdown", (e) => { if (e.target === veil) closeModals(); });
  veil.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeModals));
});

function openDrawer(which) {
  if (!COMPACT()) return;
  closeDrawers();
  $(which).classList.add("open");
  $("drawer-backdrop").classList.add("show");
}
function closeDrawers() {
  $("rail").classList.remove("open");
  $("panel").classList.remove("open");
  $("drawer-backdrop").classList.remove("show");
}
$("btn-open-rail").addEventListener("click", () => openDrawer("rail"));
$("btn-open-panel").addEventListener("click", () => openDrawer("panel"));
$("btn-close-rail").addEventListener("click", closeDrawers);
$("btn-close-panel").addEventListener("click", closeDrawers);
$("drawer-backdrop").addEventListener("click", closeDrawers);

const menu = $("menu-more");
function toggleMenu(force) {
  const open = force !== undefined ? force : menu.classList.contains("hidden");
  menu.classList.toggle("hidden", !open);
  $("btn-more").setAttribute("aria-expanded", String(open));
}
$("btn-more").addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(); });
document.addEventListener("pointerdown", (e) => { if (!e.target.closest(".menu-wrap")) toggleMenu(false); });
menu.querySelectorAll("button").forEach((b) =>
  b.addEventListener("click", () => {
    toggleMenu(false);
    const a = b.dataset.action;
    if (a === "extract") extractSelection();
    else if (a === "split") splitAllPages();
    else if (a === "images") exportPagesAsImages();
    else if (a === "text") extractAllText();
    else if (a === "numbers") openModal("modal-numbers");
    else if (a === "watermark") {
      if (state.watermark) {
        $("wm-text").value = state.watermark.text;
        $("wm-size").value = state.watermark.size;
        $("wm-angle").value = state.watermark.angle;
        $("wm-opacity").value = Math.round(state.watermark.opacity * 100);
        $("wm-color").value = state.watermark.color;
        ["wm-size", "wm-angle", "wm-opacity"].forEach((id) => $(id).dispatchEvent(new Event("input")));
      }
      openModal("modal-watermark");
    }
  })
);

$("pn-apply").addEventListener("click", async () => {
  const opts = {
    start: Number($("pn-start").value) || 1,
    format: $("pn-format").value,
    position: $("pn-position").value,
  };
  closeModals();
  await applyPageNumbers(opts);
});
$("wm-apply").addEventListener("click", () => {
  const text = $("wm-text").value.trim();
  if (!text) return toast("Enter the watermark text.");
  pushHistory();
  state.watermark = {
    text, size: Number($("wm-size").value), angle: Number($("wm-angle").value),
    opacity: Number($("wm-opacity").value) / 100, color: $("wm-color").value,
  };
  closeModals();
  if (state.activePageId) renderOverlays(state.activePageId);
  toast("Watermark added to every page");
});
$("wm-remove").addEventListener("click", () => {
  if (state.watermark) { pushHistory(); state.watermark = null; }
  closeModals();
  if (state.activePageId) renderOverlays(state.activePageId);
});

function setZoom(z) {
  state.zoom = Math.max(0.4, Math.min(3, Math.round(z * 100) / 100));
  renderStagePage();
}
$("btn-zoom-in").addEventListener("click", () => setZoom(state.zoom + 0.15));
$("btn-zoom-out").addEventListener("click", () => setZoom(state.zoom - 0.15));
$("btn-zoom-fit").addEventListener("click", () => setZoom(1));
$("canvas-scroll").addEventListener("wheel", (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setZoom(state.zoom + (e.deltaY < 0 ? 0.1 : -0.1));
}, { passive: false });

function gotoPage(delta) {
  const i = state.pages.findIndex((p) => p.id === state.activePageId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= state.pages.length) return;
  setActivePage(state.pages[j].id);
}
$("btn-prev").addEventListener("click", () => gotoPage(-1));
$("btn-next").addEventListener("click", () => gotoPage(1));

/* ---------------------------------------------------------
   Wiring
--------------------------------------------------------- */
$("input-open").addEventListener("change", (e) => { if (e.target.files[0]) openNewFile(e.target.files[0]); e.target.value = ""; });
$("input-open-2").addEventListener("change", (e) => { if (e.target.files[0]) openNewFile(e.target.files[0]); e.target.value = ""; });
$("input-merge").addEventListener("change", async (e) => {
  for (const f of e.target.files) await loadPdfFile(f, { replace: state.pages.length === 0 });
  e.target.value = "";
});

$("btn-insert-blank").addEventListener("click", insertBlankPage);
$("btn-duplicate").addEventListener("click", duplicatePages);
$("btn-select-all").addEventListener("click", () => {
  if (state.selectedPageIds.size === state.pages.length) state.selectedPageIds.clear();
  else state.pages.forEach((p) => state.selectedPageIds.add(p.id));
  refreshRail();
});
$("btn-clear").addEventListener("click", () => {
  if (!confirm("Start over? Everything you have done will be lost.")) return;
  state.documents.clear();
  state.pages = [];
  state.annotations.clear();
  state.runCache.clear();
  state.selectedPageIds.clear();
  state.activePageId = null;
  state.undoStack = [];
  state.redoStack = [];
  state.watermark = null;
  state.docName = "";
  thumbCache.clear();
  updateChrome();
  renderRail();
  renderStagePage();
});
$("btn-undo").addEventListener("click", undo);
$("btn-redo").addEventListener("click", redo);
$("btn-rotate-left").addEventListener("click", () => rotatePages(-90));
$("btn-rotate-right").addEventListener("click", () => rotatePages(90));
$("btn-delete-pages").addEventListener("click", () => removePages(currentTargets()));
$("btn-download").addEventListener("click", () => exportAndDownload(state.pages, `${baseName(state.docName)}-edited.pdf`));
$("btn-compress").addEventListener("click", openCompress);

/* Theme */
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  $("theme-use").setAttribute("href", t === "dark" ? "#i-sun" : "#i-moon");
  try { localStorage.setItem("foolscap-theme", t); } catch (_) {}
}
$("btn-theme").addEventListener("click", () =>
  applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark")
);
applyTheme(document.documentElement.getAttribute("data-theme") || "light");

/* Drag and drop to open */
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes("Files")) return;
  dragDepth++;
  $("drop-veil").classList.remove("hidden");
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $("drop-veil").classList.add("hidden");
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("drop-veil").classList.add("hidden");
  const files = e.dataTransfer && e.dataTransfer.files;
  if (!files || !files.length) return;
  const pdfs = [...files].filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
  if (state.pages.length && pdfs.length > 0 && files.length > 0 && e.shiftKey) {
    pdfs.forEach((f) => loadPdfFile(f, { replace: false }));
  } else {
    openNewFile(files[0]).then(() => {
      for (const f of [...files].slice(1)) if (/pdf/i.test(f.type) || /\.pdf$/i.test(f.name)) loadPdfFile(f, { replace: false });
    });
  }
});

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!COMPACT()) closeDrawers();
    if (state.activePageId) renderStagePage();
  }, 150);
});

window.addEventListener("beforeunload", (e) => {
  if (state.undoStack.length > 0) { e.preventDefault(); e.returnValue = ""; }
});

/* Keyboard shortcuts */
window.addEventListener("keydown", (e) => {
  const el = document.activeElement;
  const typing = el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.tagName === "SELECT" || el.isContentEditable);
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === "Escape") { closeModals(); closeDrawers(); toggleMenu(false); return; }
  if (typing) return;
  if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); if (state.pages.length) $("btn-download").click(); return; }
  if (!state.pages.length || mod) return;
  const toolKeys = { v: "select", e: "edit", t: "text", i: "image", u: "shape", h: "highlight", x: "redact", g: "sign" };
  const k = e.key.toLowerCase();
  if (toolKeys[k]) { setActiveTool(toolKeys[k]); return; }
  if (e.key === "+" || e.key === "=") setZoom(state.zoom + 0.15);
  else if (e.key === "-") setZoom(state.zoom - 0.15);
  else if (e.key === "[" || e.key === "PageUp") gotoPage(-1);
  else if (e.key === "]" || e.key === "PageDown") gotoPage(1);
  else if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    if (state.selectedAnn) {
      pushHistory();
      removeAnnotation(state.selectedAnn.pageId, state.selectedAnn.id);
      const pid = state.selectedAnn.pageId;
      state.selectedAnn = null;
      renderOverlays(pid);
    } else {
      removePages(currentTargets());
    }
  }
});

setActiveTool("select");
syncCompressOptions();
updateChrome();
