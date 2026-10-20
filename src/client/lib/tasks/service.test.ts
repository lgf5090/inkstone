import { describe, expect, it } from 'vitest'
import { toggleTaskLinesInSource } from './service'

const NOW = new Date(2026, 9, 19)
const cp = (...codes: number[]): string => String.fromCodePoint(...codes)
const DUE = cp(0x1F4C5)
const RECUR = cp(0x1F501)

describe('ticking from the editor and the preview', () => {
  it('carries a recurring emoji line through the default completion format', () => {
    // The default stamps a date as `[completion:: …]`, which cannot read `🔁`; a tick that honoured
    // only the stamp format would finish a weekly task and never produce its next instance.
    const out = toggleTaskLinesInSource(`- [ ] water plants ${RECUR} every week ${DUE} 2026-10-19`, [0], NOW)!
    const lines = out.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines.some((line) => line.includes('[x]'))).toBe(true)
    expect(lines.some((line) => line.includes('[ ]') && line.includes('2026-10-26'))).toBe(true)
  })

  it('advances each named line once, whatever order it is given them in', () => {
    const source = [`- [ ] water plants ${RECUR} every week ${DUE} 2026-10-19`, '- [x] already done'].join('\n')
    const lines = toggleTaskLinesInSource(source, [0, 1], NOW)!.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines.filter((line) => line.includes('already done'))).toEqual(['- [ ] already done'])
    expect(lines.filter((line) => line.includes('water plants')).every((line) => line.includes('every week'))).toBe(true)
  })

  it('says nothing changed when no named line is a task', () => {
    expect(toggleTaskLinesInSource('just prose\n- a bullet', [0, 1], NOW)).toBeNull()
    expect(toggleTaskLinesInSource('- [ ] one', [7], NOW)).toBeNull()
  })
})
