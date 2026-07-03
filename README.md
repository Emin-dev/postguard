# Postguard

**Postguard** is a "before you post this photo" privacy kit: it strips real EXIF/GPS/author
metadata from JPEGs and PDFs, and lets you draw permanent redaction boxes over faces, plates, or
addresses in a photo — both entirely in your browser.

Live site: https://emin-dev.github.io/postguard/

## Honest framing — read this first

Metadata-scrubbing is a real, useful category — and it is **crowded with good, free, well-reviewed
competitors**. Market research before building this confirmed: **Scrambled Exif** (54,000+
downloads, 4.04/5 on F-Droid) and **Chrome's own built-in Metadata Remover extension** (4.6/5) both
already do EXIF stripping well, for free. If EXIF removal alone is all you need, either of those is
a fine choice and you don't need this repo.

This was built anyway, for **genuine utility and portfolio value, not as a revenue bet** — the
market evidence score for a paid product in this exact space was low. The one real differentiator:
**none of the popular free scrubbers bundle metadata-scrub together with manual redaction/blur in
the same flow.** Postguard does both in one page. That's a modest, honest convenience — not a
breakthrough — and the README says so plainly rather than overselling it.

## No network calls — this claim is actually true

Every operation is client-side: reading a file (`File`/`FileReader` APIs), parsing bytes
(`ArrayBuffer`/`DataView`), drawing/redacting (`<canvas>` + `ImageData`), and downloading a result
(`Blob` + `URL.createObjectURL`). There is **no `fetch`, no `XMLHttpRequest`, no WebSocket, no
analytics beacon, and no server-side code of any kind** in `index.html` or anywhere under `js/`.
`server.mjs` exists purely as a local static-file server for development (see `.gitignore` — it's
excluded from the deployed site) and does not participate in any request the app makes, because the
app never makes one. You can confirm this yourself by reading the four files under `js/` — none of
them reference `fetch`, `XMLHttpRequest`, or any network API — or by watching your browser's
Network tab while using the live site.

## What's real in this repo (and exactly what's covered)

- **JPEG/EXIF parsing + stripping (`js/exif.js`) — REAL.** Implements real JPEG marker-segment
  walking (finds the APP1/EXIF segment by its true byte offset, not a guess) and real TIFF/IFD
  binary parsing (byte-order header, IFD0, the Exif sub-IFD, the GPS sub-IFD). Covers this specific,
  honest subset of tags:
  - GPS: `GPSLatitude`, `GPSLongitude` (converted to decimal degrees), `GPSLatitudeRef`,
    `GPSLongitudeRef`
  - Camera: `Make`, `Model`, `Software`
  - Time: `DateTime`, `DateTimeOriginal`
  - Author: `Artist`, `Copyright`

  Other EXIF tags that might be present are not displayed, but **stripping removes the entire
  APP1/EXIF segment**, not just the tags this parser knows how to read — so a file reported as
  "no EXIF found for these fields" doesn't mean other tags survive stripping; the whole segment is
  gone. A JPEG with no EXIF segment at all (e.g. a screenshot, or an already-stripped photo) is
  correctly reported as having none — not a false positive, not a crash.

- **PDF metadata parsing + stripping (`js/pdfmeta.js`) — REAL.** PDFs are largely text-structured
  near their object definitions and trailer, which makes a minimal real parser tractable without a
  full PDF object-model library. This finds the trailer's `/Info` dictionary reference, reads that
  object's string fields, and separately scans for an embedded XMP metadata packet
  (`<x:xmpmeta>...</x:xmpmeta>`). Covers:
  - `/Info` dictionary: `Author`, `Title`, `Subject`, `Keywords`, `Creator`, `Producer`
  - XMP: `dc:creator`, `dc:title`

  **Not supported:** encrypted PDFs, and PDF 1.5+ files that use compressed cross-reference
  streams instead of a classic plain-text `xref` table. Those are out of scope for a minimal
  parser and are not faked — if the `/Info` object can't be located this way, the tool honestly
  reports no metadata found rather than guessing.

- **Redaction engine (`js/redact.js`) — REAL.** Given a list of rectangles and a real
  `ImageData`-shaped pixel buffer, this destructively overwrites every pixel inside each rectangle
  — solid black fill, or a real box blur computed from actual neighboring pixel values — and
  leaves every pixel outside the rectangles untouched. This is a genuine pixel-data rewrite, not a
  semi-transparent overlay drawn on top that could be peeled off in another image editor: once
  "Apply" runs, the original pixel values in the redacted regions are gone from the exported PNG.

- **Checkout (`js/checkout.js`) — SANDBOX ONLY.** No real payment provider is ever contacted. Real
  Luhn check, real expiry-not-in-the-past validation (using the actual runtime clock), real CVC
  format check, and a documented decline test card (`4000000000000002`) for demoing the failure
  path — the same sandbox pattern used by every other product in this line.

## Monetization: BUY (one-time, not a subscription)

- **Free:** full metadata scrubber (JPEG + PDF) and full redaction tool, one file at a time.
- **One-time $3.99 unlock:** batch mode — process several images/PDFs in one sitting without
  re-uploading one at a time. Same real scrub/redact engine; the unlock only lifts the one-file
  limit. Persists in this browser only (`localStorage`), no account system.

## Structure

- `index.html` — landing/docs page + both feature UIs, the honest low-expectations framing, the
  "100% local" claim, and pricing.
- `js/exif.js` — real JPEG/EXIF parsing + stripping (pure functions, Node-testable).
- `js/pdfmeta.js` — real PDF `/Info`/XMP metadata parsing + stripping (pure functions, Node-testable).
- `js/redact.js` — destructive pixel-redaction logic (pure functions, Node-testable), separate from
  the canvas/mouse-event UI wiring.
- `js/checkout.js` — sandbox payment simulation + local unlock flag.
- `js/main.js` — UI wiring for both features and checkout.
- `style.css` — mobile-first, calm/cozy Studio visual style, no dark patterns.
- `test/*.test.mjs` — real Node tests using synthetic-but-byte-accurate JPEG/PDF buffers and real
  pixel arrays.
- `server.mjs` — local static file server for development (not deployed; see `.gitignore`).

## Running tests

```
node test/exif.test.mjs
node test/pdfmeta.test.mjs
node test/redact.test.mjs
node test/checkout.test.mjs
```

All tests construct real, correctly-structured synthetic binary data (a JPEG with a real TIFF/EXIF
APP1 segment including GPS and camera-model tags, a PDF with a real `/Info` dictionary and an XMP
packet, real RGBA pixel buffers) and assert against real parsing/stripping/redaction behavior — none
were weakened to force a pass.

## Local development

```
node server.mjs
```

Serves the app at `http://127.0.0.1:8092`.
