import { describe, expect, it } from 'vitest'
import { defaultQuickAddSettings } from '@shared/quickadd'
import { inertFormat } from './format'
import { previewDateFormat, previewRuntime, type PreviewContext } from './preview'

const NOW = new Date(2026, 9, 8, 13, 5, 9)

function preview(overrides: Partial<PreviewContext> = {}) {
  return previewRuntime({
    settings: defaultQuickAddSettings(),
    choices: [],
    title: 'Morning note',
    locale: 'en-US',
    now: NOW,
    ...overrides,
  })
}

describe('the settings preview runtime', () => {
  it('renders the date, time and periodic tokens from the run clock', () => {
    const runtime = preview()
    expect(inertFormat('{{DATE}} / {{TIME:HH:mm}}', runtime)).toBe('2026-10-08 / 13:05')
    // The periodic path is the folder the setting names plus the title the format writes.
    expect(inertFormat('{{DAILY}}', runtime)).toBe('Daily/2026-10-08')
  })

  it('marks every prompt-shaped token instead of pretending to know the answer', () => {
    const runtime = preview()
    expect(inertFormat('{{VALUE:Topic|default:Inbox}}', runtime)).toBe('{Topic: Inbox}')
    expect(inertFormat('{{VALUE:a,b,c}}', runtime)).toBe('{a | b | c}')
    expect(inertFormat('{{MACRO:Cleanup}} {{TEMPLATE:Daily}} {{FIELD:status}}', runtime))
      .toBe('{macro: Cleanup} {template: Daily} {status}')
  })

  it('resolves the current-file tokens against the pretend note', () => {
    const runtime = preview({ title: 'Reading log', selection: 'a quote' })
    expect(inertFormat('{{TITLE}}|{{SELECTED}}|{{LINKCURRENT}}', runtime))
      .toBe('Reading log|a quote|[[Reading log]]')
  })

  it('keeps a token whose options it cannot read instead of dropping it', () => {
    const runtime = preview()
    expect(inertFormat('{{RANDOM:not a number}}', runtime)).toBe('{{RANDOM:not a number}}')
  })

  it('formats the date-field hint with the pattern being edited', () => {
    const CJK_DATE_FIXTURES = { padded: 'YYYY年MM月DD日', title: '2026年10月08日' }
    expect(previewDateFormat(CJK_DATE_FIXTURES.padded, 'zh-CN', NOW)).toBe(CJK_DATE_FIXTURES.title)
    expect(previewDateFormat('', 'en-US', NOW)).toBe('2026-10-08')
  })
})
