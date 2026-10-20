import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mergeSettings } from '@shared/constants'
import { useSession } from '../../store/session'
import { defaultStatusRegistry } from './line'
import { parseTaskLine } from './model/task'
import { unknownPosition } from './model/task-location'
import { draftFromTask } from './edit/task-editor'
import { editTaskInSource, toggleSettings, toggleTaskLinesInSource } from './service'

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

describe('the form round trip through the global filter', () => {
  const FILTERED = '- [ ] #task buy milk'

  /** The draft the host would build for this line, which is the half of the round trip the form owns. */
  function draftFor(line: string, globalFilter: string) {
    const task = parseTaskLine(line, unknownPosition('', ''), {
      registry: defaultStatusRegistry,
      serializer: toggleSettings().serializer,
      now: NOW,
    })
    if (task === null) throw new Error(`test fixture is not a task line: ${line}`)
    return draftFromTask(task, globalFilter)
  }

  function saved(line: string, draft: ReturnType<typeof draftFor>): string | null {
    const outcome = editTaskInSource(line, 0, { draft, statusSymbol: ' ' }, NOW)
    return outcome.ok ? outcome.source : null
  }

  beforeEach(() => {
    useSession.setState({ settings: mergeSettings({ tasks: { globalFilter: '#task' } }) })
  })
  afterEach(() => {
    useSession.setState({ settings: mergeSettings({}) })
  })

  it('writes back the line it read, word and all', () => {
    expect(draftFor(FILTERED, '#task').description).toBe('buy milk')
    expect(saved(FILTERED, draftFor(FILTERED, '#task'))).toBe(FILTERED)
  })

  it('puts the word in front of a description the reader rewrote', () => {
    const draft = { ...draftFor(FILTERED, '#task'), description: 'buy two milks' }
    expect(saved(FILTERED, draft)).toBe('- [ ] #task buy two milks')
  })

  it('adds nothing to a line in a vault that set no filter', () => {
    useSession.setState({ settings: mergeSettings({}) })
    expect(saved('- [ ] buy milk', draftFor('- [ ] buy milk', ''))).toBe('- [ ] buy milk')
  })
})
