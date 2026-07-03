// pdfmeta.js — real, minimal PDF metadata parsing + stripping.
// Pure functions only, Node-testable with synthetic byte buffers.
//
// Scope (be honest about what's covered): PDFs are mostly-text near their
// object definitions and trailer. This module finds the trailer's /Info
// dictionary reference, reads that object's Author/Title/Creator/Producer/
// Subject/Keywords string fields, and also scans for an XMP metadata stream
// (<x:xmpmeta>...</x:xmpmeta>) to pull dc:creator / dc:title if present.
// It does NOT implement a full PDF object model, cross-reference streams
// (PDF 1.5+ compressed xref), or encrypted PDFs — those are out of scope
// for a "real but minimal" parser. If the /Info dictionary can't be found
// by the simple scan, that is reported honestly rather than guessed at.

const INFO_FIELD_NAMES = ['Author', 'Title', 'Subject', 'Keywords', 'Creator', 'Producer'];

function bufToLatin1String(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  // chunk to avoid call-stack blowups on large files
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return s;
}

function isPdf(buf) {
  const head = bufToLatin1String(buf.slice(0, 8));
  return head.startsWith('%PDF-');
}

/** Decode a PDF literal string "(...)" honoring backslash escapes minimally. */
function decodePdfLiteralString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next === 'n') { out += '\n'; i++; }
      else if (next === 'r') { out += '\r'; i++; }
      else if (next === 't') { out += '\t'; i++; }
      else if (next === '(' || next === ')' || next === '\\') { out += next; i++; }
      else if (/[0-7]/.test(next)) {
        // octal escape, up to 3 digits
        let oct = '';
        let j = i + 1;
        while (j < raw.length && oct.length < 3 && /[0-7]/.test(raw[j])) { oct += raw[j]; j++; }
        out += String.fromCharCode(parseInt(oct, 8));
        i = j - 1;
      } else {
        out += next;
        i++;
      }
    } else {
      out += c;
    }
  }
  return out;
}

/** Decode a PDF hex string "<...>". */
function decodePdfHexString(raw) {
  const hex = raw.replace(/[^0-9a-fA-F]/g, '');
  let out = '';
  for (let i = 0; i + 1 < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }
  return out;
}

/**
 * Find the object body "N G obj ... endobj" for a given object number in
 * the raw PDF text. Returns { start, end, body } (start/end are character
 * offsets of the whole "N G obj...endobj" block) or null if not found.
 */
function findObjectBody(text, objNum) {
  const re = new RegExp(`(^|[^0-9])${objNum}\\s+\\d+\\s+obj\\b`, 'g');
  const m = re.exec(text);
  if (!m) return null;
  const start = m.index + m[0].indexOf(`${objNum}`, m[1] ? m[1].length : 0) + (m[1] ? 0 : 0);
  const objStart = m.index + (m[1] ? m[1].length : 0);
  const bodyStart = m.index + m[0].length;
  const endIdx = text.indexOf('endobj', bodyStart);
  const end = endIdx === -1 ? text.length : endIdx + 'endobj'.length;
  return { start: objStart, end, body: text.slice(bodyStart, endIdx === -1 ? text.length : endIdx) };
}

/** Locate the trailer's /Info reference, e.g. "/Info 5 0 R". */
function findInfoObjectNumber(text) {
  const m = /\/Info\s+(\d+)\s+\d+\s+R/.exec(text);
  return m ? parseInt(m[1], 10) : null;
}

/** Parse "/Key (literal)" or "/Key <hex>" pairs out of a dictionary body. */
function parseDictStringFields(body, fieldNames) {
  const fields = {};
  for (const name of fieldNames) {
    const litRe = new RegExp(`/${name}\\s*\\(`, 'g');
    const litMatch = litRe.exec(body);
    if (litMatch) {
      // find matching close paren, honoring escaped parens
      let i = litMatch.index + litMatch[0].length;
      let depth = 1;
      let raw = '';
      while (i < body.length && depth > 0) {
        const c = body[i];
        if (c === '\\') { raw += c + (body[i + 1] || ''); i += 2; continue; }
        if (c === '(') depth++;
        if (c === ')') { depth--; if (depth === 0) break; }
        raw += c;
        i++;
      }
      fields[name] = decodePdfLiteralString(raw);
      continue;
    }
    const hexRe = new RegExp(`/${name}\\s*<([^>]*)>`);
    const hexMatch = hexRe.exec(body);
    if (hexMatch) {
      fields[name] = decodePdfHexString(hexMatch[1]);
    }
  }
  return fields;
}

/** Extract dc:creator / dc:title from an embedded XMP packet, if present. */
function parseXmp(text) {
  const start = text.indexOf('<x:xmpmeta');
  const end = text.indexOf('</x:xmpmeta>');
  if (start === -1 || end === -1) return null;
  const xmp = text.slice(start, end + '</x:xmpmeta>'.length);
  const fields = {};
  const creatorMatch = /<dc:creator>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/.exec(xmp);
  if (creatorMatch) fields.XmpCreator = creatorMatch[1].trim();
  const titleMatch = /<dc:title>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/.exec(xmp);
  if (titleMatch) fields.XmpTitle = titleMatch[1].trim();
  return { fields, start, end: end + '</x:xmpmeta>'.length };
}

/**
 * Parse a PDF ArrayBuffer for /Info dictionary fields + XMP creator/title.
 * Returns { isPdf, hasMetadata, tags, infoObject, xmpRange } where
 * infoObject (if found) is { objNum, bodyStart, bodyEnd } in character
 * offsets of the latin1-decoded text, and xmpRange is { start, end } char
 * offsets of the XMP packet if one was found.
 */
export function parsePdfMetadata(arrayBuffer) {
  if (!isPdf(arrayBuffer)) {
    return { isPdf: false, hasMetadata: false, tags: {}, infoObject: null, xmpRange: null };
  }
  const text = bufToLatin1String(arrayBuffer);

  let tags = {};
  let infoObject = null;

  const infoObjNum = findInfoObjectNumber(text);
  if (infoObjNum !== null) {
    const obj = findObjectBody(text, infoObjNum);
    if (obj) {
      const fields = parseDictStringFields(obj.body, INFO_FIELD_NAMES);
      tags = { ...tags, ...fields };
      infoObject = { objNum: infoObjNum, bodyStart: obj.start, bodyEnd: obj.end };
    }
  }

  let xmpRange = null;
  const xmp = parseXmp(text);
  if (xmp) {
    tags = { ...tags, ...xmp.fields };
    xmpRange = { start: xmp.start, end: xmp.end };
  }

  const hasMetadata = Object.keys(tags).length > 0;
  return { isPdf: true, hasMetadata, tags, infoObject, xmpRange };
}

/**
 * Produce a new ArrayBuffer with the /Info dictionary's known string
 * fields blanked out (replaced with empty literal strings, same
 * structural position, so offsets/xref elsewhere in a simple PDF are
 * minimally disturbed) and the XMP metadata packet's dc:creator/dc:title
 * values blanked. This is a text-level rewrite appropriate for the
 * minimal, non-cross-reference-stream PDFs this parser supports.
 */
export function stripPdfMetadata(arrayBuffer) {
  const { infoObject, xmpRange } = parsePdfMetadata(arrayBuffer);
  if (!infoObject && !xmpRange) {
    return arrayBuffer.slice(0);
  }

  const text = bufToLatin1String(arrayBuffer);
  let result = text;

  if (infoObject) {
    const body = result.slice(infoObject.bodyStart, infoObject.bodyEnd);
    let newBody = body;
    for (const name of INFO_FIELD_NAMES) {
      newBody = newBody.replace(new RegExp(`(/${name}\\s*)\\(((?:\\\\.|[^\\\\)])*)\\)`), '$1()');
      newBody = newBody.replace(new RegExp(`(/${name}\\s*)<[^>]*>`), '$1()');
    }
    result = result.slice(0, infoObject.bodyStart) + newBody + result.slice(infoObject.bodyEnd);
  }

  if (xmpRange) {
    // re-locate xmp range in `result` in case infoObject rewrite shifted length
    const xmp = parseXmp(result);
    if (xmp) {
      let xmpText = result.slice(xmp.start, xmp.end);
      xmpText = xmpText.replace(/(<dc:creator>[\s\S]*?<rdf:li[^>]*>)([\s\S]*?)(<\/rdf:li>)/, '$1$3');
      xmpText = xmpText.replace(/(<dc:title>[\s\S]*?<rdf:li[^>]*>)([\s\S]*?)(<\/rdf:li>)/, '$1$3');
      result = result.slice(0, xmp.start) + xmpText + result.slice(xmp.end);
    }
  }

  // encode back to bytes 1:1 (latin1 round-trip; PDF structural bytes are <128 or preserved as raw code points 128-255)
  const out = new Uint8Array(result.length);
  for (let i = 0; i < result.length; i++) out[i] = result.charCodeAt(i) & 0xff;
  return out.buffer;
}

export const PDF_FIELD_LABELS = {
  Author: 'Author',
  Title: 'Title',
  Subject: 'Subject',
  Keywords: 'Keywords',
  Creator: 'Creator (tool)',
  Producer: 'Producer (tool)',
  XmpCreator: 'XMP creator',
  XmpTitle: 'XMP title',
};
