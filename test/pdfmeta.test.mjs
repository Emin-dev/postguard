// Real verification for js/pdfmeta.js — constructs a minimal but real-
// structure synthetic PDF byte buffer (real object/trailer syntax) and
// confirms /Info dictionary extraction + stripping behave correctly.
import assert from 'node:assert/strict';
import { parsePdfMetadata, stripPdfMetadata } from '../js/pdfmeta.js';

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

function textToBuffer(str) {
  const arr = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) arr[i] = str.charCodeAt(i) & 0xff;
  return arr.buffer;
}

/** Build a minimal, real-structure PDF with a /Info dict (Author/Title). */
function buildMinimalPdf({ author, title, creator, includeXmp = false } = {}) {
  const xmpBlock = includeXmp
    ? `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description><dc:creator><rdf:Seq><rdf:li>${author}</rdf:li></rdf:Seq></dc:creator><dc:title><rdf:Alt><rdf:li>${title}</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta>`
    : '';

  const parts = [];
  parts.push('%PDF-1.4\n');
  parts.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  parts.push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  parts.push('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n');
  let infoFields = `/Author (${author}) /Title (${title})`;
  if (creator) infoFields += ` /Creator (${creator})`;
  parts.push(`4 0 obj\n<< ${infoFields} >>\nendobj\n`);
  if (includeXmp) {
    parts.push(`5 0 obj\n<< /Type /Metadata /Subtype /XML /Length ${xmpBlock.length} >>\nstream\n${xmpBlock}\nendstream\nendobj\n`);
  }
  const body = parts.join('');
  const xrefOffset = body.length;
  const trailer = `xref\n0 ${includeXmp ? 6 : 5}\ntrailer\n<< /Size ${includeXmp ? 6 : 5} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return textToBuffer(body + trailer);
}

function buildPdfWithoutInfo() {
  const parts = [];
  parts.push('%PDF-1.4\n');
  parts.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  parts.push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  parts.push('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n');
  const body = parts.join('');
  const trailer = `xref\n0 4\ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${body.length}\n%%EOF`;
  return textToBuffer(body + trailer);
}

// ---- tests ----

check('parsePdfMetadata extracts Author and Title from a real /Info dictionary', () => {
  const buf = buildMinimalPdf({ author: 'Jane Doe', title: 'Confidential Report', creator: 'Postguard Test' });
  const result = parsePdfMetadata(buf);
  assert.equal(result.isPdf, true);
  assert.equal(result.hasMetadata, true);
  assert.equal(result.tags.Author, 'Jane Doe');
  assert.equal(result.tags.Title, 'Confidential Report');
  assert.equal(result.tags.Creator, 'Postguard Test');
  assert.ok(result.infoObject);
});

check('parsePdfMetadata extracts dc:creator/dc:title from an embedded XMP packet', () => {
  const buf = buildMinimalPdf({ author: 'XmpAuthor', title: 'XmpTitleHere', includeXmp: true });
  const result = parsePdfMetadata(buf);
  assert.equal(result.tags.XmpCreator, 'XmpAuthor');
  assert.equal(result.tags.XmpTitle, 'XmpTitleHere');
  assert.ok(result.xmpRange);
});

check('stripPdfMetadata blanks Author/Title fields so re-parsing finds them empty', () => {
  const buf = buildMinimalPdf({ author: 'Jane Doe', title: 'Confidential Report', creator: 'Postguard Test' });
  const stripped = stripPdfMetadata(buf);
  const after = parsePdfMetadata(stripped);
  assert.equal(after.isPdf, true);
  assert.equal(after.tags.Author, '', 'Author field should be blanked, not left with original value');
  assert.equal(after.tags.Title, '');
  assert.ok(!after.tags.Author || after.tags.Author === '', 'no trace of original author value should remain');

  // Confirm the original sensitive string is gone from the raw bytes entirely.
  const strippedText = Buffer.from(stripped).toString('latin1');
  assert.ok(!strippedText.includes('Jane Doe'), 'original author name must not survive in stripped bytes');
  assert.ok(!strippedText.includes('Confidential Report'), 'original title must not survive in stripped bytes');
});

check('stripPdfMetadata blanks XMP dc:creator/dc:title too', () => {
  const buf = buildMinimalPdf({ author: 'XmpAuthor', title: 'XmpTitleHere', includeXmp: true });
  const stripped = stripPdfMetadata(buf);
  const strippedText = Buffer.from(stripped).toString('latin1');
  assert.ok(!strippedText.includes('XmpAuthor'));
  assert.ok(!strippedText.includes('XmpTitleHere'));
});

check('a PDF with no /Info dictionary is correctly reported as having no metadata (not a crash)', () => {
  const buf = buildPdfWithoutInfo();
  const result = parsePdfMetadata(buf);
  assert.equal(result.isPdf, true);
  assert.equal(result.hasMetadata, false);
  assert.deepEqual(result.tags, {});
  assert.equal(result.infoObject, null);
});

check('stripPdfMetadata on a PDF with no metadata returns bytes unchanged', () => {
  const buf = buildPdfWithoutInfo();
  const stripped = stripPdfMetadata(buf);
  assert.deepEqual(new Uint8Array(stripped), new Uint8Array(buf));
});

check('parsePdfMetadata on a non-PDF buffer reports isPdf:false without throwing', () => {
  const notPdf = textToBuffer('this is not a pdf at all');
  const result = parsePdfMetadata(notPdf);
  assert.equal(result.isPdf, false);
  assert.equal(result.hasMetadata, false);
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error('\nSOME CHECKS FAILED');
  process.exit(1);
} else {
  console.log('\nALL CHECKS PASSED');
}
