import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const calendarDir = path.join('src', 'client', 'features', 'calendar')
const css = fs.readFileSync(path.join(calendarDir, 'calendar.css'), 'utf8')

function sources(): string[] {
  return fs.readdirSync(calendarDir)
    .filter(name => name.endsWith('.tsx') && !name.endsWith('.test.tsx'))
    .map(name => fs.readFileSync(path.join(calendarDir, name), 'utf8'))
}

describe('calendar style contracts', () => {
  it('uses named tokens for repeated calendar utility values', () => {
    const code = sources().join('\n')
    for (const arbitrary of ['mt-[2px]', 'tracking-[0.07em]', 'max-h-[45vh]', 'gap-[3px]', 'rounded-[2px]']) {
      expect(code, `repeated arbitrary utility remains: ${arbitrary}`).not.toContain(arbitrary)
    }
    expect(code).toContain('mt-[var(--sp-0-5)]')
    expect(code).toContain('tracking-[var(--tracking-section)]')
    expect(code).toContain('max-h-[var(--calendar-scroll-max-height)]')
    expect(code).toContain('gap-[var(--sp-0-75)]')
    expect(code).toContain('rounded-[var(--r-2)]')
    expect(css).toContain('--calendar-scroll-max-height: 45vh;')
  })

  it('keeps paper colours in print-only tokens', () => {
    const print = css.slice(css.indexOf('@media print'))
    expect(print).toContain('--print-paper: #ffffff;')
    expect(print).toContain('--print-dot-rule: rgba(0, 0, 0, .25);')
    expect(print).toContain('background: var(--print-paper) !important;')
    expect(print).toContain('border: 1px solid var(--print-dot-rule);')
    expect(print.match(/rgba?\(/g)).toHaveLength(1)
    expect(print).toContain('--bg-base: var(--print-paper);')
    expect(print).toContain('--text-primary: var(--print-ink);')
  })

  it('documents every scoped print important override', () => {
    const important = css.split('\n')
      .map((line, index) => ({ line: line.trim(), index }))
      .filter(entry => entry.line.includes('!important'))
    expect(important).toHaveLength(5)
    for (const entry of important) {
      expect(css.split('\n')[entry.index - 1]?.trim(), `undocumented !important: ${entry.line}`).toMatch(/^\/\*.*\*\/$/)
    }
  })
})
