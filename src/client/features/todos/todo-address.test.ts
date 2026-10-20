// @vitest-environment jsdom
/**
 * The to-do address: what it says, and how the view state gets there and back.
 *
 * The view a reader is looking at is the thing they would hand to somebody else, and a state that only
 * exists in memory cannot be handed to anyone: a reload drops them on the board, the back button leaves
 * the app rather than walking the views, and a copied address is always the same one. So the address bar
 * carries `view`, `list`, `tag` and `q`, and the store both reads it and writes it.
 *
 * Two rules keep that honest, and both are asserted here rather than assumed. Writing is done through
 * `app-history.ts` — the one place that announces its own changes — so a reader of the address is never
 * left looking at a stale screen; and a value that changes as fast as a search box is typed into is
 * `replaceState`, because a search that is three characters long should not be three back buttons.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { parseTodoAddress, writeTodoSearch } from './todo-address'

const EMPTY_COUNTS = { inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {} }

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      list: async () => ({ tasks: [], counts: EMPTY_COUNTS, dayEnd: Date.now() + 3_600_000, timezone: 'UTC' }),
      lists: async () => ({ lists: [] }),
      tags: async () => ({ tags: [] }),
      get: async () => ({ task: null }),
    },
  },
}))

/** The address half, away from any store: what the grammar says a shape means. */
describe('the to-do address grammar', () => {
  it('names the board by leaving the view out entirely', () => {
    expect(parseTodoAddress('/todo', '').view).toBe('board')
    expect(writeTodoSearch({ view: 'board', listId: null, tagId: null, query: '' })).toBe('')
  })

  it('names a smart view by the word the container answers to', () => {
    expect(parseTodoAddress('/todo', 'view=plan')).toMatchObject({ view: 'plan', listId: null, tagId: null })
    expect(parseTodoAddress('/todo', 'view=starred')).toMatchObject({ view: 'starred' })
    expect(parseTodoAddress('/todo', 'view=completed')).toMatchObject({ view: 'completed' })
  })

  it('names a list or a tag by its own parameter, which is what makes the view implicit', () => {
    expect(parseTodoAddress('/todo', 'list=work')).toMatchObject({ view: 'list', listId: 'work', tagId: null })
    expect(parseTodoAddress('/todo', 'tag=errands')).toMatchObject({ view: 'tag', tagId: 'errands', listId: null })
    expect(writeTodoSearch({ view: 'list', listId: 'work', tagId: null, query: '' })).toBe('list=work')
    expect(writeTodoSearch({ view: 'tag', listId: null, tagId: 'errands', query: '' })).toBe('tag=errands')
  })

  it('carries the search text beside the view, and reads it back with its spaces', () => {
    expect(parseTodoAddress('/todo', 'view=plan&q=renew%20the%20lease')).toMatchObject({ view: 'plan', query: 'renew the lease' })
    expect(writeTodoSearch({ view: 'plan', listId: null, tagId: null, query: 'renew the lease' })).toBe('view=plan&q=renew+the+lease')
  })

  it('reads a view it does not have as the board rather than as a broken screen', () => {
    expect(parseTodoAddress('/todo', 'view=nonsense').view).toBe('board')
    expect(parseTodoAddress('/todo', 'view=&q=x').view).toBe('board')
    // An address that is not the to-do app's at all is not a view either.
    expect(parseTodoAddress('/notes', 'view=plan').view).toBe('board')
  })

  it('round-trips: a shape written and read again is the shape it started as', () => {
    const shapes = [
      { view: 'board' as const, listId: null, tagId: null, query: '' },
      { view: 'plan' as const, listId: null, tagId: null, query: 'tax' },
      { view: 'list' as const, listId: 'work', tagId: null, query: '' },
      { view: 'tag' as const, listId: null, tagId: 'errands', query: 'a b' },
      { view: 'completed' as const, listId: null, tagId: null, query: '' },
    ]
    for (const shape of shapes) {
      expect(parseTodoAddress('/todo', writeTodoSearch(shape))).toMatchObject(shape)
      expect(writeTodoSearch(parseTodoAddress('/todo', writeTodoSearch(shape)))).toBe(writeTodoSearch(shape))
    }
  })
})

/** The store half: the address as the state, and the state written back out. */
describe('the view state and the address bar', () => {
  let useTodos: typeof import('./store')['useTodos']

  beforeEach(async () => {
    window.history.replaceState(null, '', '/todo')
    vi.resetModules()
    useTodos = (await import('./store')).useTodos
    await initI18n()
  })

  afterEach(() => {
    window.history.replaceState(null, '', '/todo')
  })

  function reset(): void {
    useTodos.setState({ view: 'board', listId: null, tagId: null, query: '', selectedId: null, editorOpen: false, draft: null })
    window.history.replaceState(null, '', '/todo')
  }

  it('starts on the view the opened address names', async () => {
    window.history.replaceState(null, '', '/todo?view=plan&q=tax')
    vi.resetModules()
    const fresh = (await import('./store')).useTodos
    expect(fresh.getState().view).toBe('plan')
    expect(fresh.getState().query).toBe('tax')
  })

  it('starts on the list a shared address names, not on the board', async () => {
    window.history.replaceState(null, '', '/todo?list=work')
    vi.resetModules()
    const fresh = (await import('./store')).useTodos
    expect(fresh.getState().view).toBe('list')
    expect(fresh.getState().listId).toBe('work')
  })

  it('writes the view into the address when a view is opened', () => {
    reset()
    useTodos.getState().setView('plan')
    expect(window.location.search).toBe('?view=plan')
  })

  it('writes the list parameter, and no view name, when a list is opened', () => {
    reset()
    useTodos.getState().setView('list', { listId: 'work' })
    expect(window.location.search).toBe('?list=work')
    useTodos.getState().setView('tag', { tagId: 'errands' })
    expect(window.location.search).toBe('?tag=errands')
  })

  it('keeps the address down to one entry while the search text is typed', () => {
    reset()
    const before = window.history.length
    useTodos.getState().setQuery('r')
    useTodos.getState().setQuery('re')
    useTodos.getState().setQuery('ren')
    expect(window.location.search).toBe('?q=ren')
    expect(window.history.length, 'three keystrokes left three back buttons behind').toBe(before)
  })

  it('leaves the search text beside the view instead of replacing it', () => {
    reset()
    useTodos.getState().setView('plan')
    useTodos.getState().setQuery('lease')
    expect(window.location.search).toBe('?view=plan&q=lease')
  })

  it('gives the back button the view the reader came from', () => {
    reset()
    const settled = new Promise<void>((resolve) => {
      window.addEventListener('popstate', () => { resolve() }, { once: true })
    })
    useTodos.getState().setView('plan')
    useTodos.getState().setView('completed')
    expect(window.location.search).toBe('?view=completed')

    window.history.back()
    return settled.then(() => {
      expect(window.location.search).toBe('?view=plan')
      expect(useTodos.getState().view, 'the address went back and the screen did not').toBe('plan')
    })
  })

  it('puts the store back where the address is when something else moves the address', () => {
    reset()
    useTodos.getState().setView('starred')
    // What the browser does on its own: the address changes, and the store has to follow it.
    window.history.replaceState(null, '', '/todo?view=plan&q=tax')
    useTodos.getState().syncFromAddress()
    expect(useTodos.getState().view).toBe('plan')
    expect(useTodos.getState().query).toBe('tax')
  })
})
