// @vitest-environment node
// The tools surfaces use the project's `Select`, which carries the field styling and the shared
// focus ring; a raw `<select>` silently loses both, and the accessible-name rule with them.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const FILES = [
  'src/client/features/tools/shortlinks/modals/CreateLinkModal.tsx',
  'src/client/features/tools/qrcode/scanner/CameraScanner.tsx',
  'src/client/features/tools/qrcode/compare/QrCompareView.tsx',
  'src/client/features/excalidraw/library/ExcalidrawOfficialLibraryModal.tsx',
]

describe('tools form controls', () => {
  it('does not render a raw select element', () => {
    for (const file of FILES) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/<select\b/)
    }
  })

  it('gives every remaining select an accessible name', () => {
    for (const file of FILES) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/<Select\b([^>]*)>/g)) {
        const attributes = match[1] ?? ''
        expect(attributes.includes('aria-label=') || attributes.includes('id='), `${file}: ${match[0]}`).toBe(true)
      }
    }
  })
})
