import { renderMarkdown } from './markdown/renderer'
import { bakeChartsToImages, renderMath, renderPendingCharts, renderPendingMermaid } from './markdown/enhance'
import { resolveNoteEmbeds } from './markdown/embeds'
import { registerFenceBodies } from './markdown/fence-bodies'
import { renderStaticKanbans } from './markdown/kanban/static'
// Inlined so the print frame carries its own math styles: the frame inherits this
// document's CSP (`style-src 'self' 'unsafe-inline'`, `font-src 'self' data:`), which
// refuses the CDN stylesheet, and the bundled url()s resolve to our own /assets/fonts.
import katexPrintCss from 'katex/dist/katex.min.css?inline'

// Pinned so an exported document cannot silently load a different stylesheet: the hash
// is the sha384 of node_modules/katex/dist/katex.min.css for the version in package.json.
const KATEX_CSS_URL = 'https://cdn.jsdelivr.net/npm/katex@0.18.1/dist/katex.min.css'
const KATEX_CSS_INTEGRITY = 'sha384-1vdNCNel6Tx/NQa8IR1mGOGKsbGreCkOPfbtPPnUURJ5Tu2PRVfQ/7KLZC+Pi1p1'

// A downloaded .html has no CSP around it and is often opened away from the instance,
// so it keeps the pinned CDN copy; the print frame cannot load it and inlines instead.
const CDN_MATH_STYLESHEET = `<link rel="stylesheet" href="${KATEX_CSS_URL}" crossorigin="anonymous" referrerpolicy="no-referrer" integrity="${KATEX_CSS_INTEGRITY}">`
const INLINE_MATH_STYLESHEET = `<style>${katexPrintCss}</style>`

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function downloadTextFile(filename: string, text: string, mime: string): void {
  downloadBlob(filename, new Blob([text], { type: mime }))
}

export function exportNoteAsMarkdown(note: { title: string; content: string }): void {
  const title = note.title.trim()
  const frontMatter = title ? `---\ntitle: ${JSON.stringify(title)}\n---\n\n` : ''
  downloadTextFile(`${safeFileName(title) || 'note'}.md`, `${frontMatter}${note.content}`, 'text/markdown;charset=utf-8')
}

export async function exportNoteAsHtml(note: { title: string; content: string }, language: string): Promise<void> {
  const { body, hasMath } = await prepareExportBody(note)
  downloadTextFile(`${safeFileName(note.title) || 'note'}.html`, htmlDocument(note.title, body, language, hasMath ? CDN_MATH_STYLESHEET : ''), 'text/html;charset=utf-8')
}

export async function exportNoteAsPdf(note: { title: string; content: string }, language: string): Promise<void> {
  const { body, hasMath } = await prepareExportBody(note)
  await printHtml(htmlDocument(note.title, body, language, hasMath ? INLINE_MATH_STYLESHEET : ''))
}

async function printHtml(html: string): Promise<void> {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  // Same origin is what lets this code reach focus()/print(); without allow-scripts
  // nothing inside the exported document can execute as this origin.
  iframe.setAttribute('sandbox', 'allow-same-origin allow-modals allow-popups')
  iframe.style.position = 'fixed'
  iframe.style.right = '0'
  iframe.style.bottom = '0'
  iframe.style.width = '0'
  iframe.style.height = '0'
  iframe.style.border = '0'
  document.body.appendChild(iframe)
  try {
    const win = iframe.contentWindow
    if (!win) return
    iframe.srcdoc = html
    await waitForPrintReady(iframe)
    win.focus()
    win.print()
  } finally {
    setTimeout(() => iframe.remove(), 1000)
  }
}

async function waitForPrintReady(iframe: HTMLIFrameElement): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    iframe.addEventListener('load', finish)
    setTimeout(finish, 2000)
  })
}

const IMAGE_FETCH_CONCURRENCY = 6
const IMAGE_FETCH_TIMEOUT_MS = 30_000

async function prepareExportBody(note: { title: string; content: string }): Promise<{ body: string; hasMath: boolean }> {
  const rendered = renderMarkdown(note.content)
  const doc = new DOMParser().parseFromString(rendered.html, 'text/html')
  registerFenceBodies(doc.body, rendered.fences)
  // Embeds resolve first: their expanded bodies carry their own images, placeholders and
  // tab sets, and every pass below runs over the whole document, so going early covers them.
  await resolveNoteEmbeds(doc.body, { currentContent: note.content, currentTitle: note.title })
  await inlinePrivateImages(doc)
  // `false` because the exported page is always the light scheme.
  await renderMath(doc)
  await renderPendingMermaid(doc, false)
  await renderPendingCharts(doc.body, false, { instant: true })
  bakeChartsToImages(doc.body)
  // A board is a React root, and an exported document has no script to mount one with, so the fence
  // is drawn as a still here the way the preview pane draws one for a card and a share page.
  renderStaticKanbans(doc.body)
  expandHiddenBlocks(doc.body)
  stripInertControls(doc.body)
  return { body: doc.body.innerHTML, hasMath: rendered.hasMath }
}

// The copy button and the diagram retry only exist because the preview has scripts.
function stripInertControls(root: HTMLElement): void {
  root.querySelectorAll('[data-copy], [data-mermaid-retry]').forEach((control) => control.remove())
}

// A tab panel only becomes visible through a click, and a collapsed <details> only through
// a toggle; an exported .html carries no script and a print frame is sandboxed without
// allow-scripts, so everything the author hid would simply be missing.
function expandHiddenBlocks(root: HTMLElement): void {
  root.querySelectorAll<HTMLDetailsElement>('details').forEach((block) => {
    block.open = true
  })
  root.querySelectorAll<HTMLElement>('[data-tabs]').forEach((group) => {
    const labels = [...group.querySelectorAll<HTMLElement>(':scope > .tab-list [data-tab-button]')]
      .map((button) => button.textContent?.trim() ?? '')
    // The bar only exists to switch panels, and nothing can switch them here.
    group.querySelector(':scope > .tab-list')?.remove()
    group.querySelectorAll<HTMLElement>(':scope > [data-tab-panel]').forEach((panel, index) => {
      panel.removeAttribute('aria-labelledby')
      panel.removeAttribute('role')
      panel.hidden = false
      const label = labels[index]
      if (label) {
        const heading = document.createElement('p')
        heading.className = 'tab-panel-label'
        heading.textContent = label
        panel.prepend(heading)
      }
    })
  })
}

async function inlinePrivateImages(doc: Document): Promise<void> {
  const images = [...doc.querySelectorAll<HTMLImageElement>('img[src^="/api/files/"]')]
  // Attachments reach 25 MB each, so the fetches are capped in flight and always time out
  // rather than hanging an export on a stalled object.
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < images.length) {
      const image = images[next++]
      if (!image) break
      try {
        const response = await fetch(image.getAttribute('src')!, {
          credentials: 'same-origin',
          signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
        })
        if (!response.ok)
          continue
        const dataUrl = await blobToDataUrl(await response.blob())
        if (dataUrl)
          image.setAttribute('src', dataUrl)
      }
      catch {
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(IMAGE_FETCH_CONCURRENCY, images.length) }, worker))
}

function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(blob)
  })
}

export function safeFileName(title: string): string {
  return title
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

function htmlDocument(title: string, bodyHtml: string, language: string, mathStylesheet: string): string {
  const safeTitle = escapeHtml(title)
  return `<!DOCTYPE html>
<html lang="${escapeAttr(language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
${mathStylesheet}
<style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 46rem; padding: 2.5rem 1.75rem; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; font-size: 16px; line-height: 1.75; color: #1f2328; background: #fff; }
@media print { body { padding: 0; max-width: none; } }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.4em 0 0.6em; }
h1 { font-size: 1.75em; }
h2 { font-size: 1.4em; padding-bottom: 0.25em; border-bottom: 1px solid #e5e7eb; }
h3 { font-size: 1.18em; }
h4 { font-size: 1.05em; }
p { margin: 0.7em 0; }
a { color: #2563eb; text-decoration: none; }
a:hover { text-decoration: underline; }
a.wikilink { color: #4b5563; text-decoration: none; border-bottom: 1px dashed #9ca3af; }
strong { font-weight: 600; }
del { color: #6b7280; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: 0.88em; background: #f3f4f6; border-radius: 4px; padding: 0.15em 0.35em; }
pre { background: #0f172a; color: #e2e8f0; border-radius: 8px; padding: 1em 1.1em; overflow-x: auto; line-height: 1.6; margin: 0.9em 0; }
pre code { background: transparent; padding: 0; font-size: 0.85em; color: inherit; }
blockquote { margin: 0.9em 0; padding: 0.2em 1.1em; border-left: 3px solid #d1d5db; color: #4b5563; }
img { max-width: 100%; height: auto; border-radius: 6px; }
hr { border: none; border-top: 1px solid #e5e7eb; margin: 1.6em 0; }
table { border-collapse: collapse; width: 100%; margin: 0.9em 0; font-size: 0.95em; }
th, td { border: 1px solid #d1d5db; padding: 0.4em 0.7em; text-align: left; vertical-align: top; }
th { background: #f3f4f6; font-weight: 600; }
ul, ol { padding-left: 1.6em; }
li { margin: 0.25em 0; }
li.task-list-item { list-style: none; }
input.task-list-item-checkbox { margin-right: 0.45em; transform: translateY(1px); }
details { margin: 0.9em 0; padding: 0.7em 1em; border: 1px solid #e5e7eb; border-radius: 8px; background: #f9fafb; }
summary { font-weight: 600; }
details[open] summary { margin-bottom: 0.4em; }
.tab-panel { margin: 0.9em 0; }
.tab-panel-label { margin: 0 0 0.4em; font-weight: 600; color: #4b5563; break-after: avoid; }
.callout { border-left: 4px solid #6b7280; border-radius: 6px; padding: 0.65em 1em; margin: 0.9em 0; background: #f9fafb; }
.callout[data-callout="warning"], .callout[data-callout="question"] { border-color: #d97706; }
.callout[data-callout="danger"], .callout[data-callout="failure"] { border-color: #dc2626; }
.callout[data-callout="success"], .callout[data-callout="tip"] { border-color: #16a34a; }
.callout[data-callout="info"], .callout[data-callout="note"] { border-color: #2563eb; }
.callout-title { font-weight: 600; margin-bottom: 0.25em; }
.callout-content > :first-child { margin-top: 0; }
.callout-content > :last-child { margin-bottom: 0; }
.note-embed { display: block; margin: 0.9em 0; overflow: hidden; border: 1px solid #e5e7eb; border-left: 3px solid #6b7280; border-radius: 8px; background: #f9fafb; }
.note-embed-head { display: block; padding: 0.42em 0.75em; border-bottom: 1px solid #e5e7eb; color: #4b5563; font-size: 0.86em; font-weight: 600; }
.note-embed-body { display: block; padding: 0.7em 0.8em 0.05em; }
.note-embed-body > :last-child { margin-bottom: 0.65em; }
.kanban-snapshot { margin: 0.9em 0; padding: 0.7em 0.9em; border: 1px solid #e5e7eb; border-left: 3px solid #6b7280; border-radius: 8px; background: #f9fafb; }
.kanban-snapshot-title { margin: 0 0 0.4em; font-weight: 600; break-after: avoid; }
.kanban-snapshot-empty { margin: 0; color: #6b7280; font-style: italic; }
.kanban-snapshot-groups { margin: 0; }
.kanban-snapshot-group { margin: 0.55em 0 0.2em; font-size: 0.9em; font-weight: 600; color: #4b5563; break-after: avoid; }
.kanban-snapshot-group-cards { margin: 0; }
.kanban-snapshot-cards { list-style: none; margin: 0; padding: 0; }
.kanban-snapshot-card { margin: 0.3em 0; padding: 0.4em 0.65em; border: 1px solid #e5e7eb; border-radius: 6px; background: #fff; break-inside: avoid; }
.footnote-ref { font-size: 0.8em; }
.footnotes { font-size: 0.9em; color: #4b5563; border-top: 1px solid #e5e7eb; margin-top: 1.5em; padding-top: 0.75em; }
kbd { background: #f3f4f6; border: 1px solid #d1d5db; border-bottom-width: 2px; border-radius: 4px; padding: 0.08em 0.35em; font-family: ui-monospace, monospace; font-size: 0.85em; }
sub, sup { line-height: 0; }
</style>
</head>
<body>
${safeTitle ? `<h1>${safeTitle}</h1>` : ''}
${bodyHtml}
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }
    return entities[character] ?? character
  })
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#96;')
}
