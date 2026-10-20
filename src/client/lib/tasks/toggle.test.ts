import { describe, expect, it } from 'vitest'
import { EmojiTaskSerializer } from './serializer/emoji'
import { StatusRegistry } from './status/registry'
import { applyTaskToggle, type ToggleSettings } from './toggle'

const NOW = new Date(2026, 9, 19)

function settings(overrides: Partial<ToggleSettings> = {}): ToggleSettings {
  return {
    registry: new StatusRegistry(),
    serializer: new EmojiTaskSerializer(),
    setDoneDate: true,
    setCancelledDate: true,
    setCreatedDate: false,
    recurrenceOnNextLine: false,
    recursiveSubTaskCompletion: false,
    ...overrides,
  }
}

const cp = (...codes: number[]): string => String.fromCodePoint(...codes)
const DUE = cp(0x1F4C5)
const RECUR = cp(0x1F501)
const DONE_MARK = cp(0x2705)
const CANCEL_MARK = cp(0x274C)

function toggle(source: string, line: number, text: string, config = settings()): string | null {
  return applyTaskToggle(source, { line, text }, config, NOW)
}

describe('the status cycle', () => {
  it('ticks an open task to done and stamps the completion date', () => {
    const out = toggle('- [ ] pay rent', 0, 'pay rent')
    expect(out).toBe(`- [x] pay rent ${DONE_MARK} 2026-10-19`)
  })

  it('un-ticks a done task and takes the stamp away', () => {
    const out = toggle(`- [x] pay rent ${DONE_MARK} 2026-10-10`, 0, 'pay rent')
    expect(out).toBe('- [ ] pay rent')
  })

  it('walks the whole registered cycle, so [/] and [-] are clickable', () => {
    expect(toggle('- [ ] work', 0, 'work')).toContain('[x]')
    expect(toggle('- [/] work', 0, 'work')).toContain('[x]')
    expect(toggle('- [-] work', 0, 'work')).toContain('[ ]')
    expect(toggle(`- [-] work ${CANCEL_MARK} 2026-10-01`, 0, 'work')).toContain('[ ]')
  })

  it('gives a finished recurring instance a done stamp while the newborn stays open', () => {
    const out = applyTaskToggle(
      `- [ ] water ${RECUR} every week ${DUE} 2026-10-19`,
      { line: 0, text: 'water' },
      settings(),
      NOW,
    )!
    const lines = out.split('\n')
    expect(lines.find((l) => l.includes('[x]'))).toContain(DONE_MARK)
    const born = lines.find((l) => l.includes('[ ]'))!
    expect(born).not.toContain(DONE_MARK)
    expect(born).toContain(`${DUE} 2026-10-26`)
  })
})

describe('what a tick must not touch', () => {
  it('keeps indentation, blockquote prefix and ordered markers', () => {
    expect(toggle('  > - [ ] nested', 0, 'nested')).toContain('  > - [x]')
    expect(toggle('3. [ ] ordered', 0, 'ordered')).toContain('3. [x]')
    expect(toggle('\t- [ ] tabbed', 0, 'tabbed')).toContain('\t- [x]')
  })

  it('keeps a block id at the end and a hard break after it', () => {
    expect(toggle('- [ ] anchored ^my-id', 0, 'anchored')).toBe(`- [x] anchored ${DONE_MARK} 2026-10-19 ^my-id`)
    const broken = toggle('- [ ] hard  ', 0, 'hard')
    expect(broken?.endsWith('  ')).toBe(true)
  })

  it('keeps every other field of the line exactly as written', () => {
    const line = `- [ ] ship ${RECUR} every week ${DUE} 2026-10-20`
    const out = toggle(line, 0, 'ship')
    expect(out).toContain(`${RECUR} every week`)
    expect(out).toContain(`${DUE} 2026-10-20`)
  })

  it('preserves CRLF endings', () => {
    const out = toggle('- [ ] a\r\n- [ ] b', 1, 'b')
    expect(out).toBe(`- [ ] a\r\n- [x] b ${DONE_MARK} 2026-10-19`)
  })
})

describe('the staleness guard', () => {
  it('refuses a line whose text no longer matches', () => {
    expect(toggle('- [ ] renamed elsewhere', 0, 'pay rent')).toBeNull()
  })

  it('refuses a line that is not a task at all', () => {
    expect(toggle('just prose', 0, 'just prose')).toBeNull()
  })

  it('refuses a line index past the end', () => {
    expect(toggle('- [ ] only', 5, 'only')).toBeNull()
  })

  it('compares ignoring the whitespace a wrapped item accumulated', () => {
    expect(toggle('- [ ]   two   words', 0, 'two words')).toContain('[x]')
  })
})

describe('recurrence', () => {
  it('finishes the instance and births the next one from the rule', () => {
    const source = `- [ ] water plants ${RECUR} every week ${DUE} 2026-10-19`
    const out = toggle(source, 0, 'water plants')!
    const lines = out.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines.some((l) => l.includes('[x]') && l.includes(DONE_MARK))).toBe(true)
    const born = lines.find((l) => l.includes('[ ]'))!
    expect(born).toContain(`${DUE} 2026-10-26`)
  })

  it('puts the newborn below when the reader asked for that order', () => {
    const source = `- [ ] standup ${RECUR} every day ${DUE} 2026-10-19`
    const below = applyTaskToggle(source, { line: 0, text: 'standup' }, settings({ recurrenceOnNextLine: true }), NOW)!
    const above = applyTaskToggle(source, { line: 0, text: 'standup' }, settings({ recurrenceOnNextLine: false }), NOW)!
    expect(below.split('\n')[0]).toContain('[x]')
    expect(above.split('\n')[0]).toContain('[ ]')
  })

  it('clears identity and history on the newborn', () => {
    const source = `- [ ] job ${RECUR} every week ${DUE} 2026-10-19 ${cp(0x1F194)} abc`
    const out = applyTaskToggle(source, { line: 0, text: 'job' }, settings(), NOW)!
    const born = out.split('\n').find((line) => line.includes('[ ]'))!
    expect(born).not.toContain(cp(0x1F194))
  })

  it('deletes the finished instance when the rule says on completion delete', () => {
    const source = `- [ ] temp ${RECUR} every week ${DUE} 2026-10-19 ${cp(0x1F3C1)} delete`
    const out = applyTaskToggle(source, { line: 0, text: 'temp' }, settings(), NOW)!
    expect(out).not.toContain('[x]')
    expect(out).toContain(`${DUE} 2026-10-26`)
  })
})

describe('sub-task cascade', () => {
  it('leaves children alone unless the reader turned it on', () => {
    const source = ['- [ ] parent', '    - [ ] child'].join('\n')
    expect(applyTaskToggle(source, { line: 0, text: 'parent' }, settings(), NOW))
      .toBe(`- [x] parent ${DONE_MARK} 2026-10-19
    - [ ] child`)
    const recursive = applyTaskToggle(source, { line: 0, text: 'parent' }, settings({ recursiveSubTaskCompletion: true }), NOW)!
    expect(recursive).toContain('- [x] parent')
    expect(recursive).toContain('- [x] child')
  })

  it('stops at the first line that is not a child', () => {
    const source = ['- [ ] parent', '    - [ ] child', '- [ ] sibling'].join('\n')
    const out = applyTaskToggle(source, { line: 0, text: 'parent' }, settings({ recursiveSubTaskCompletion: true }), NOW)!
    expect(out.split('\n')[2]).toBe('- [ ] sibling')
  })
})
