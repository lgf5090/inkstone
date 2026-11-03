import { strFromU8, unzipSync } from 'fflate'

/** The same ceiling a PDF's words are held to. */
export const OFFICE_TEXT_CHAR_CAP = 48_000

/** One archive entry larger than this is skipped: a document is not a place to unpack a video. */
const MAX_ENTRY_BYTES = 5 * 1024 * 1024

const OFFICE_MIME = /^(application|text)\/(vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|presentationml\.presentation|spreadsheetml\.sheet)|vnd\.ms-|rtf)/i
const OFFICE_EXT = /\.(docx|pptx|xlsx|rtf)$/i

export function isOfficeDocument(mime: string, filename: string): boolean {
  return OFFICE_MIME.test(mime) || OFFICE_EXT.test(filename)
}

function xmlText(source: string): string {
  return source
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/a:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function readZip(bytes: Uint8Array, wanted: (name: string) => boolean): Map<string, string> {
  const files = unzipSync(bytes, {
    filter: (entry) => wanted(entry.name) && entry.size <= MAX_ENTRY_BYTES,
  })
  const out = new Map<string, string>()
  for (const [name, data] of Object.entries(files)) out.set(name, strFromU8(data))
  return out
}

function docxText(bytes: Uint8Array): string {
  const files = readZip(bytes, (name) => name === 'word/document.xml')
  return xmlText(files.get('word/document.xml') ?? '')
}

function pptxText(bytes: Uint8Array): string {
  const files = readZip(bytes, (name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
  const slides = [...files.entries()]
    .sort(([left], [right]) => Number(left.match(/(\d+)/)?.[1] ?? 0) - Number(right.match(/(\d+)/)?.[1] ?? 0))
    .map(([, xml], index) => `Slide ${index + 1}\n${xmlText(xml)}`)
    .filter((text) => text.split('\n').length > 1)
  return slides.join('\n\n')
}

function xlsxText(bytes: Uint8Array): string {
  const files = readZip(bytes, (name) => name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
  const sharedXml = files.get('xl/sharedStrings.xml') ?? ''
  const shared = [...sharedXml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((match) => xmlText(match[1] ?? ''))
  const sheets = [...files.entries()]
    .filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .map(([, xml]) => {
      const rows: string[] = []
      for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells = [...(rowMatch[1] ?? '').matchAll(/<c[^>]*?(?:\st="([^"]*)")?[^>]*>[\s\S]*?<v>([\s\S]*?)<\/v>[\s\S]*?<\/c>/g)]
          .map((cell) => {
            const value = xmlText(cell[2] ?? '')
            return cell[1] === 's' ? shared[Number(value)] ?? '' : value
          })
        if (cells.some(Boolean)) rows.push(cells.join('\t'))
      }
      return rows.join('\n')
    })
    .filter(Boolean)
  return sheets.join('\n\n')
}

/**
 * The words in a Word, PowerPoint or Excel file, read in the browser.
 *
 * The worker has no unzip and no XML parser, and the reader's own browser is already holding the bytes. The
 * three formats are the same container with different XML inside, so one reader handles all of them; RTF is
 * plain text with control words and is reduced to its readable runs. Anything this build cannot open
 * returns an empty string, which the attachment pipeline already reports as "contents not read".
 */
export async function extractOfficeText(file: File): Promise<string> {
  const name = file.name.toLocaleLowerCase()
  try {
    if (name.endsWith('.rtf')) {
      const text = (await file.text())
        .replace(/\\'[0-9a-f]{2}/gi, '')
        .replace(/\\[a-z]+-?\d* ?/gi, '')
        .replace(/[{}]/g, '')
        .trim()
      return text.slice(0, OFFICE_TEXT_CHAR_CAP)
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    const text = name.endsWith('.docx')
      ? docxText(bytes)
      : name.endsWith('.pptx')
        ? pptxText(bytes)
        : name.endsWith('.xlsx')
          ? xlsxText(bytes)
          : ''
    return text.slice(0, OFFICE_TEXT_CHAR_CAP)
  } catch {
    return ''
  }
}
