/**
 * The DOM half of dynamic commands: what gets replaced, what is left alone, and what is said when one fails.
 *
 * `./run-shell` is stood in for, because the engine's own behaviour is proved in `run-shell.test.ts` and
 * `lib/templater/worker/vm.test.ts`; what this file can only prove here is the walk — which text nodes are
 * candidates, in what order the commands run, and how a failure is left on screen. The read-only profile and
 * the surfaces that must never run anything are pinned by `tests/templater-non-executing-surfaces.test.ts`.
 */
import type { Note } from '@shared/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { processDynamicCommands } from './dynamic-commands'
import { renderDynamicCommand } from './run-shell'

vi.mock('./run-shell', () => ({
  renderDynamicCommand: vi.fn(async () => ({ ok: true as const, output: 'answered' })),
}))

const run = vi.mocked(renderDynamicCommand)

const HOST: Note = {
  id: 'n-host', title: 'Host', content: '', excerpt: '', folderId: null, tags: [], isPinned: false,
  isStarred: false, isArchived: false, wordCount: 0, charCount: 0, rev: 1, position: 0, createdAt: 1, updatedAt: 1,
  deletedAt: null,
} as Note
const EMBEDDED: Note = { ...HOST, id: 'n-embed', title: 'Source' } as Note

function mount(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.replaceChildren(root)
  return root
}

beforeEach(async () => {
  await initI18n()
  run.mockReset()
  run.mockResolvedValue({ ok: true, output: 'answered' })
  useNotes.setState({ notes: { [HOST.id]: HOST, [EMBEDDED.id]: EMBEDDED }, contents: {}, folders: [] })
})

describe('replacing the commands a preview holds', () => {
  it('puts the answer where the source was, in the sentence it sat in', async () => {
    const root = mount('<p>Today is <%+ tp.date.now() %> and so is <%+ tp.date.now("YYYY") %>.</p>')
    const report = await processDynamicCommands(root, HOST)
    expect(report).toEqual({ found: 2, ran: 2, failed: 0, skipped: 0 })
    expect(root.textContent).toBe('Today is answered and so is answered.')
    expect(run.mock.calls.map((call) => call[0])).toEqual(['<% tp.date.now() %>', '<% tp.date.now("YYYY") %>'])
    expect(run.mock.calls[0]![1]).toBe(HOST)
  })

  it('keeps the modifiers the author wrote and drops only the plus', async () => {
    const root = mount('<p><%- +tp.file.title %></p>')
    await processDynamicCommands(root, HOST)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]![0]).toBe('<%- tp.file.title %>')
  })

  it('leaves quoted code alone, fenced or inline', async () => {
    const root = mount('<pre><code>&lt;%+ tp.date.now() %&gt;</code></pre><p>Use <code><%+ x %></code> here.</p>')
    const report = await processDynamicCommands(root, HOST)
    expect(report.found).toBe(0)
    expect(run).not.toHaveBeenCalled()
    const quoted = [...root.querySelectorAll('code')].map((node) => node.textContent)
    expect(quoted).toEqual(['<%+ tp.date.now() %>', '<%+ x %>'])
  })

  it('runs the rest of the paragraph when one command fails, and says why beside it', async () => {
    run.mockResolvedValueOnce({ ok: false, error: '模板命令解析失败' })
    const root = mount('<p>a <%+ broken() %> b <%+ fine() %> c</p>')
    const report = await processDynamicCommands(root, HOST)
    expect(report).toEqual({ found: 2, ran: 1, failed: 1, skipped: 0 })
    const chip = root.querySelector<HTMLElement>('[data-templater-dynamic="error"]')!
    expect(chip.textContent).toBe('<%+ broken() %>')
    expect(chip.getAttribute('title')).toContain('模板命令解析失败')
    expect(chip.getAttribute('aria-label')).toContain('模板命令解析失败')
    expect(chip.getAttribute('role')).toBe('note')
    expect(chip.tabIndex).toBe(0)
    expect(root.textContent).toContain('b answered c')
  })

  it('is a second pass over the same preview with nothing left to do', async () => {
    const root = mount('<p><%+ tp.date.now() %></p>')
    await processDynamicCommands(root, HOST)
    run.mockClear()
    // An answer that itself reads like a command must not become one: the span that holds it is skipped.
    run.mockResolvedValue({ ok: true, output: '<%+ tp.date.now() %>' })
    const again = await processDynamicCommands(root, HOST)
    expect(again.found).toBe(0)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('the note a command belongs to', () => {
  it('answers against the embedded note when the text came from one', async () => {
    const root = mount('<div data-embed-target="Source"><p>From <%+ tp.file.title %></p></div>')
    await processDynamicCommands(root, HOST)
    expect(run.mock.calls[0]![1]!.id).toBe(EMBEDDED.id)
  })

  it('leaves the source where the embedded note cannot be named', async () => {
    const root = mount('<div data-embed-target="Gone"><p>From <%+ tp.file.title %></p></div>')
    const report = await processDynamicCommands(root, HOST)
    expect(report).toEqual({ found: 1, ran: 0, failed: 0, skipped: 1 })
    expect(run).not.toHaveBeenCalled()
    expect(root.textContent).toContain('<%+ tp.file.title %>')
    expect(root.querySelector('[data-templater-dynamic="skipped"]')).not.toBeNull()
  })

  it('stops at the depth the embed pass itself stops at', async () => {
    const deep = '<div data-embed-target="Source"><div data-embed-target="Source"><div data-embed-target="Source">'
      + '<div data-embed-target="Source"><div data-embed-target="Source"><p><%+ x %></p></div></div></div></div></div></div>'
    const report = await processDynamicCommands(mount(deep), HOST)
    expect(report.skipped).toBe(1)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('a preview with nothing to run', () => {
  it('asks the shell for nothing at all', async () => {
    const root = mount('<p>Ordinary prose, and a link to [[Another]]</p>')
    expect(await processDynamicCommands(root, HOST)).toEqual({ found: 0, ran: 0, failed: 0, skipped: 0 })
    expect(run).not.toHaveBeenCalled()
  })

  it('stops writing when the preview was swapped out from under a run', async () => {
    const root = mount('<p><%+ slow() %></p>')
    run.mockImplementation(async () => {
      root.innerHTML = '<p>re-rendered</p>'
      return { ok: true, output: 'late' }
    })
    const report = await processDynamicCommands(root, HOST)
    expect(report).toEqual({ found: 1, ran: 0, failed: 0, skipped: 0 })
    expect(root.textContent).toBe('re-rendered')
  })
})
