// @vitest-environment jsdom
/**
 * What a tool call admits about itself.
 *
 * The chip is the only place a reader learns what a turn did, so two things had to go: a status this app
 * does not recognise was answered with "Completed" — a stored row can carry one the client has never seen,
 * and a lie about a call is the one fact nobody can check any other way — and the reason a call failed was
 * parked in the button's `title`, which only a hovering pointer ever reads. A keyboard and a thumb got a
 * red cross and nothing else.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolActivity } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { ToolCallList } from './MessageParts'
import { useAssistant } from './assistant-store'

const original = useAssistant.getState()
let root: Root
let host: HTMLElement

/** A status no client build knows: what a stored row can hold after the worker has moved on. */
const SKIPPED: ToolActivity = {
  id: 't1',
  name: 'search_notes',
  status: 'skipped' as unknown as ToolActivity['status'],
}
const FAILED: ToolActivity = {
  id: 't2',
  name: 'read_note',
  status: 'error',
  error: 'The note is not in the vault.',
  result: 'partial',
}

const row = (name: string) => document.body.querySelector<HTMLButtonElement>(`button[data-tool-chip="${name}"]`)
const chipText = (name: string) => row(name)?.textContent ?? ''
const group = () => buttons().find((node) => node.textContent?.includes(t('assistant.chat.tools_group')))
const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]

function mount(tools: ToolActivity[]): void {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => { root.render(createElement(ToolCallList, { tools, messageId: 'm1' })) })
  // The group folds itself shut once nothing is running, so the rows have to be asked for.
  act(() => { group()!.click() })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  document.body.innerHTML = ''
  useAssistant.setState(original, true)
})

describe('a status this app does not recognise', () => {
  it('says it does not know rather than borrowing "Completed"', () => {
    mount([SKIPPED])
    expect(chipText('search_notes')).toContain(t('assistant.chat.tool_unknown'))
    expect(chipText('search_notes')).not.toContain(t('assistant.chat.tool_done'))
  })

  it('still calls a success a success', () => {
    mount([{ id: 't3', name: 'search_notes', status: 'success', result: 'two notes' }])
    expect(chipText('search_notes')).toContain(t('assistant.chat.tool_done'))
    expect(chipText('search_notes')).not.toContain(t('assistant.chat.tool_unknown'))
  })
})

describe('a call that failed', () => {
  it('writes the reason on the row, where a keyboard and a thumb both read it', () => {
    mount([FAILED])
    const note = document.body.querySelector<HTMLElement>(`[data-tool-error="read_note"]`)
    expect(note, 'the failure says nothing').toBeTruthy()
    expect(note!.textContent).toContain('The note is not in the vault.')
    // Outside the button, because a `title` on the row is the shape that hid it; and while the fold is
    // still shut, because closing it never took the failure away.
    expect(note!.closest('button')).toBeNull()
    expect(row('read_note')!.getAttribute('title')).toBeNull()
  })

  it('keeps the reason when the fold is opened rather than moving it behind the toggle', () => {
    mount([FAILED])
    act(() => { row('read_note')!.click() })
    expect(document.body.querySelectorAll('[data-tool-error="read_note"]')).toHaveLength(1)
    expect(chipText('read_note')).toContain(t('assistant.chat.tool_failed'))
  })

  it('says so when a failed call left nothing else behind', () => {
    mount([{ id: 't4', name: 'search_notes', status: 'error', error: 'the index was busy' }])
    act(() => { row('search_notes')!.click() })
    expect(document.body.textContent).toContain(t('assistant.chat.tool_no_data'))
  })
})
