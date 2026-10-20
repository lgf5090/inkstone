import { beforeEach, describe, expect, it } from 'vitest'
import type { EditorView } from '@codemirror/view'
import { useUi } from '../store/ui'
import { tickTaskLines } from './task-tick'

// The writer is a lazy chunk holding the recurrence and natural-language date libraries, and loading
// it is most of this file's runtime in a source-transform run.
describe('ticking task lines in the editor', { timeout: 30_000 }, () => {
  let makeView: (doc: string) => EditorView

  beforeEach(async () => {
    useUi.setState({ toasts: [] })
    document.body.replaceChildren()
    const { EditorState } = await import('@codemirror/state')
    const { EditorView: View } = await import('@codemirror/view')
    const parent = document.createElement('div')
    document.body.append(parent)
    makeView = (doc: string) => new View({ state: EditorState.create({ doc }), parent })
  })

  const lastToast = () => useUi.getState().toasts.at(-1)

  it('moves the box one step along the status cycle and rewrites only that line', async () => {
    const view = makeView(['# Plan', '- [ ] pay rent', '', '- [ ] buy milk'].join('\n'))
    expect(await tickTaskLines(view, [1], 'input')).toBe(true)
    const lines = view.state.doc.toString().split('\n')
    expect(lines[0]).toBe('# Plan')
    expect(lines[1]).toMatch(/^- \[[xX]] pay rent/)
    expect(lines[2]).toBe('')
    expect(lines[3]).toBe('- [ ] buy milk')
    expect(lastToast()).toBeUndefined()
    view.destroy()
  })

  it('says so when the line moved under the click, and writes nothing', async () => {
    const view = makeView('- [ ] pay rent')
    expect(await tickTaskLines(view, [9], 'input')).toBe(false)
    expect(view.state.doc.toString()).toBe('- [ ] pay rent')
    expect(lastToast()?.title).toBe('editor.task_line_changed')
    view.destroy()
  })
})
