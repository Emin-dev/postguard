// Real verification for js/exif.js — constructs synthetic but byte-accurate
// JPEG buffers (real marker structure, real TIFF/EXIF IFD structure) and
// confirms the parser/stripper behave correctly against real bytes.
import assert from 'node:assert/strict';
import { parseJpegExif, stripJpegExif } from '../js/exif.js';

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

// ---- helpers to build a synthetic, real-structure JPEG + EXIF/TIFF blob ----

function u16be(n) { return [(n >> 8) & 0xff, n & 0xff]; }
function u16le(n) { return [n & 0xff, (n >> 8) & 0xff]; }
function u32le(n) { return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]; }
function asciiBytes(str) { return Array.from(str).map((c) => c.charCodeAt(0)); }

/**
 * Build a minimal little-endian TIFF/EXIF blob (the payload after "Exif\0\0")
 * containing IFD0 with Make/Model/Software/DateTime + Artist, an Exif
 * sub-IFD with DateTimeOriginal, and a GPS sub-IFD with lat/lng + refs.
 */
function buildTiffBlob({ make, model, software, dateTime, artist, dateTimeOriginal, gps }) {
  // Layout plan (offsets relative to TIFF header start = 0):
  //   0-7:   TIFF header (byte order 'II', magic 42, offset to IFD0 = 8)
  //   8...:  IFD0
  //   ...:   IFD0 external string data
  //   ...:   Exif sub-IFD
  //   ...:   GPS sub-IFD
  //   ...:   external data for sub-IFDs (rationals etc)
  //
  // Because absolute offset bookkeeping by hand is error-prone, build in
  // stages using arrays and track running offsets explicitly.

  const strings = { make, model, software, dateTime, artist, dateTimeOriginal };
  for (const k of Object.keys(strings)) {
    if (strings[k] !== undefined && !strings[k].endsWith('\0')) strings[k] += '\0';
  }

  // IFD0 entries: Make, Model, Software, DateTime, Artist, ExifIFDPointer, GPSIFDPointer
  const ifd0EntryDefs = [];
  if (strings.make) ifd0EntryDefs.push({ tag: 0x010f, type: 2, str: strings.make });
  if (strings.model) ifd0EntryDefs.push({ tag: 0x0110, type: 2, str: strings.model });
  if (strings.software) ifd0EntryDefs.push({ tag: 0x0131, type: 2, str: strings.software });
  if (strings.dateTime) ifd0EntryDefs.push({ tag: 0x0132, type: 2, str: strings.dateTime });
  if (strings.artist) ifd0EntryDefs.push({ tag: 0x013b, type: 2, str: strings.artist });
  const hasExifSub = !!strings.dateTimeOriginal;
  const hasGpsSub = !!gps;
  if (hasExifSub) ifd0EntryDefs.push({ tag: 0x8769, type: 4, pointerTo: 'exifSub' });
  if (hasGpsSub) ifd0EntryDefs.push({ tag: 0x8825, type: 4, pointerTo: 'gpsSub' });

  const exifSubEntryDefs = [];
  if (strings.dateTimeOriginal) exifSubEntryDefs.push({ tag: 0x9003, type: 2, str: strings.dateTimeOriginal });

  const gpsSubEntryDefs = [];
  if (gps) {
    gpsSubEntryDefs.push({ tag: 0x0001, type: 2, str: (gps.latRef || 'N') + '\0' }); // GPSLatitudeRef
    gpsSubEntryDefs.push({ tag: 0x0002, type: 5, rationals: gps.lat }); // GPSLatitude (3 rationals)
    gpsSubEntryDefs.push({ tag: 0x0003, type: 2, str: (gps.lngRef || 'E') + '\0' }); // GPSLongitudeRef
    gpsSubEntryDefs.push({ tag: 0x0004, type: 5, rationals: gps.lng }); // GPSLongitude (3 rationals)
  }

  // Compute layout offsets.
  const TIFF_HEADER_SIZE = 8;
  const ifd0Size = 2 + ifd0EntryDefs.length * 12 + 4;
  const exifSubSize = hasExifSub ? 2 + exifSubEntryDefs.length * 12 + 4 : 0;
  const gpsSubSize = hasGpsSub ? 2 + gpsSubEntryDefs.length * 12 + 4 : 0;

  const ifd0Offset = TIFF_HEADER_SIZE;
  const exifSubOffset = ifd0Offset + ifd0Size;
  const gpsSubOffset = exifSubOffset + exifSubSize;
  let dataOffset = gpsSubOffset + gpsSubSize; // external data (strings >4 bytes, all rationals) starts here

  function layoutEntries(entryDefs) {
    const laidOut = [];
    for (const def of entryDefs) {
      if (def.str !== undefined) {
        const bytes = asciiBytes(def.str);
        if (bytes.length <= 4) {
          laidOut.push({ ...def, count: bytes.length, inlineBytes: bytes });
        } else {
          laidOut.push({ ...def, count: bytes.length, extOffset: dataOffset, extBytes: bytes });
          dataOffset += bytes.length;
        }
      } else if (def.rationals) {
        const extBytes = [];
        for (const r of def.rationals) {
          extBytes.push(...u32le(r[0]), ...u32le(r[1]));
        }
        laidOut.push({ ...def, count: def.rationals.length, extOffset: dataOffset, extBytes });
        dataOffset += extBytes.length;
      } else if (def.pointerTo) {
        laidOut.push({ ...def, count: 1, pointerTo: def.pointerTo });
      }
    }
    return laidOut;
  }

  const ifd0Laid = layoutEntries(ifd0EntryDefs);
  const exifSubLaid = layoutEntries(exifSubEntryDefs);
  const gpsSubLaid = layoutEntries(gpsSubEntryDefs);

  function serializeIfd(laidEntries, nextIfdOffset, pointerTargets) {
    const bytes = [];
    bytes.push(...u16le(laidEntries.length));
    for (const e of laidEntries) {
      bytes.push(...u16le(e.tag));
      bytes.push(...u16le(e.type));
      bytes.push(...u32le(e.count));
      if (e.inlineBytes) {
        const padded = e.inlineBytes.slice();
        while (padded.length < 4) padded.push(0);
        bytes.push(...padded);
      } else if (e.extOffset !== undefined) {
        bytes.push(...u32le(e.extOffset));
      } else if (e.pointerTo) {
        bytes.push(...u32le(pointerTargets[e.pointerTo]));
      }
    }
    bytes.push(...u32le(nextIfdOffset));
    return bytes;
  }

  const pointerTargets = { exifSub: exifSubOffset, gpsSub: gpsSubOffset };

  const ifd0Bytes = serializeIfd(ifd0Laid, 0, pointerTargets);
  const exifSubBytes = hasExifSub ? serializeIfd(exifSubLaid, 0, pointerTargets) : [];
  const gpsSubBytes = hasGpsSub ? serializeIfd(gpsSubLaid, 0, pointerTargets) : [];

  const extData = [];
  for (const e of [...ifd0Laid, ...exifSubLaid, ...gpsSubLaid]) {
    if (e.extBytes) extData.push(...e.extBytes);
  }

  const header = [0x49, 0x49, ...u16le(42), ...u32le(ifd0Offset)]; // 'II' little-endian
  const all = [...header, ...ifd0Bytes, ...exifSubBytes, ...gpsSubBytes, ...extData];
  return new Uint8Array(all);
}

function buildJpegWithApp1(app1Payload /* Uint8Array, without Exif\0\0 header if raw=false */, { raw = false } = {}) {
  const exifHeader = raw ? [] : asciiBytes('Exif\0\0');
  const app1Body = new Uint8Array([...exifHeader, ...app1Payload]);
  const app1Length = app1Body.length + 2; // includes the 2 length bytes themselves
  const segments = [];
  segments.push(0xff, 0xd8); // SOI
  segments.push(0xff, 0xe1, ...u16be(app1Length), ...app1Body); // APP1/EXIF
  // Minimal fake SOS + a little "scan data" + EOI so parser stops correctly
  segments.push(0xff, 0xda, ...u16be(8), 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
  segments.push(0xaa, 0xbb, 0xcc); // pretend compressed image data
  segments.push(0xff, 0xd9); // EOI
  return new Uint8Array(segments).buffer;
}

function buildPlainJpegNoExif() {
  const segments = [];
  segments.push(0xff, 0xd8); // SOI
  // A JFIF APP0 segment (common in real JPEGs with no EXIF)
  const jfif = [...asciiBytes('JFIF\0'), 1, 2, 0, 0, 1, 0, 1, 0, 0];
  segments.push(0xff, 0xe0, ...u16be(jfif.length + 2), ...jfif);
  segments.push(0xff, 0xda, ...u16be(8), 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
  segments.push(0x11, 0x22, 0x33);
  segments.push(0xff, 0xd9);
  return new Uint8Array(segments).buffer;
}

// ---- tests ----

check('parseJpegExif extracts GPS coordinates and camera model from a real EXIF structure', () => {
  const tiff = buildTiffBlob({
    make: 'TestCam',
    model: 'Model X1000',
    software: 'PostguardTestSuite',
    dateTime: '2024:01:15 10:30:00',
    artist: 'Jane Doe',
    dateTimeOriginal: '2024:01:15 10:29:50',
    gps: {
      latRef: 'N',
      lngRef: 'W',
      lat: [[40, 1], [26, 1], [4614, 100]], // 40 deg 26 min 46.14 sec N
      lng: [[79, 1], [58, 1], [1188, 100]], // 79 deg 58 min 11.88 sec W
    },
  });
  const buf = buildJpegWithApp1(tiff);
  const result = parseJpegExif(buf);

  assert.equal(result.isJpeg, true);
  assert.equal(result.hasExif, true);
  assert.equal(result.tags.Make, 'TestCam');
  assert.equal(result.tags.Model, 'Model X1000');
  assert.equal(result.tags.Software, 'PostguardTestSuite');
  assert.equal(result.tags.Artist, 'Jane Doe');
  assert.equal(result.tags.DateTimeOriginal, '2024:01:15 10:29:50');
  assert.ok(result.tags.GPSLatitude > 40.4 && result.tags.GPSLatitude < 40.5);
  assert.ok(result.tags.GPSLongitude < -79.9 && result.tags.GPSLongitude > -80.0);
  assert.equal(result.tags.GPSLatitudeRef, 'N');
  assert.equal(result.tags.GPSLongitudeRef, 'W');
  assert.ok(result.app1Segment, 'app1Segment location should be reported');
});

check('stripJpegExif removes the APP1 segment so re-parsing finds no EXIF', () => {
  const tiff = buildTiffBlob({
    make: 'TestCam',
    model: 'Model X1000',
    gps: { latRef: 'N', lngRef: 'E', lat: [[1, 1], [0, 1], [0, 1]], lng: [[2, 1], [0, 1], [0, 1]] },
  });
  const buf = buildJpegWithApp1(tiff);
  const before = parseJpegExif(buf);
  assert.equal(before.hasExif, true);

  const stripped = stripJpegExif(buf);
  const after = parseJpegExif(stripped);
  assert.equal(after.isJpeg, true, 'stripped output should still be a valid-looking JPEG (SOI intact)');
  assert.equal(after.hasExif, false, 'no EXIF should remain after stripping');
  assert.equal(after.app1Segment, null);

  // Confirm image scan data bytes (0xaa,0xbb,0xcc after SOS) survived untouched.
  const strippedBytes = new Uint8Array(stripped);
  const strippedStr = Array.from(strippedBytes).join(',');
  assert.ok(strippedStr.includes('170,187,204'), 'image scan bytes (0xaa,0xbb,0xcc) must survive stripping');
});

check('a JPEG with no EXIF segment (e.g. screenshot/already-stripped) is correctly reported as having none', () => {
  const buf = buildPlainJpegNoExif();
  const result = parseJpegExif(buf);
  assert.equal(result.isJpeg, true);
  assert.equal(result.hasExif, false);
  assert.deepEqual(result.tags, {});
  assert.equal(result.app1Segment, null);
});

check('stripJpegExif on a JPEG with no EXIF returns bytes unchanged (no crash, no false stripping)', () => {
  const buf = buildPlainJpegNoExif();
  const stripped = stripJpegExif(buf);
  assert.deepEqual(new Uint8Array(stripped), new Uint8Array(buf));
});

check('parseJpegExif on a non-JPEG buffer reports isJpeg:false without throwing', () => {
  const notJpeg = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 4]).buffer; // "%PDF"
  const result = parseJpegExif(notJpeg);
  assert.equal(result.isJpeg, false);
  assert.equal(result.hasExif, false);
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error('\nSOME CHECKS FAILED');
  process.exit(1);
} else {
  console.log('\nALL CHECKS PASSED');
}
