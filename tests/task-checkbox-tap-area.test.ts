import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The task box keeps its drawn size and gains its target area from an overlay.
 *
 * Two ways to satisfy WCAG 2.5.8's 24 by 24 floor: paint a bigger box, or leave the box and widen
 * what a click can land on. The first is what a prose list must not do — a 24px box on every line of a
 * task list changes the leading of the note. So the rule is the second, and the thing worth guarding
 * is that nobody "fixes" the smallness by growing the box itself.
 */
const PROSE = fs.readFileSync('src/client/styles/prose.css', 'utf8')
const CHECKBOX = ".ink-prose input[type='checkbox']"

function bodyOf(selector: string): string {
  const at = PROSE.indexOf(`${selector} {`)
  if (at < 0) return ''
  return PROSE.slice(at + selector.length + 2, PROSE.indexOf('}', at))
}

describe('the task checkbox tap area', () => {
  it('paints the box in the prose scale, not in pixels', () => {
    const body = bodyOf(CHECKBOX)
    expect(body).toMatch(/width:\s*1\.05em/)
    expect(body).toMatch(/height:\s*1\.05em/)
    // The overlay has to hang off the box it enlarges.
    expect(body).toMatch(/position:\s*relative/)
  })

  it('grows the clickable area to the 24px token without touching the drawing', () => {
    const pad = bodyOf(`${CHECKBOX}::before`)
    expect(pad).toContain('content:')
    expect(pad).toMatch(/width:\s*max\(100%,\s*var\(--tap-min\)\)/)
    expect(pad).toMatch(/height:\s*max\(100%,\s*var\(--tap-min\)\)/)
    // `::after` is the check mark; a second overlay there would be drawn over it.
    expect(bodyOf(`${CHECKBOX}::after`)).not.toMatch(/width:\s*max/)
  })

  it('keeps the token at the accessibility floor it names', () => {
    const tokens = fs.readFileSync('src/client/styles/tokens.css', 'utf8')
    expect(tokens).toMatch(/--tap-min:\s*24px/)
  })
})
