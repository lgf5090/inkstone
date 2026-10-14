import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { EXCALIDRAW_PATCHES, applyExcalidrawPatches } from '../scripts/excalidraw-patch.mjs'

const VENDOR = 'node_modules/@zsviczian/excalidraw/dist/obsidian/excalidraw.production.min.js'

describe('the vendored engine patch table', () => {
  it('covers every edit and each one is either applicable or already applied', () => {
    expect(EXCALIDRAW_PATCHES.length).toBe(15)
    // The table is plain JavaScript with no declaration file, so the one field this assertion reads
    // is named on the callback instead of being left `any`.
    expect(new Set(EXCALIDRAW_PATCHES.map((p: { id: string }) => p.id)).size).toBe(EXCALIDRAW_PATCHES.length)
    if (!fs.existsSync(VENDOR)) return
    const source = fs.readFileSync(VENDOR, 'utf8')
    const { unmatched, applied, already } = applyExcalidrawPatches(source)
    expect(unmatched, 'unmatched: ' + unmatched.join(', ')).toEqual([])
    expect(applied.length + already.length).toBe(EXCALIDRAW_PATCHES.length)
  })

  it('applies an edit exactly once and recognises the patched form', () => {
    const one = EXCALIDRAW_PATCHES[0]
    const once = applyExcalidrawPatches('PREFIX ' + one.target + ' SUFFIX')
    expect(once.applied).toEqual([one.id])
    const twice = applyExcalidrawPatches('PREFIX ' + one.replacement + ' SUFFIX')
    expect(twice.already).toEqual([one.id])
    expect(twice.applied).toEqual([])
    const missing = applyExcalidrawPatches('nothing here')
    expect(missing.unmatched.length).toBe(EXCALIDRAW_PATCHES.length)
  })
})
