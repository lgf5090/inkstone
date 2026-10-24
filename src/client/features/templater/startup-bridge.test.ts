import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from '@shared/constants'
import type { NoteTemplate, PublicUser } from '@shared/types'
import { initI18n } from '../../lib/i18n'
import { setTemplaterDevicePrefs } from '../../lib/templater/device-prefs'
import { useNotes } from '../../store/notes'
import { useNoteTemplates } from '../../store/note-templates'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { resetTemplaterStartupAttempt, useTemplaterStartup } from './startup-bridge'

/** What the stand-in run shell was asked to run, in order. */
const shell = vi.hoisted(() => ({
  ran: [] as string[],
  refusals: {} as Record<string, { code: string; detail: string }>,
}))

vi.mock('./run-shell', () => ({
  async runStartupTemplate(template: { id: string; name: string }) {
    shell.ran.push(template.id)
    await Promise.resolve()
    const refusal = shell.refusals[template.id]
    return refusal === undefined ? { ok: true } : { ok: false, ...refusal }
  },
}))

const USER: PublicUser = {
  id: 'u-startup',
  login: 'starter',
  name: 'Starter',
  avatarUrl: '',
  role: 'owner',
  createdAt: 0,
  username: 'starter',
}

function row(id: string, name = id): NoteTemplate {
  return {
    id,
    name,
    categoryId: null,
    description: '',
    content: '<% tp.date.now() %>',
    tags: [],
    builtin: false,
    isPinned: false,
    isStarred: false,
    createdAt: 0,
    updatedAt: 0,
  } as NoteTemplate
}

/** Mount the hook the way the shell does, and let its effect run. */
function mount(): () => void {
  function Probe() {
    useTemplaterStartup()
    return null
  }
  const root = createRoot(document.createElement('div'))
  act(() => {
    root.render(createElement(Probe))
  })
  return () => {
    act(() => {
      root.unmount()
    })
  }
}

function readyStores(startupIds: string[], templates: NoteTemplate[]): void {
  useSession.setState({
    status: 'authed',
    user: USER,
    settings: mergeSettings({ ...DEFAULT_SETTINGS, templater: { ...DEFAULT_SETTINGS.templater, startupTemplates: startupIds } }),
  })
  useNotes.setState({ hydrated: true })
  useNoteTemplates.setState({ hydrated: true, templates })
}

function toastTitles(): string[] {
  return useUi.getState().toasts.map((toast) => toast.title)
}

/**
 * Wait for the batch to have asked for `count` templates.
 *
 * The bridge reaches both modules through a dynamic import, and vitest transforms a module the first time it
 * is asked for — so a fixed number of event-loop turns is enough for every test after the first and not for
 * the first. Polling on the thing the assertion is about keeps the wait honest: it can only end early when
 * the batch really did run.
 */
async function waitForBatch(count: number): Promise<void> {
  const deadline = Date.now() + 4000
  await act(async () => {
    while (shell.ran.length < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    // One more turn for the toasts, which the batch writes after the last run settles.
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

/** A fixed window, used only to prove something did *not* happen inside it. */
async function settle(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  resetTemplaterStartupAttempt()
  shell.ran = []
  shell.refusals = {}
  useUi.setState({ toasts: [] })
  useSession.setState({ status: 'anonymous', user: null, settings: DEFAULT_SETTINGS })
  useNotes.setState({ hydrated: false })
  useNoteTemplates.setState({ hydrated: false, templates: [] })
  setTemplaterDevicePrefs(USER.id, { enableStartupTemplates: false })
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('the startup batch the shell asks for', () => {
  it('asks for nothing while the device says no', () => {
    readyStores(['tpl-a'], [row('tpl-a')])
    const unmount = mount()
    expect(shell.ran).toEqual([])
    unmount()
  })

  it('asks for nothing until the account, the notes and the template library have all arrived', () => {
    setTemplaterDevicePrefs(USER.id, { enableStartupTemplates: true })
    const templates = [row('tpl-a')]
    for (const notYet of [
      () => useSession.setState({ status: 'loading', user: null }),
      () => useNotes.setState({ hydrated: false }),
      () => useNoteTemplates.setState({ hydrated: false }),
    ]) {
      resetTemplaterStartupAttempt()
      shell.ran = []
      readyStores(['tpl-a'], templates)
      notYet()
      const unmount = mount()
      expect(shell.ran).toEqual([])
      unmount()
    }
  })

  it('runs each template once, in the order the reader listed them', async () => {
    setTemplaterDevicePrefs(USER.id, { enableStartupTemplates: true })
    readyStores(['tpl-b', 'tpl-a'], [row('tpl-a'), row('tpl-b')])
    const unmount = mount()
    await waitForBatch(2)
    expect(shell.ran).toEqual(['tpl-b', 'tpl-a'])
    expect(toastTitles()).toEqual([])
    unmount()
  })

  it('runs one batch per account even when React mounts the shell twice', async () => {
    setTemplaterDevicePrefs(USER.id, { enableStartupTemplates: true })
    readyStores(['tpl-a'], [row('tpl-a')])
    const first = mount()
    const second = mount()
    const third = mount()
    await waitForBatch(1)
    // React StrictMode mounts twice and the shell remounts on a layout change; without the record every one
    // of those would start a batch. Give the other two every chance to speak before saying they did not.
    await settle(200)
    expect(shell.ran).toEqual(['tpl-a'])
    first()
    second()
    third()
  })

  it('says which of the reader’s startup rows are gone, and still runs the rest', async () => {
    setTemplaterDevicePrefs(USER.id, { enableStartupTemplates: true })
    readyStores(['tpl-gone', 'tpl-a'], [row('tpl-a')])
    const unmount = mount()
    await waitForBatch(1)
    expect(shell.ran).toEqual(['tpl-a'])
    const titles = toastTitles()
    expect(titles).toHaveLength(2)
    expect(titles[0]).toContain('1')
    expect(titles[1]).toContain('tpl-gone')
    unmount()
  })

  it('names the template that refused, in the engine’s own words', async () => {
    setTemplaterDevicePrefs(USER.id, { enableStartupTemplates: true })
    shell.refusals = { 'tpl-a': { code: 'sandbox-unavailable', detail: 'unconfigured' } }
    readyStores(['tpl-a'], [row('tpl-a', '每日提醒')])
    const unmount = mount()
    await waitForBatch(1)
    const titles = toastTitles()
    expect(titles).toHaveLength(1)
    expect(titles[0]).toContain('每日提醒')
    unmount()
  })

  it('stays quiet on a successful batch, because nobody asked for a notice', async () => {
    setTemplaterDevicePrefs(USER.id, { enableStartupTemplates: true })
    readyStores(['tpl-a', 'tpl-b'], [row('tpl-a'), row('tpl-b')])
    const unmount = mount()
    await waitForBatch(2)
    expect(shell.ran).toHaveLength(2)
    expect(toastTitles()).toEqual([])
    unmount()
  })
})
