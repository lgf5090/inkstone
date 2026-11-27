import { strToU8, zipSync } from 'fflate'

const CHAPTER_HEADING = /^\s*(\u7b2c[0-9\u96f6\u3007\u4e00\u4e8c\u4e24\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u5343\u4e07\u58f9\u8d30\u53c1\u8086\u4f0d\u9646\u7396\u8d1f\u516b\u7396\u62fe\u4f70\u4edf]+(?:\u7ae0|\u56de|\u8282|\u5377)[^\n]*)$/gm
const FALLBACK_CHAPTER_CHARS = 20_000
const CHAPTER_PREFIX = String.fromCharCode(0x7b2c)
const CHAPTER_SUFFIX = String.fromCharCode(0x7ae0)

export interface TextChapter {
  title: string
  body: string
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]!)
}

export function decodeBookText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('gb18030').decode(bytes)
  }
}

export function splitTextChapters(text: string): TextChapter[] {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
  if (!normalized) return []
  const headings = [...normalized.matchAll(CHAPTER_HEADING)]
  if (headings.length < 2) {
    const chapters: TextChapter[] = []
    for (let at = 0; at < normalized.length; at += FALLBACK_CHAPTER_CHARS) {
      const body = normalized.slice(at, at + FALLBACK_CHAPTER_CHARS)
      chapters.push({ title: `${CHAPTER_PREFIX}${chapters.length + 1}${CHAPTER_SUFFIX}`, body })
    }
    return chapters
  }
  return headings.map((heading, index) => {
    const start = (heading.index ?? 0) + heading[0].length
    const end = headings[index + 1]?.index ?? normalized.length
    return { title: heading[0].trim(), body: normalized.slice(start, end).trim() }
  })
}

export async function textFileToEpub(file: File): Promise<File> {
  const text = decodeBookText(new Uint8Array(await file.arrayBuffer()))
  const chapters = splitTextChapters(text)
  if (!chapters.length) throw new Error('The text file is empty')
  const identifier = `urn:uuid:${crypto.randomUUID()}`
  const manifest = chapters.map((_, index) => `<item id="c${index}" href="chapter-${index}.xhtml" media-type="application/xhtml+xml"/>`).join('')
  const spine = chapters.map((_, index) => `<itemref idref="c${index}"/>`).join('')
  const nav = chapters.map((_, index) => `<li><a href="chapter-${index}.xhtml">${escapeXml(chapters[index]!.title)}</a></li>`).join('')
  const documents = Object.fromEntries(chapters.map((chapter, index) => [
    `OEBPS/chapter-${index}.xhtml`,
    strToU8(`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${escapeXml(chapter.title)}</title></head><body><h1>${escapeXml(chapter.title)}</h1>${chapter.body.split('\n').map((line) => `<p>${escapeXml(line)}</p>`).join('')}</body></html>`),
  ]))
  const files = {
    'mimetype': strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'OEBPS/content.opf': strToU8(`<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escapeXml(file.name.replace(/\.txt$/i, ''))}</dc:title><dc:language>zh-CN</dc:language><dc:identifier id="id">${identifier}</dc:identifier></metadata><manifest>${manifest}<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine>${spine}</spine></package>`),
    'OEBPS/nav.xhtml': strToU8(`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc" id="toc"><ol>${nav}</ol></nav></body></html>`),
    ...documents,
  }
  const bytes = zipSync(files)
  return new File([bytes as unknown as BlobPart], `${file.name.replace(/\.txt$/i, '')}.epub`, { type: 'application/epub+zip' })
}
