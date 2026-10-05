import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

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
