/**
 * ZIP and EPUB fixtures the reader's tests can read.
 *
 * A checked-in `.epub` would be an opaque blob nobody can review, and the interesting cases are the
 * awkward ones (`../` in an href, a percent-encoded name, a book with only an NCX) that a single real
 * file cannot show without a dozen siblings. So the archive is assembled from bytes here. The writer
 * hands back the offsets a test needs to corrupt one field, because "what happens when the directory
 * lies" is a question you can only ask by lying on purpose.
 */
import { deflateRawSync } from 'node:zlib'

export interface RawMember {
  name: string
  /** The bytes the reader should end up holding. */
  raw: Uint8Array
  /** The bytes actually stored in the archive, which is `raw` for a member kept uncompressed. */
  payload: Uint8Array
  /** 0 stores, 8 deflates; anything else is a method the reader is expected to refuse. */
  method?: number
}

export interface BuiltZip {
  bytes: Uint8Array
  /** Where the first central directory entry starts, so a test can rewrite one of its fields. */
  directoryAt: number
  /** Where the end-of-directory record starts. */
  eocdAt: number
}

const encoder = new TextEncoder()

export function makeZip(members: RawMember[], comment = ''): BuiltZip {
  const parts: Uint8Array[] = []
  const directory: Uint8Array[] = []
  let offset = 0
  for (const member of members) {
    const name = encoder.encode(member.name)
    const method = member.method ?? 8
    const local = new Uint8Array(30 + name.byteLength + member.payload.byteLength)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(8, method, true)
    localView.setUint16(26, name.byteLength, true)
    local.set(name, 30)
    local.set(member.payload, 30 + name.byteLength)
    parts.push(local)

    const entry = new Uint8Array(46 + name.byteLength)
    const view = new DataView(entry.buffer)
    view.setUint32(0, 0x02014b50, true)
    view.setUint16(10, method, true)
    view.setUint32(20, member.payload.byteLength, true)
    view.setUint32(24, member.raw.byteLength, true)
    view.setUint16(28, name.byteLength, true)
    view.setUint32(42, offset, true)
    entry.set(name, 46)
    directory.push(entry)
    offset += local.byteLength
  }

  const commentBytes = encoder.encode(comment)
  const eocd = new Uint8Array(22 + commentBytes.byteLength)
  const eocdView = new DataView(eocd.buffer)
  eocdView.setUint32(0, 0x06054b50, true)
  eocdView.setUint16(8, members.length, true)
  eocdView.setUint16(10, members.length, true)
  eocdView.setUint32(12, directory.reduce((total, one) => total + one.byteLength, 0), true)
  eocdView.setUint32(16, offset, true)
  eocdView.setUint16(20, commentBytes.byteLength, true)
  eocd.set(commentBytes, 22)

  const all = [...parts, ...directory, eocd]
  const bytes = new Uint8Array(all.reduce((total, one) => total + one.byteLength, 0))
  let at = 0
  for (const chunk of all) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return { bytes, directoryAt: offset, eocdAt: bytes.byteLength - eocd.byteLength }
}

/** A 1x1 PNG: a cover fixture only has to be something an <img> will accept. */
export const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

export const CONTAINER_XML = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`

const NAV_XHTML = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Nav</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <ol>
      <li><a href="text/chapter1.xhtml">第一章</a>
        <ol><li><a href="text/chapter1.xhtml#scene">第一场</a></li></ol>
      </li>
      <li><a href="text/chapter%202.xhtml">第二章</a></li>
    </ol>
  </nav>
</body></html>`

const NCX_XML = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:test"/></head>
  <docTitle><text>测试书</text></docTitle>
  <navMap>
    <navPoint id="n1" playOrder="2"><navLabel><text>Chapter Two</text></navLabel><content src="text/../text/chapter%202.xhtml"/></navPoint>
    <navPoint id="n2" playOrder="1"><navLabel><text>Chapter One</text></navLabel><content src="text/chapter1.xhtml"/></navPoint>
  </navMap>
</ncx>`

export const BOOK_CSS = `@charset "utf-8";
@import url("extra.css");
@page { margin: 0; }
@font-face { font-family: "BookFace"; src: url("fonts/book.woff2") format("woff2"); }
html, body { margin: 0; padding: 0; font-family: "BookFace", serif; }
body.dark { background: #111; }
h1 { page-break-before: always; }
p.note > span { color: "quoted } brace"; background: url(../images/note.png); }
@media (max-width: 600px) { h1 { font-size: 1em; } }
@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
@supports (display: grid) { .grid { display: grid; } }`

export const EXTRA_CSS = `.imported { text-indent: 1em; }`

function opf(withNav: boolean, direction = ''): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${withNav ? '3.0' : '2.0'}" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>测试书 · A Test Book</dc:title>
    <dc:creator>某作者</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:identifier id="id">urn:uuid:1234</dc:identifier>
    <dc:publisher>测试出版社</dc:publisher>
    <meta name="cover" content="cover-image"/>
  </metadata>
  <manifest>
    <item id="c1" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/chapter 2.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="cover-image" href="images/cover.png" media-type="image/png" properties="cover-image"/>
    ${withNav ? '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' : ''}
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx"${direction ? ` page-progression-direction="${direction}"` : ''}>
    <itemref idref="c1"/>
    <itemref idref="missing"/>
    <itemref idref="c2"/>
  </spine>
  <guide><reference type="cover" title="Cover" href="titlepage.xhtml"/></guide>
</package>`
}

const CHAPTER1 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title><link rel="stylesheet" type="text/css" href="../style.css"/></head>
<body><h1 id="start">第一章</h1><p>第一段文字。</p><p id="scene">第二段文字，含 <em>强调</em>。</p>
<img src="../images/cover.png" alt=""/><a href="chapter%202.xhtml#start">下一章</a></body></html>`

const CHAPTER2 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Two</title></head>
<body><h1>第二章</h1><p>Second chapter text.</p></body></html>`

const text = (value: string): RawMember['raw'] => encoder.encode(value)

/** A two-chapter EPUB with a nav document, or an EPUB 2 that only carries an NCX. */
export function fixtureEpubArchive(options: { nav?: boolean; direction?: string } = {}): BuiltZip {
  const withNav = options.nav !== false
  return makeZip([
    { name: 'mimetype', raw: text('application/epub+zip'), payload: text('application/epub+zip'), method: 0 },
    { name: 'META-INF/container.xml', raw: text(CONTAINER_XML), payload: deflateRawSync(text(CONTAINER_XML)) },
    { name: 'OEBPS/content.opf', raw: text(opf(withNav, options.direction)), payload: deflateRawSync(text(opf(withNav, options.direction))) },
    { name: 'OEBPS/style.css', raw: text(BOOK_CSS), payload: deflateRawSync(text(BOOK_CSS)) },
    { name: 'OEBPS/extra.css', raw: text(EXTRA_CSS), payload: deflateRawSync(text(EXTRA_CSS)) },
    { name: 'OEBPS/nav.xhtml', raw: text(NAV_XHTML), payload: deflateRawSync(text(NAV_XHTML)) },
    { name: 'OEBPS/toc.ncx', raw: text(NCX_XML), payload: deflateRawSync(text(NCX_XML)) },
    { name: 'OEBPS/text/chapter1.xhtml', raw: text(CHAPTER1), payload: deflateRawSync(text(CHAPTER1)) },
    { name: 'OEBPS/text/chapter 2.xhtml', raw: text(CHAPTER2), payload: deflateRawSync(text(CHAPTER2)) },
    { name: 'OEBPS/images/cover.png', raw: TINY_PNG, payload: TINY_PNG, method: 0 },
  ])
}

export function fixtureEpub(options: { nav?: boolean; direction?: string } = {}): Uint8Array {
  return fixtureEpubArchive(options).bytes
}
