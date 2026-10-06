/**
 * The preview remounts every board each time the editor settles.
 *
 * One keystroke in the prose above the fence re-renders the whole note, and the layout effect walks
 * the blocks again — usually with the fence exactly as it was. That walk used to end in `root.render`
 * unconditionally, and `render` handed the memoized root four fresh closures, so the board could not
 * bail out: typing a paragraph repainted every mounted card. These cases hold both ends — a remount
 * that changed nothing must not repaint, and a remount whose fence did change still must.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../i18n'
import { installTestGlobals } from '../../test-render'
import { registerFenceBodies } from '../fence-bodies'
import { renderMarkdown } from '../renderer'
import { destroyKanbans, mountKanbans } from './index'

const SCOPE = 'kanban-remount-test'

/** Every paint of a board root, in order: the root is a `memo`, so this is what a bail-out prevents. */
const painted = vi.hoisted(() => [] as string[])

vi.mock('./ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ui')>()
  return {
    ...actual,
    KanbanRoot: (props: Parameters<typeof actual.KanbanRoot>[0]) => {
      painted.push(props.initialData.title ?? '')
      return createElement(actual.KanbanRoot, props)
    },
  }
})

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

afterEach(async () => {
  await act(async () => {
    destroyKanbans(SCOPE)
  })
  document.body.replaceChildren()
  painted.length = 0
})

function boardBody(title: string): string {
  return JSON.stringify({
    title,
    columns: [
      { id: 'title', name: 'Title', type: 'title' },
      { id: 'status', name: 'Status', type: 'select', options: [{ id: 'todo', label: 'To Do', color: 'gray' }] },
    ],
    items: [{ id: 'item-1', title: 'First Task', properties: { status: 'todo' } }],
  })
}

/**
 * One note, rendered the way the preview does it: markup on the host, bodies registered beside it,
 * then the registry walked over it. `trailing` stands for the prose the reader is actually editing.
 */
async function remount(body: string, trailing: string): Promise<HTMLElement> {
  const host = document.createElement('div')
  host.className = 'ink-prose'
  const rendered = renderMarkdown(['# Title', '', '```kanban', body, '```', '', trailing].join('\n'))
  host.innerHTML = rendered.html
  registerFenceBodies(host, rendered.fences)
  document.body.append(host)
  await act(async () => {
    await mountKanbans(host, { scope: SCOPE, noteId: 'note-1', editable: true })
  })
  return host
}

describe('a board the preview mounts again', () => {
  it('paints once, and not again while the fence and the mount options are unchanged', async () => {
    const body = boardBody('Sprint')
    await remount(body, 'first draft of the prose')
    expect(painted).toEqual(['Sprint'])

    // What typing above the fence does: the same fence in a note whose prose moved.
    await remount(body, 'the prose under it changed while the reader typed')
    expect(painted, 'a remount that changed nothing repainted the board').toEqual(['Sprint'])
  })

  it('paints again when the fence itself changed under it', async () => {
    await remount(boardBody('Sprint'), 'prose')
    expect(painted).toEqual(['Sprint'])

    await remount(boardBody('Sprint Two'), 'prose')
    expect(painted, 'a changed fence was never painted').toEqual(['Sprint', 'Sprint Two'])
  })
})
