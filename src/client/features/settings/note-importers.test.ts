import { downloadZip } from 'client-zip'
import { md5 } from '@noble/hashes/legacy.js'
import { readZip } from '@shared/zip'
import { describe, expect, it } from 'vitest'
import { prepareNoteImport } from './note-importers'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

async function zip(entries: Array<{ path: string, data: Uint8Array }>): Promise<File> {
  const blob = await downloadZip(entries.map((entry) => ({ name: entry.path, input: entry.data }))).blob()
  return new File([blob], 'source.zip', { type: 'application/zip' })
}

async function outputEntries(file: File) {
  return readZip(new Uint8Array(await file.arrayBuffer()))
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
}

describe('third-party note import adapters', () => {
  it('converts standalone HTML to Markdown without scripts or event handlers', async () => {
    const prepared = await prepareNoteImport([
      new File(['<title>Page</title><h1>Heading</h1><p onclick="evil()">Safe <script>evil()</script></p>'], 'page.html', { type: 'text/html' }),
    ])
    expect(prepared.format).toBe('html')
    expect(prepared.files).toHaveLength(1)
    const markdown = await prepared.files[0]!.text()
    expect(markdown).toContain('# Heading')
    expect(markdown).toContain('Safe')
    expect(markdown).not.toContain('<script')
    expect(markdown).not.toContain('onclick')
  })

  it('converts a Notion HTML ZIP while preserving relative assets', async () => {
    const image = new Uint8Array([1, 2, 3])
    const prepared = await prepareNoteImport([
      await zip([
        { path: 'Notes/Page.html', data: encoder.encode('<h1>Notion page</h1><p>Body</p><img src="../assets/pic.png"><script>bad()</script>') },
        { path: 'assets/pic.png', data: image },
      ]),
    ])
    expect(prepared.format).toBe('notion')
    expect(prepared.warnings).toEqual([])
    const entries = await outputEntries(prepared.files[0]!)
    expect(entries.map((entry) => entry.path)).toEqual(expect.arrayContaining(['Notes/Page.md', 'assets/pic.png']))
    const markdown = decoder.decode(entries.find((entry) => entry.path === 'Notes/Page.md')!.data)
    expect(markdown).toContain('# Notion page')
    expect(markdown).toContain('../assets/pic.png')
    expect(markdown).not.toContain('bad()')
  })

  it('imports ENEX notes, tags, dates and base64 resources', async () => {
    const resource = encoder.encode('image bytes')
    const hash = hex(md5(resource))
    const xml = `<?xml version="1.0"?><en-export><note><title>Clipped</title><created>20260102T030405Z</created><updated>20260203T040506Z</updated><tag>read</tag><en-xhtml><![CDATA[<p>Article</p><en-media type="image/png" hash="${hash}"/>]]></en-xhtml><resource><data encoding="base64">${btoa(String.fromCharCode(...resource))}</data><mime-type>image/png</mime-type><resource-attributes><file-name>pic.png</file-name></resource-attributes></resource></note></en-export>`
    const prepared = await prepareNoteImport([new File([xml], 'notes.enex', { type: 'application/xml' })])
    expect(prepared.format).toBe('enex')
    const entries = await outputEntries(prepared.files[0]!)
    const note = entries.find((entry) => entry.path.endsWith('.md'))!
    const markdown = decoder.decode(note.data)
    expect(markdown).toContain('title: "Clipped"')
    expect(markdown).toContain('createdAt: "2026-01-02T03:04:05.000Z"')
    expect(markdown).toContain('tags: ["read"]')
    expect(markdown).toContain(`../attachments/${hash}--pic.png`)
    expect(entries.some((entry) => entry.path === `attachments/${hash}--pic.png`)).toBe(true)
  })

  it('converts Joplin JEX TAR archives into the existing ZIP import path', async () => {
    const body = encoder.encode('# Joplin note\n')
    const tar = tarFile('notes/note.md', body)
    const prepared = await prepareNoteImport([new File([tar.slice().buffer], 'joplin.jex')])
    expect(prepared.format).toBe('joplin')
    const entries = await outputEntries(prepared.files[0]!)
    expect(decoder.decode(entries.find((entry) => entry.path === 'notes/note.md')!.data)).toBe('# Joplin note\n')
  })

  it('leaves Joplin ZIP and ordinary imports on the existing path', async () => {
    const joplin = await zip([{ path: 'notes/note.md', data: encoder.encode('# Note') }])
    expect((await prepareNoteImport([joplin])).format).toBe('joplin')
    expect((await prepareNoteImport([new File(['# Note'], 'note.md')])).format).toBe('original')
  })
})

function tarFile(path: string, body: Uint8Array): Uint8Array {
  const header = new Uint8Array(512)
  const name = encoder.encode(path)
  header.set(name.subarray(0, 100), 0)
  header.set(encoder.encode(`${body.length.toString(8).padStart(11, '0')}\0`), 124)
  header.set(encoder.encode('0000644\0'), 100)
  header.set(encoder.encode('0000000\0'), 108)
  header.set(encoder.encode('0000000\0'), 116)
  header.set(encoder.encode('00000000000\0'), 136)
  header[156] = 48
  header.set(encoder.encode('ustar\0'), 257)
  header.set(encoder.encode('00'), 263)
  header.fill(32, 148, 156)
  const checksum = header.reduce((sum, value) => sum + value, 0)
  header.set(encoder.encode(`${checksum.toString(8).padStart(6, '0')}\0 `), 148)
  const padding = (512 - (body.length % 512)) % 512
  const out = new Uint8Array(512 + body.length + padding + 1024)
  out.set(header, 0)
  out.set(body, 512)
  return out
}
