// main.js — UI wiring for Postguard. All file reads use the File API
// (never uploaded), all processing happens in-browser via the pure modules
// in js/exif.js, js/pdfmeta.js, and js/redact.js. No fetch/XHR anywhere in
// this file or any module it imports — that's what makes the "100% local"
// claim on the page true, not just stated.

import { parseJpegExif, stripJpegExif, EXIF_FIELD_LABELS } from './exif.js';
import { parsePdfMetadata, stripPdfMetadata, PDF_FIELD_LABELS } from './pdfmeta.js';
import { normalizeRect, applyRedactions } from './redact.js';
import {
  validateCard,
  submitSandboxPayment,
  getOneTimePriceUSD,
  isUnlocked,
  markUnlocked,
  DECLINE_TEST_CARD,
} from './checkout.js';

// --- Feature 1: metadata scrubber -------------------------------------------------

let currentScrubFile = null; // { name, kind: 'jpeg'|'pdf', originalBuffer, cleanedBuffer }

function fileToArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

function renderMetadataFields(container, tags, labels) {
  container.innerHTML = '';
  const keys = Object.keys(tags);
  if (keys.length === 0) {
    const note = document.createElement('div');
    note.className = 'no-metadata-note';
    note.textContent = 'No metadata found — this file looks already clean (or never had any).';
    container.appendChild(note);
    return;
  }

  if ('GPSLatitude' in tags || 'GPSLongitude' in tags) {
    const warn = document.createElement('div');
    warn.className = 'gps-warning';
    warn.textContent = 'This file contains GPS coordinates — it can reveal exactly where the photo was taken.';
    container.appendChild(warn);
  }

  const list = document.createElement('ul');
  list.className = 'meta-field-list';
  for (const key of keys) {
    const li = document.createElement('li');
    const label = labels[key] || key;
    let value = tags[key];
    if (typeof value === 'number') value = Number.isInteger(value) ? value : value.toFixed(6);
    li.innerHTML = `<span class="field-name"></span><span class="field-value"></span>`;
    li.querySelector('.field-name').textContent = label;
    li.querySelector('.field-value').textContent = String(value);
    list.appendChild(li);
  }
  container.appendChild(list);
}

function detectKind(file) {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'pdf';
  if (file.type === 'image/jpeg' || /\.jpe?g$/i.test(file.name)) return 'jpeg';
  return 'unknown';
}

async function processScrubFile(file) {
  const kind = detectKind(file);
  const buffer = await fileToArrayBuffer(file);

  if (kind === 'jpeg') {
    const parsed = parseJpegExif(buffer);
    const cleanedBuffer = stripJpegExif(buffer);
    return { name: file.name, kind, tags: parsed.tags, hasMetadata: parsed.hasExif, cleanedBuffer, mime: 'image/jpeg' };
  }
  if (kind === 'pdf') {
    const parsed = parsePdfMetadata(buffer);
    const cleanedBuffer = stripPdfMetadata(buffer);
    return { name: file.name, kind, tags: parsed.tags, hasMetadata: parsed.hasMetadata, cleanedBuffer, mime: 'application/pdf' };
  }
  throw new Error('Unsupported file type — choose a JPEG image or a PDF.');
}

function wireScrubFeature() {
  const input = document.getElementById('scrub-file-input');
  const metaEl = document.getElementById('scrub-file-meta');
  const resultsEl = document.getElementById('scrub-results');
  const nameEl = document.getElementById('scrub-file-name');
  const foundEl = document.getElementById('scrub-metadata-found');
  const downloadBtn = document.getElementById('scrub-download-btn');
  const downloadMetaEl = document.getElementById('scrub-download-meta');

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    metaEl.textContent = `Reading ${file.name}…`;
    resultsEl.hidden = true;
    downloadMetaEl.textContent = '';

    try {
      const processed = await processScrubFile(file);
      currentScrubFile = processed;
      metaEl.textContent = `Loaded ${file.name} (${(file.size / 1024).toFixed(1)} KB) — read locally, never uploaded.`;
      nameEl.textContent = file.name;
      const labels = processed.kind === 'jpeg' ? EXIF_FIELD_LABELS : PDF_FIELD_LABELS;
      renderMetadataFields(foundEl, processed.tags, labels);
      resultsEl.hidden = false;
    } catch (err) {
      metaEl.textContent = err.message || 'Could not read that file.';
      currentScrubFile = null;
    }
  });

  downloadBtn.addEventListener('click', () => {
    if (!currentScrubFile) return;
    const blob = new Blob([currentScrubFile.cleanedBuffer], { type: currentScrubFile.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const dotIdx = currentScrubFile.name.lastIndexOf('.');
    const base = dotIdx > -1 ? currentScrubFile.name.slice(0, dotIdx) : currentScrubFile.name;
    const ext = dotIdx > -1 ? currentScrubFile.name.slice(dotIdx) : '';
    a.href = url;
    a.download = `${base}-scrubbed${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    downloadMetaEl.textContent = 'Downloaded — metadata stripped, image/PDF content unchanged.';
  });
}

// --- Batch mode (paid unlock) ------------------------------------------------------

function wireBatchFeature() {
  const input = document.getElementById('batch-file-input');
  const resultsEl = document.getElementById('batch-results');

  input.addEventListener('change', async () => {
    resultsEl.innerHTML = '';
    const files = Array.from(input.files || []);
    for (const file of files) {
      const row = document.createElement('div');
      row.className = 'file-drop';
      row.style.textAlign = 'left';
      row.style.marginTop = '10px';
      row.textContent = `Processing ${file.name}…`;
      resultsEl.appendChild(row);

      try {
        const processed = await processScrubFile(file);
        const blob = new Blob([processed.cleanedBuffer], { type: processed.mime });
        const url = URL.createObjectURL(blob);
        const dotIdx = processed.name.lastIndexOf('.');
        const base = dotIdx > -1 ? processed.name.slice(0, dotIdx) : processed.name;
        const ext = dotIdx > -1 ? processed.name.slice(dotIdx) : '';

        row.innerHTML = '';
        const label = document.createElement('div');
        label.style.marginBottom = '6px';
        label.innerHTML = `<strong></strong> — ${processed.hasMetadata ? 'metadata found and stripped' : 'no metadata found'}`;
        label.querySelector('strong').textContent = processed.name;
        row.appendChild(label);

        const a = document.createElement('a');
        a.href = url;
        a.download = `${base}-scrubbed${ext}`;
        a.className = 'btn btn-secondary btn-sm';
        a.textContent = 'Download cleaned file';
        row.appendChild(a);
      } catch (err) {
        row.textContent = `${file.name}: ${err.message || 'could not process this file'}`;
      }
    }
  });
}

function refreshBatchUnlockUI() {
  const unlocked = isUnlocked();
  document.getElementById('batch-panel').hidden = !unlocked;
  document.getElementById('batch-lock-notice').hidden = unlocked;
}

// --- Feature 2: redaction tool -----------------------------------------------------

const redactState = {
  image: null, // HTMLImageElement
  canvas: null,
  ctx: null,
  rects: [], // list of {x,y,w,h} in canvas pixel space
  drawing: null, // {x,y} start point of an in-progress drag, or null
};

function drawRedactCanvas() {
  const { ctx, canvas, image, rects, drawing } = redactState;
  if (!ctx || !image) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.strokeStyle = '#e0663f';
  ctx.lineWidth = 2;
  ctx.fillStyle = 'rgba(224, 102, 63, 0.25)';
  for (const r of rects) {
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  }
  if (drawing) {
    ctx.fillRect(drawing.x, drawing.y, drawing.w, drawing.h);
    ctx.strokeRect(drawing.x, drawing.y, drawing.w, drawing.h);
  }
  ctx.restore();
}

function updateBoxCount() {
  const el = document.getElementById('redact-box-count');
  el.textContent = `${redactState.rects.length} box(es) drawn.`;
  document.getElementById('redact-download-btn').disabled = false; // allow download even with 0 boxes (no-op passthrough)
}

function canvasPointFromEvent(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY,
  };
}

function wireRedactCanvasEvents(canvas) {
  let dragStart = null;

  function start(e) {
    e.preventDefault();
    const p = canvasPointFromEvent(e, canvas);
    dragStart = p;
    redactState.drawing = { x: p.x, y: p.y, w: 0, h: 0 };
  }

  function move(e) {
    if (!dragStart) return;
    e.preventDefault();
    const p = canvasPointFromEvent(e, canvas);
    redactState.drawing = { x: dragStart.x, y: dragStart.y, w: p.x - dragStart.x, h: p.y - dragStart.y };
    drawRedactCanvas();
  }

  function end(e) {
    if (!dragStart) return;
    e.preventDefault();
    const finished = redactState.drawing;
    dragStart = null;
    redactState.drawing = null;
    if (finished) {
      const norm = normalizeRect(finished, canvas.width, canvas.height);
      if (norm.w >= 4 && norm.h >= 4) {
        redactState.rects.push(norm);
      }
    }
    drawRedactCanvas();
    updateBoxCount();
  }

  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', end, { passive: false });
}

function wireRedactFeature() {
  const input = document.getElementById('redact-file-input');
  const metaEl = document.getElementById('redact-file-meta');
  const workspace = document.getElementById('redact-workspace');
  const canvas = document.getElementById('redact-canvas');
  const modeSelect = document.getElementById('redact-mode');
  const applyBtn = document.getElementById('redact-apply-btn');
  const undoBtn = document.getElementById('redact-undo-btn');
  const clearBtn = document.getElementById('redact-clear-btn');
  const downloadBtn = document.getElementById('redact-download-btn');
  const downloadMetaEl = document.getElementById('redact-download-meta');

  redactState.canvas = canvas;
  redactState.ctx = canvas.getContext('2d');
  wireRedactCanvasEvents(canvas);

  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const MAX_DIM = 1400; // keep canvas manageable on mobile
      let { naturalWidth: w, naturalHeight: h } = img;
      if (w > MAX_DIM || h > MAX_DIM) {
        const scale = MAX_DIM / Math.max(w, h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }
      canvas.width = w;
      canvas.height = h;
      redactState.image = img;
      redactState.rects = [];
      metaEl.textContent = `Loaded ${file.name} (${(file.size / 1024).toFixed(1)} KB) — read locally, never uploaded.`;
      workspace.hidden = false;
      downloadMetaEl.textContent = '';
      downloadBtn.disabled = true;
      drawRedactCanvas();
      updateBoxCount();
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });

  undoBtn.addEventListener('click', () => {
    redactState.rects.pop();
    drawRedactCanvas();
    updateBoxCount();
  });

  clearBtn.addEventListener('click', () => {
    redactState.rects = [];
    drawRedactCanvas();
    updateBoxCount();
  });

  applyBtn.addEventListener('click', () => {
    if (!redactState.image || redactState.rects.length === 0) {
      downloadMetaEl.textContent = 'Draw at least one box before applying.';
      return;
    }
    const ctx = redactState.ctx;
    // Redraw the clean image first (no selection overlays) so the pixels we
    // read below are the real source pixels, then destructively alter them.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(redactState.image, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    const mode = modeSelect.value;
    applyRedactions(imageData, redactState.rects, mode, { color: [0, 0, 0, 255], radius: 14 });
    ctx.putImageData(imageData, 0, 0);

    // Lock in: clear the rect list so re-running Apply doesn't double-blur,
    // and future draws start a fresh selection on the now-redacted image.
    redactState.rects = [];
    updateBoxCount();
    downloadBtn.disabled = false;
    downloadMetaEl.textContent = 'Redactions applied — pixel data permanently altered. Ready to download.';
  });

  downloadBtn.addEventListener('click', () => {
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'redacted-image.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }, 'image/png');
  });
}

// --- Checkout modal -----------------------------------------------------------------

function wireCheckout() {
  const openBtn = document.getElementById('open-checkout-btn');
  const overlay = document.getElementById('checkout-overlay');
  const closeBtn = document.getElementById('checkout-close');
  const form = document.getElementById('checkout-form');
  const priceEl = document.getElementById('checkout-price');
  const priceDisplay = document.getElementById('price-display');
  const declineHint = document.getElementById('decline-card-hint');
  const resultEl = document.getElementById('checkout-result');
  const alreadyNote = document.getElementById('already-unlocked-note');

  const price = getOneTimePriceUSD();
  priceEl.textContent = `One-time unlock: $${price}`;
  priceDisplay.innerHTML = `$${price}<span class="per"> one-time</span>`;
  declineHint.textContent = DECLINE_TEST_CARD;

  function refreshUnlockedUI() {
    const unlocked = isUnlocked();
    alreadyNote.hidden = !unlocked;
    openBtn.textContent = unlocked ? 'Unlocked (sandbox) — buy again' : 'Unlock batch mode (sandbox)';
    refreshBatchUnlockUI();
  }

  openBtn.addEventListener('click', () => {
    overlay.classList.remove('hidden');
    resultEl.textContent = '';
    resultEl.className = 'checkout-result';
  });

  closeBtn.addEventListener('click', () => overlay.classList.add('hidden'));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.add('hidden');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const number = document.getElementById('card-number').value;
    const expiry = document.getElementById('card-expiry').value;
    const cvc = document.getElementById('card-cvc').value;

    ['number', 'expiry', 'cvc'].forEach((f) => {
      document.getElementById(`error-${f}`).textContent = '';
    });

    const { valid, errors } = validateCard({ number, expiry, cvc });
    if (!valid) {
      Object.entries(errors).forEach(([field, msg]) => {
        const errEl = document.getElementById(`error-${field}`);
        if (errEl) errEl.textContent = msg;
      });
      return;
    }

    const submitBtn = document.getElementById('checkout-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Processing (sandbox)…';
    resultEl.textContent = '';
    resultEl.className = 'checkout-result';

    const result = await submitSandboxPayment({ number });

    submitBtn.disabled = false;
    submitBtn.textContent = 'Unlock (sandbox)';

    if (result.ok) {
      markUnlocked();
      resultEl.textContent = `${result.message} Reference: ${result.reference}`;
      resultEl.className = 'checkout-result ok';
      refreshUnlockedUI();
      setTimeout(() => overlay.classList.add('hidden'), 1400);
    } else {
      resultEl.textContent = result.message;
      resultEl.className = 'checkout-result fail';
    }
  });

  refreshUnlockedUI();
}

// --- Init -----------------------------------------------------------------------

function init() {
  wireScrubFeature();
  wireBatchFeature();
  wireRedactFeature();
  wireCheckout();
  refreshBatchUnlockUI();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
