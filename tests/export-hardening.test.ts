import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { exportNoteAsHtml, exportNoteAsPdf } from '../src/client/lib/export-note'

const MERMAID_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" class="mermaid" viewBox="0 0 120 40">',
  '<style>.node{fill:red}</style>',
  '<g class="root"><text x="4" y="20">DIAGRAM-OK</text></g>',
  '</svg>',
].join('')

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: MERMAID_SVG })),
  },
}))

const exportSource = readFileSync('src/client/lib/export-note.ts', 'utf8')

it('pins the exported document’s third-party stylesheet with an integrity hash', () => {
  const pinned = exportSource.match(/KATEX_CSS_INTEGRITY = '(sha384-[A-Za-z0-9+/=]{64})'/)
  expect(pinned, 'the export must carry an integrity attribute value').not.toBeNull()
})

it('pins the same bytes the application itself ships', () => {
  const pinned = exportSource.match(/KATEX_CSS_INTEGRITY = 'sha384-([A-Za-z0-9+/=]{64})'/)![1]!
  const local = createHash('sha384').update(readFileSync('node_modules/katex/dist/katex.min.css')).digest('base64')
  const version = JSON.parse(readFileSync('node_modules/katex/package.json', 'utf8')).version as string
  expect(exportSource).toContain(`katex@${version}/dist/katex.min.css`)
  expect(pinned).toBe(local)
})

it('names the visitor nothing on that stylesheet', () => {
  expect(exportSource).toContain('referrerpolicy="no-referrer"')
})

it('keeps the print frame same-origin but scriptless', () => {
  expect(exportSource).toContain("setAttribute('sandbox', 'allow-same-origin allow-modals allow-popups')")
  expect(exportSource).not.toMatch(/sandbox[^\n]*allow-scripts/)
})

const MATH_BODY = 'inline $a^2+b^2$ done\n\n$$x^2 + y^2 = z^2$$\n'
const originalCreateElement = document.createElement.bind(document)

function restoreCreateElement() {
  Object.defineProperty(document, 'createElement', {
    value: originalCreateElement,
    configurable: true,
    writable: true,
  })
}

afterEach(restoreCreateElement)

async function capturePrint(content: string): Promise<{ html: string; printed: number }> {
  let html = ''
  let printed = 0
  Object.defineProperty(document, 'createElement', {
    value: (tag: string, options?: ElementCreationOptions) => {
      const element = originalCreateElement(tag, options)
      if (tag.toLowerCase() === 'iframe') {
        Object.defineProperty(element, 'srcdoc', {
          configurable: true,
          get: () => html,
          set: (value: string) => {
            html = value
            const frameWindow = (element as HTMLIFrameElement).contentWindow
            if (frameWindow) {
              frameWindow.print = () => {
                printed++
              }
            }
            setTimeout(() => element.dispatchEvent(new Event('load')), 0)
          },
        })
      }
      return element
    },
    configurable: true,
    writable: true,
  })
  await exportNoteAsPdf({ title: 'SEC46', content }, 'en-US')
  restoreCreateElement()
  return { html, printed }
}

async function captureDownload(content: string): Promise<string> {
  const blobs: Blob[] = []
  const objectUrl = URL.createObjectURL
  const revokeUrl = URL.revokeObjectURL
  Object.defineProperty(URL, 'createObjectURL', {
    value: (blob: Blob) => {
      blobs.push(blob)
      return 'blob:captured'
    },
    configurable: true,
  })
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true })
  Object.defineProperty(document, 'createElement', {
    value: (tag: string, options?: ElementCreationOptions) => {
      const element = originalCreateElement(tag, options)
      if (tag.toLowerCase() === 'a') element.click = () => {}
      return element
    },
    configurable: true,
    writable: true,
  })
  try {
    await exportNoteAsHtml({ title: 'SEC46', content }, 'en-US')
    return await blobs[0]!.text()
  }
  finally {
    restoreCreateElement()
    Object.defineProperty(URL, 'createObjectURL', { value: objectUrl, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeUrl, configurable: true })
  }
}

it('renders the note’s math into the printed document instead of leaving it blank', async () => {
  const { html, printed } = await capturePrint(MATH_BODY)
  expect(printed).toBe(1)
  expect(html).toContain('class="katex"')
  expect((html.match(/class="katex"/g) ?? []).length).toBe(2)
})

it('carries no third-party stylesheet into the print frame the CSP would refuse', async () => {
  const { html } = await capturePrint(MATH_BODY)
  expect(html).not.toContain('cdn.jsdelivr.net')
  expect(html).not.toMatch(/<link[^>]+rel="stylesheet"/)
  // Which stylesheet the frame gets is a build-time question (vitest stubs CSS), so
  // pin the import itself: the bundled copy, inlined, is the only source allowed here.
  expect(exportSource).toContain("import katexPrintCss from 'katex/dist/katex.min.css?inline'")
  expect(exportSource).toContain('<style>${katexPrintCss}</style>')
})

it('leaves a math-free note with no math stylesheet at all', async () => {
  const html = await captureDownload('# plain\n\nno formulas here\n')
  expect(html).not.toContain('cdn.jsdelivr.net')
  expect(html).not.toContain('katex')
})

it('keeps the downloadable .html on the pinned copy, since no CSP governs it', async () => {
  const html = await captureDownload(MATH_BODY)
  expect(html).toContain('class="katex"')
  expect(html).toContain('https://cdn.jsdelivr.net/npm/katex@')
  expect(html).toContain('integrity="sha384-')
})

const DIAGRAM_BODY = '```mermaid\nflowchart TD\n  A[start] --> B[end]\n```\n'

it('draws the note’s diagram into the printed document instead of a spinner', async () => {
  const { html } = await capturePrint(DIAGRAM_BODY)
  expect(html).toContain('DIAGRAM-OK')
  expect(html).toContain('<svg')
  // the SVG keeps its own styles, which is all the printed page needs to paint it
  expect(html).toContain('.node{fill:red}')
  expect(html).not.toContain('aria-busy="true"')
  expect(html).not.toContain('mermaid-block loading')
})

const TAB_BODY = [
  '# Tabs',
  '',
  ':::: tabs',
  '::: tab-item First',
  'FIRST-MARKER',
  ':::',
  '::: tab-item Second',
  'SECOND-MARKER',
  ':::',
  '::::',
  '',
  '::: details Hidden block',
  'DETAILS-MARKER',
  ':::',
  '',
  '> [!tip]- Folded tip',
  '> CALLOUT-MARKER',
].join('\n')

function parseDocument(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

it('prints every tab panel instead of only the selected one', async () => {
  const { html } = await capturePrint(TAB_BODY)
  const doc = parseDocument(html)
  const panels = [...doc.querySelectorAll<HTMLElement>('[data-tab-panel]')]
  expect(panels).toHaveLength(2)
  expect(panels.map((panel) => panel.hasAttribute('hidden'))).toEqual([false, false])
  expect(html).toContain('FIRST-MARKER')
  expect(html).toContain('SECOND-MARKER')
  expect(doc.querySelectorAll('[data-tab-button]')).toHaveLength(0)
  expect(panels.map((panel) => panel.querySelector('.tab-panel-label')?.textContent)).toEqual(['First', 'Second'])
})

it('prints collapsed details and folded callouts open, with their titles', async () => {
  const { html } = await capturePrint(TAB_BODY)
  expect(html).toContain('DETAILS-MARKER')
  expect(html).toContain('CALLOUT-MARKER')
  const doc = parseDocument(html)
  const blocks = [...doc.querySelectorAll<HTMLElement>('details')]
  expect(blocks.length).toBeGreaterThan(1)
  expect(blocks.every((block) => block.hasAttribute('open'))).toBe(true)
  expect(html).toContain('Hidden block')
  expect(html).toContain('Folded tip')
})

it('carries no control that needs scripts the export does not ship', async () => {
  const { html } = await capturePrint(TAB_BODY + '\n\n```ts\nconst a = 1\n```\n')
  const doc = parseDocument(html)
  expect(doc.querySelectorAll('[data-copy]')).toHaveLength(0)
  expect(doc.querySelectorAll('[data-mermaid-retry]')).toHaveLength(0)
  expect(html).toContain('const a = 1')
})

it('expands the interactive blocks that arrive inside a transclusion', async () => {
  const { html } = await capturePrint([
    '# Outer',
    '',
    'lead paragraph',
    '',
    '![[#Inner tabs]]',
    '',
    '## Inner tabs',
    '',
    ':::: tabs',
    '::: tab-item Only',
    'EMBED-TAB-MARKER',
    ':::',
    '::::',
  ].join('\n'))
  const body = html.slice(html.indexOf('note-embed-body'))
  expect(body).toContain('EMBED-TAB-MARKER')
  const panel = parseDocument(body).querySelector<HTMLElement>('[data-tab-panel]')
  expect(panel, body.slice(0, 200)).not.toBeNull()
  expect(panel!.hasAttribute('hidden')).toBe(false)
  expect(panel!.querySelector('.tab-panel-label')?.textContent).toBe('Only')
})

const EMBED_BODY = [
  '# Outer',
  '',
  'lead paragraph',
  '',
  '![[#Target Section]]',
  '',
  '## Target Section',
  '',
  'EMBEDDED-MARKER with math $a^2$',
].join('\n')

it('expands a transclusion into the printed document instead of a spinner', async () => {
  const { html } = await capturePrint(EMBED_BODY)
  expect(html).toContain('EMBEDDED-MARKER')
  expect(html).toContain('note-embed ready')
  expect(html).not.toContain('aria-busy="true"')
  expect(html).not.toContain('note-embed loading')
  // the embed pass has to run before the math pass, or the formula inside the expanded
  // body stays blank (the section itself also stays in the document, as transclusion does)
  const fromBody = html.slice(html.indexOf('note-embed-body'))
  expect(fromBody.slice(0, fromBody.indexOf('</div>'))).toContain('class="katex"')
})

it('carries the layout blocks into the printed document', async () => {
  const content = [
    '::: justify',
    'a justified paragraph',
    ':::',
    '',
    '::: cols 1fr 2fr',
    'left column',
    '::',
    'right column',
    ':::',
  ].join('\n')
  const { html } = await capturePrint(content)
  expect(html).toContain('markdown-cols')
  expect(html).toContain('data-cols="2"')
  expect(html).toContain('.markdown-cols[data-cols="2"]')
  expect(html).toContain('.markdown-align[data-align="justify"]')
  // The header's fractions only reach CSS as a custom property, so an export that never ran the
  // enhancer would print two equal columns and quietly lose the author's widths.
  expect(html).toContain('--panel-cols-tracks: 1fr 2fr')
})
