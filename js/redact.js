// redact.js — pure pixel-destruction logic for the redaction tool.
// Separated from canvas/mouse-event UI wiring (in main.js) so the core
// "given rectangles, permanently destroy the pixels inside them" operation
// is Node-testable against a synthetic ImageData-like structure
// ({ width, height, data: Uint8ClampedArray }) with no DOM/canvas needed.

/**
 * Clamp a rectangle {x, y, w, h} so it lies fully within [0,width) x [0,height).
 * Negative width/height (dragged backwards) are normalized to positive.
 */
export function normalizeRect(rect, width, height) {
  let { x, y, w, h } = rect;
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  const x0 = Math.max(0, Math.min(x, width));
  const y0 = Math.max(0, Math.min(y, height));
  const x1 = Math.max(0, Math.min(x + w, width));
  const y1 = Math.max(0, Math.min(y + h, height));
  return { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
}

/**
 * Destructively fill every pixel inside `rect` with a solid RGBA color,
 * mutating `imageData.data` in place. This is the "honesty-critical" part:
 * the actual pixel bytes are overwritten, not merely covered by a drawn
 * overlay — so the original pixel values are unrecoverable from the
 * resulting buffer.
 *
 * @param {{width:number, height:number, data:Uint8ClampedArray|Uint8Array}} imageData
 * @param {{x:number,y:number,w:number,h:number}} rect
 * @param {[number,number,number,number]} color RGBA, each 0-255 (default opaque black)
 */
export function fillRect(imageData, rect, color = [0, 0, 0, 255]) {
  const { width, height, data } = imageData;
  const r = normalizeRect(rect, width, height);
  const [cr, cg, cb, ca] = color;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const idx = (y * width + x) * 4;
      data[idx] = cr;
      data[idx + 1] = cg;
      data[idx + 2] = cb;
      data[idx + 3] = ca;
    }
  }
  return imageData;
}

/**
 * Apply a simple box-blur (average of a square neighborhood) to the pixels
 * inside `rect`, mutating `imageData.data` in place. Reads from a snapshot
 * copy of the original data so the blur is computed from real neighboring
 * pixels (not from already-blurred output), then writes results back only
 * within the rect — still fully destructive of the original values in that
 * region once applied with a large enough radius.
 *
 * @param {{width:number, height:number, data:Uint8ClampedArray|Uint8Array}} imageData
 * @param {{x:number,y:number,w:number,h:number}} rect
 * @param {number} radius box half-width in pixels (bigger = more destroyed detail)
 */
export function blurRect(imageData, rect, radius = 12) {
  const { width, height, data } = imageData;
  const r = normalizeRect(rect, width, height);
  if (r.w <= 0 || r.h <= 0) return imageData;
  const src = data.slice(); // snapshot to blur from

  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      let sr = 0, sg = 0, sb = 0, sa = 0, count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const sy = y + dy;
        if (sy < 0 || sy >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const sx = x + dx;
          if (sx < 0 || sx >= width) continue;
          const idx = (sy * width + sx) * 4;
          sr += src[idx];
          sg += src[idx + 1];
          sb += src[idx + 2];
          sa += src[idx + 3];
          count++;
        }
      }
      const idx = (y * width + x) * 4;
      data[idx] = sr / count;
      data[idx + 1] = sg / count;
      data[idx + 2] = sb / count;
      data[idx + 3] = sa / count;
    }
  }
  return imageData;
}

/**
 * Apply a list of rectangles to imageData using the given mode
 * ('fill' | 'blur'), mutating and returning imageData.
 */
export function applyRedactions(imageData, rects, mode = 'fill', options = {}) {
  for (const rect of rects) {
    if (mode === 'blur') {
      blurRect(imageData, rect, options.radius ?? 12);
    } else {
      fillRect(imageData, rect, options.color ?? [0, 0, 0, 255]);
    }
  }
  return imageData;
}
