// Real verification for js/redact.js — confirms pixel data inside a
// redaction rectangle is actually altered (not just visually overlaid) and
// pixels outside the rectangle are left untouched.
import assert from 'node:assert/strict';
import { fillRect, blurRect, normalizeRect, applyRedactions } from '../js/redact.js';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

/** Build a synthetic ImageData-like object filled with a solid known color. */
function makeSolidImage(width, height, [r, g, b, a]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }
  return { width, height, data };
}

function pixelAt(imageData, x, y) {
  const idx = (y * imageData.width + x) * 4;
  return [imageData.data[idx], imageData.data[idx + 1], imageData.data[idx + 2], imageData.data[idx + 3]];
}

// ---- tests ----

check('normalizeRect handles a backwards-dragged rectangle (negative w/h)', () => {
  const r = normalizeRect({ x: 20, y: 20, w: -10, h: -5 }, 100, 100);
  assert.deepEqual(r, { x: 10, y: 15, w: 10, h: 5 });
});

check('normalizeRect clamps a rectangle that overflows the image bounds', () => {
  const r = normalizeRect({ x: 90, y: 90, w: 50, h: 50 }, 100, 100);
  assert.equal(r.x, 90);
  assert.equal(r.y, 90);
  assert.equal(r.w, 10);
  assert.equal(r.h, 10);
});

check('fillRect destructively overwrites pixels inside the rectangle with the fill color', () => {
  const img = makeSolidImage(10, 10, [200, 150, 100, 255]);
  fillRect(img, { x: 2, y: 2, w: 4, h: 4 }, [0, 0, 0, 255]);

  // inside rect: must now be solid black
  assert.deepEqual(pixelAt(img, 2, 2), [0, 0, 0, 255]);
  assert.deepEqual(pixelAt(img, 5, 5), [0, 0, 0, 255]);
  // just outside the rect boundary: must be untouched original color
  assert.deepEqual(pixelAt(img, 6, 2), [200, 150, 100, 255]);
  assert.deepEqual(pixelAt(img, 1, 2), [200, 150, 100, 255]);
  assert.deepEqual(pixelAt(img, 2, 6), [200, 150, 100, 255]);
});

check('fillRect leaves pixels entirely outside the rect completely untouched', () => {
  const img = makeSolidImage(10, 10, [1, 2, 3, 255]);
  fillRect(img, { x: 0, y: 0, w: 3, h: 3 }, [255, 255, 255, 255]);
  for (let y = 3; y < 10; y++) {
    for (let x = 3; x < 10; x++) {
      assert.deepEqual(pixelAt(img, x, y), [1, 2, 3, 255], `pixel (${x},${y}) should be untouched`);
    }
  }
});

check('blurRect alters pixels inside the rect based on real neighboring values (not identity)', () => {
  // Left half black, right half white — blur across the boundary rect should
  // produce mid-gray values distinct from both pure inputs.
  const width = 20, height = 10;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const v = x < width / 2 ? 0 : 255;
      data[idx] = v; data[idx + 1] = v; data[idx + 2] = v; data[idx + 3] = 255;
    }
  }
  const img = { width, height, data };
  blurRect(img, { x: 8, y: 0, w: 4, h: height }, 6);
  const [r] = pixelAt(img, 10, 5); // right at the former hard boundary
  assert.ok(r > 0 && r < 255, `blurred boundary pixel should be a mid value, got ${r}`);
});

check('applyRedactions applies multiple rectangles in fill mode', () => {
  const img = makeSolidImage(10, 10, [50, 60, 70, 255]);
  applyRedactions(img, [
    { x: 0, y: 0, w: 2, h: 2 },
    { x: 8, y: 8, w: 2, h: 2 },
  ], 'fill', { color: [9, 9, 9, 255] });
  assert.deepEqual(pixelAt(img, 0, 0), [9, 9, 9, 255]);
  assert.deepEqual(pixelAt(img, 9, 9), [9, 9, 9, 255]);
  assert.deepEqual(pixelAt(img, 5, 5), [50, 60, 70, 255], 'untouched middle pixel');
});

check('fillRect with a zero-area (fully out-of-bounds) rect is a no-op and does not throw', () => {
  const img = makeSolidImage(5, 5, [1, 1, 1, 255]);
  fillRect(img, { x: 100, y: 100, w: 10, h: 10 }, [255, 0, 0, 255]);
  assert.deepEqual(pixelAt(img, 0, 0), [1, 1, 1, 255]);
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error('\nSOME CHECKS FAILED');
  process.exit(1);
} else {
  console.log('\nALL CHECKS PASSED');
}
