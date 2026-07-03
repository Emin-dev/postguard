// exif.js — real, minimal JPEG/EXIF binary parsing + stripping.
// Pure functions only: takes an ArrayBuffer in, returns plain data out.
// No DOM, no fetch, no File API here — that lives in main.js. This module
// is Node-testable with synthetic byte buffers (see test/exif.test.mjs).
//
// Scope (be honest about what's covered): this reads the JPEG APP1/EXIF
// segment's TIFF-structured IFD0 + the GPS sub-IFD + the Exif sub-IFD, and
// extracts a specific, common subset of tags:
//   - GPS: GPSLatitude, GPSLatitudeRef, GPSLongitude, GPSLongitudeRef
//   - Camera: Make, Model, Software
//   - Time: DateTime (IFD0), DateTimeOriginal (Exif sub-IFD)
//   - Author: Artist, Copyright
// Any other EXIF tags present are ignored for display purposes, but
// stripping removes the *entire* APP1 segment, not just the tags we know
// how to read — so stripping is complete even where reading is partial.

const JPEG_SOI = 0xffd8;
const APP1_MARKER = 0xffe1;
const EXIF_HEADER = 'Exif\0\0';

/**
 * Walk a JPEG's marker segments starting after the SOI marker.
 * Returns an array of { marker, offset, length, dataOffset } for every
 * segment found, stopping at SOS (0xffda) or EOI (0xffd9) or end of buffer.
 * offset = position of the 0xFF marker byte itself.
 * dataOffset = position right after the 2-byte length field (start of payload).
 * length = the 2-byte length field value (includes itself, per JPEG spec).
 */
function walkSegments(view) {
  const segments = [];
  let pos = 2; // skip SOI
  while (pos + 4 <= view.byteLength) {
    if (view.getUint8(pos) !== 0xff) break; // malformed / not a marker
    let marker = view.getUint8(pos + 1);
    let mpos = pos;
    // skip fill bytes (0xFF padding before the real marker byte)
    let p2 = pos + 1;
    while (view.getUint8(p2) === 0xff && p2 + 1 < view.byteLength) p2++;
    marker = 0xff00 | view.getUint8(p2);
    const markerStart = p2 - 1;

    // Markers with no payload (standalone): 0xD0-0xD9, 0x01
    if (marker === 0xffd9 /* EOI */) break;
    if (marker === 0xffda /* SOS */) break; // scan data follows; stop walking
    if ((marker >= 0xffd0 && marker <= 0xffd7) || marker === 0xff01) {
      segments.push({ marker, offset: markerStart, length: 0, dataOffset: markerStart + 2 });
      pos = markerStart + 2;
      continue;
    }

    if (markerStart + 4 > view.byteLength) break;
    const length = view.getUint16(markerStart + 2, false); // big-endian, includes these 2 length bytes
    const dataOffset = markerStart + 4;
    segments.push({ marker, offset: markerStart, length, dataOffset });
    pos = markerStart + 2 + length;
  }
  return segments;
}

function isJpeg(buf) {
  if (buf.byteLength < 4) return false;
  const view = new DataView(buf);
  return view.getUint16(0, false) === JPEG_SOI;
}

const TAG_NAMES = {
  0x010f: 'Make',
  0x0110: 'Model',
  0x0131: 'Software',
  0x0132: 'DateTime',
  0x9003: 'DateTimeOriginal',
  0x013b: 'Artist',
  0x8298: 'Copyright',
};

const IFD_EXIF_SUBIFD_TAG = 0x8769;
const IFD_GPS_SUBIFD_TAG = 0x8825;

const GPS_TAG_NAMES = {
  0x0001: 'GPSLatitudeRef',
  0x0002: 'GPSLatitude',
  0x0003: 'GPSLongitudeRef',
  0x0004: 'GPSLongitude',
};

const TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

function readRational(view, offset, little) {
  const num = view.getUint32(offset, little);
  const den = view.getUint32(offset + 4, little);
  return den === 0 ? 0 : num / den;
}

function gpsToDecimal(dms, ref) {
  if (!Array.isArray(dms) || dms.length !== 3) return null;
  const [d, m, s] = dms;
  let dec = d + m / 60 + s / 3600;
  if (ref === 'S' || ref === 'W') dec = -dec;
  return dec;
}

/**
 * Parse one IFD (Image File Directory) starting at `ifdOffset` (relative to
 * the start of the TIFF header, tiffBase). Returns { tags: {tagId: value},
 * nextIfdOffset }.
 */
function parseIfd(view, tiffBase, ifdOffset, little, wantedNames) {
  const tags = {};
  if (ifdOffset <= 0 || tiffBase + ifdOffset + 2 > view.byteLength) {
    return { tags, nextIfdOffset: 0 };
  }
  const entryCount = view.getUint16(tiffBase + ifdOffset, little);
  let pos = tiffBase + ifdOffset + 2;
  for (let i = 0; i < entryCount; i++) {
    if (pos + 12 > view.byteLength) break;
    const tagId = view.getUint16(pos, little);
    const type = view.getUint16(pos + 2, little);
    const count = view.getUint32(pos + 4, little);
    const valueOffsetPos = pos + 8;
    const unitSize = TYPE_SIZES[type] || 1;
    const totalSize = unitSize * count;
    const dataPos = totalSize <= 4 ? valueOffsetPos : tiffBase + view.getUint32(valueOffsetPos, little);

    const name = wantedNames[tagId];
    if (name && dataPos + totalSize <= view.byteLength) {
      if (type === 2) {
        // ASCII string
        let str = '';
        for (let k = 0; k < count; k++) {
          const c = view.getUint8(dataPos + k);
          if (c === 0) break;
          str += String.fromCharCode(c);
        }
        tags[name] = str;
      } else if (type === 5) {
        // RATIONAL (or array of them, e.g. GPS lat/lng = 3 rationals)
        if (count === 1) {
          tags[name] = readRational(view, dataPos, little);
        } else {
          const arr = [];
          for (let k = 0; k < count; k++) arr.push(readRational(view, dataPos + k * 8, little));
          tags[name] = arr;
        }
      } else if (type === 1) {
        // BYTE (e.g. GPSLatitudeRef stored as byte/ascii-ish)
        tags[name] = view.getUint8(dataPos);
      }
    }

    // capture sub-IFD pointers regardless of "wanted" list
    if (tagId === IFD_EXIF_SUBIFD_TAG || tagId === IFD_GPS_SUBIFD_TAG) {
      tags[`__subifd_${tagId}`] = view.getUint32(valueOffsetPos, little);
    }

    pos += 12;
  }
  const nextIfdOffset = pos + 4 <= view.byteLength ? view.getUint32(pos, little) : 0;
  return { tags, nextIfdOffset };
}

/**
 * Parse the TIFF structure inside an APP1/EXIF payload (the bytes right
 * after the "Exif\0\0" header). Returns a flat metadata object with
 * whichever of the known tags were found.
 */
function parseTiff(buf, tiffStart) {
  const view = new DataView(buf);
  const byteOrder = view.getUint16(tiffStart, false);
  const little = byteOrder === 0x4949; // 'II'
  if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d /* 'MM' */) return null;
  const magic = view.getUint16(tiffStart + 2, little);
  if (magic !== 42) return null;
  const ifd0Offset = view.getUint32(tiffStart + 4, little);

  const result = {};

  const { tags: ifd0Tags } = parseIfd(view, tiffStart, ifd0Offset, little, TAG_NAMES);
  for (const [k, v] of Object.entries(ifd0Tags)) {
    if (!k.startsWith('__subifd_')) result[k] = v;
  }

  const exifSubIfdOffset = ifd0Tags[`__subifd_${IFD_EXIF_SUBIFD_TAG}`];
  if (exifSubIfdOffset) {
    const { tags: exifTags } = parseIfd(view, tiffStart, exifSubIfdOffset, little, TAG_NAMES);
    for (const [k, v] of Object.entries(exifTags)) {
      if (!k.startsWith('__subifd_') && result[k] === undefined) result[k] = v;
    }
  }

  const gpsSubIfdOffset = ifd0Tags[`__subifd_${IFD_GPS_SUBIFD_TAG}`];
  if (gpsSubIfdOffset) {
    const { tags: gpsTags } = parseIfd(view, tiffStart, gpsSubIfdOffset, little, GPS_TAG_NAMES);
    const latRefRaw = gpsTags.GPSLatitudeRef;
    const lngRefRaw = gpsTags.GPSLongitudeRef;
    // GPSLatitudeRef/GPSLongitudeRef are technically ASCII in the spec, but
    // some encoders store as byte; normalize both.
    const latRef = typeof latRefRaw === 'string' ? latRefRaw : latRefRaw ? String.fromCharCode(latRefRaw) : undefined;
    const lngRef = typeof lngRefRaw === 'string' ? lngRefRaw : lngRefRaw ? String.fromCharCode(lngRefRaw) : undefined;
    if (gpsTags.GPSLatitude) {
      const dec = gpsToDecimal(gpsTags.GPSLatitude, latRef);
      if (dec !== null) result.GPSLatitude = dec;
    }
    if (gpsTags.GPSLongitude) {
      const dec = gpsToDecimal(gpsTags.GPSLongitude, lngRef);
      if (dec !== null) result.GPSLongitude = dec;
    }
    if (latRef) result.GPSLatitudeRef = latRef;
    if (lngRef) result.GPSLongitudeRef = lngRef;
  }

  return result;
}

/**
 * Parse EXIF metadata out of a JPEG ArrayBuffer.
 * Returns { isJpeg, hasExif, tags, app1Segment } where app1Segment (if
 * present) is { offset, length } describing the raw APP1 segment location
 * in the original buffer, so it can be stripped.
 */
export function parseJpegExif(arrayBuffer) {
  if (!isJpeg(arrayBuffer)) {
    return { isJpeg: false, hasExif: false, tags: {}, app1Segment: null };
  }
  const view = new DataView(arrayBuffer);
  const segments = walkSegments(view);

  let app1Segment = null;
  for (const seg of segments) {
    if (seg.marker === APP1_MARKER) {
      // Confirm this APP1 is actually Exif (APP1 is also used for XMP)
      const headerBytes = [];
      for (let i = 0; i < EXIF_HEADER.length; i++) {
        headerBytes.push(view.getUint8(seg.dataOffset + i));
      }
      const headerStr = headerBytes.map((b) => String.fromCharCode(b)).join('');
      if (headerStr === EXIF_HEADER) {
        app1Segment = seg;
        break;
      }
    }
  }

  if (!app1Segment) {
    return { isJpeg: true, hasExif: false, tags: {}, app1Segment: null };
  }

  const tiffStart = app1Segment.dataOffset + EXIF_HEADER.length;
  const tags = parseTiff(arrayBuffer, tiffStart) || {};
  const hasExif = Object.keys(tags).length > 0;

  return {
    isJpeg: true,
    hasExif,
    tags,
    app1Segment: { offset: app1Segment.offset, length: app1Segment.length + 2 }, // +2: length field excludes the 0xFFE1 marker bytes themselves
  };
}

/**
 * Produce a new ArrayBuffer identical to the input JPEG but with the
 * APP1/EXIF marker segment (if present) removed entirely. Image data
 * (the SOS-onward scan data) is untouched. If no EXIF segment is present,
 * returns a copy of the original bytes unchanged.
 */
export function stripJpegExif(arrayBuffer) {
  const { app1Segment } = parseJpegExif(arrayBuffer);
  if (!app1Segment) {
    return arrayBuffer.slice(0);
  }
  const before = arrayBuffer.slice(0, app1Segment.offset);
  const after = arrayBuffer.slice(app1Segment.offset + app1Segment.length);
  const out = new Uint8Array(before.byteLength + after.byteLength);
  out.set(new Uint8Array(before), 0);
  out.set(new Uint8Array(after), before.byteLength);
  return out.buffer;
}

/** Human-readable labels for the tags object, for UI display. */
export const EXIF_FIELD_LABELS = {
  Make: 'Camera make',
  Model: 'Camera model',
  Software: 'Software',
  DateTime: 'Date/time',
  DateTimeOriginal: 'Date taken',
  Artist: 'Artist / author',
  Copyright: 'Copyright',
  GPSLatitude: 'GPS latitude',
  GPSLongitude: 'GPS longitude',
  GPSLatitudeRef: 'GPS lat. ref',
  GPSLongitudeRef: 'GPS lng. ref',
};
