// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The 24px pointer floor is one app-wide rule, not a feature's private skin.
 *
 * `.ink-tap-pad` laid the missing area over a control drawn smaller than WCAG 2.5.8's floor, and it began
 * life in `chat.css` while only the chat read it. A shared primitive that carries the class would then be
 * padded in one screen and not another, and the pad is invisible either way, so nothing on screen tells a
 * reader the switch in their settings sheet is a harder target than the same switch in a conversation.
 * The rule therefore lives in the sheet every surface loads, and a second copy is the bug this pins.
 */
const STYLES_DIR = 'src/client/styles'

function sheets(): Array<{ name: string, text: string }> {
  return fs.readdirSync(STYLES_DIR)
    .filter((name) => name.endsWith('.css'))
    .map((name) => ({ name, text: fs.readFileSync(path.join(STYLES_DIR, name), 'utf8') }))
}

describe('the touch floor utility', () => {
  it('is declared once, in the shared primitive sheet every surface imports', () => {
    const declared = sheets().filter((sheet) => /\.ink-tap-pad::after\s*\{/.test(sheet.text))
    expect(declared.map((sheet) => sheet.name)).toEqual(['ui-primitives.css'])
    expect(declared[0]!.text).toMatch(/\.ink-tap-pad::after\s*\{[^}]*var\(--tap-min\)/)
    expect(fs.readFileSync(path.join(STYLES_DIR, 'app.css'), 'utf8')).toContain("@import './ui-primitives.css';")
  })
})
