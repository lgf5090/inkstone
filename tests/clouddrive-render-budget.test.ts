// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/features/clouddrive/files/render-budget.css', import.meta.url), 'utf8')

describe('CloudDrive offscreen render budget', () => {
  it('uses browser-native deferred rendering for list, grid and gallery items', () => {
    expect(css).toContain('content-visibility: auto')
    expect(css).toContain('contain-intrinsic-size: auto var(--cd-row-height)')
    expect(css).toContain('contain-intrinsic-size: auto calc(var(--cd-icon-size) + 12px)')
  })
})
