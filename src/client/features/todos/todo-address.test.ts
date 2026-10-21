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
import { parseTodoAddress, setTodoLayout, writeTodoSearch } from './todo-address'

const EMPTY_COUNTS = { inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {} }

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      list: async () => ({ tasks: [], total: 0, counts: EMPTY_COUNTS, dayEnd: Date.now() + 3_600_000, timezone: 'UTC' }),
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
    expect(writeTodoSearch({ view: 'board', listId: null, tagId: null, query: '', sort: null, dueFrom: null, dueTo: null })).toBe('')
  })

  it('names a smart view by the word the container answers to', () => {
    expect(parseTodoAddress('/todo', 'view=today')).toMatchObject({ view: 'today', listId: null, tagId: null })
    expect(parseTodoAddress('/todo', 'view=plan')).toMatchObject({ view: 'plan', listId: null, tagId: null })
    expect(parseTodoAddress('/todo', 'view=starred')).toMatchObject({ view: 'starred' })
    expect(parseTodoAddress('/todo', 'view=completed')).toMatchObject({ view: 'completed' })
    // The one spelling this app writes for its own screen.
    expect(writeTodoSearch({ view: 'today', listId: null, tagId: null, query: '', sort: null, dueFrom: null, dueTo: null }))
      .toBe('view=today')
  })

  it('carries the list layout, and only beside a collection that has one', () => {
    expect(parseTodoAddress('/todo', 'list=work&layout=columns')).toMatchObject({ view: 'list', listId: 'work', layout: 'columns' })
    expect(parseTodoAddress('/todo', 'list=work').layout).toBeNull()
    // The arrangement belongs to one list's screen: a smart view or a tag ignores it.
    expect(parseTodoAddress('/todo', 'view=plan&layout=columns').layout).toBeNull()
    expect(parseTodoAddress('/todo', 'tag=errands&layout=columns').layout).toBeNull()
    expect(writeTodoSearch({
      view: 'list', listId: 'work', tagId: null, query: '', sort: null, dueFrom: null, dueTo: null, layout: 'columns',
    })).toBe('list=work&layout=columns')
    // The ordinary list is what an address without the parameter already means, so it is not written.
    expect(writeTodoSearch({
      view: 'list', listId: 'work', tagId: null, query: '', sort: null, dueFrom: null, dueTo: null, layout: 'list',
    })).toBe('list=work')
  })

  it('names a list or a tag by its own parameter, which is what makes the view implicit', () => {
    expect(parseTodoAddress('/todo', 'list=work')).toMatchObject({ view: 'list', listId: 'work', tagId: null })
    expect(parseTodoAddress('/todo', 'tag=errands')).toMatchObject({ view: 'tag', tagId: 'errands', listId: null })
    expect(writeTodoSearch({ view: 'list', listId: 'work', tagId: null, query: '', sort: null, dueFrom: null, dueTo: null })).toBe('list=work')
    expect(writeTodoSearch({ view: 'tag', listId: null, tagId: 'errands', query: '', sort: null, dueFrom: null, dueTo: null })).toBe('tag=errands')
  })

  it('carries the search text beside the view, and reads it back with its spaces', () => {
    expect(parseTodoAddress('/todo', 'view=plan&q=renew%20the%20lease')).toMatchObject({ view: 'plan', query: 'renew the lease' })
    expect(writeTodoSearch({ view: 'plan', listId: null, tagId: null, query: 'renew the lease', sort: null, dueFrom: null, dueTo: null })).toBe('view=plan&q=renew+the+lease')
  })

  it('reads a view it does not have as the board rather than as a broken screen', () => {
    expect(parseTodoAddress('/todo', 'view=nonsense').view).toBe('board')
    expect(parseTodoAddress('/todo', 'view=&q=x').view).toBe('board')
    // An address that is not the to-do app's at all is not a view either.
    expect(parseTodoAddress('/notes', 'view=plan').view).toBe('board')
  })

  it('carries the order and the due window beside the view, and leaves them out when unset', () => {
    expect(writeTodoSearch({
      view: 'plan', listId: null, tagId: null, query: '', sort: 'priority', dueFrom: '2026-10-20T00:00', dueTo: '2026-10-21T00:00',
    })).toBe('view=plan&sort=priority&dueFrom=2026-10-20T00%3A00&dueTo=2026-10-21T00%3A00')
    // A word the route does not read is a pasted address, not a screen: it falls back to the default.
    expect(parseTodoAddress('/todo', 'sort=nonsense').sort).toBeNull()
    expect(parseTodoAddress('/todo', 'dueFrom=next%20week').dueFrom).toBeNull()
  })

  it('narrows finished work to one collection without renaming the view', () => {
    // `list=` alone still names the list view; beside `view=completed` it is the collection the
    // finished page is scoped to, which is the one combination where the two spellings differ.
    expect(parseTodoAddress('/todo', 'view=completed&list=work')).toMatchObject({ view: 'completed', listId: 'work' })
    expect(parseTodoAddress('/todo', 'list=work&view=completed')).toMatchObject({ view: 'completed', listId: 'work' })
    expect(parseTodoAddress('/todo', 'list=work').view).toBe('list')
    expect(writeTodoSearch({
      view: 'completed', listId: 'work', tagId: null, query: '', sort: null, dueFrom: null, dueTo: null,
    })).toBe('view=completed&list=work')
  })

  it('carries the completion window on the finished view, and only there', () => {
    expect(writeTodoSearch({
      view: 'completed', listId: null, tagId: null, query: '', sort: null, dueFrom: null, dueTo: null,
      completedFrom: '2025-01-01', completedTo: '2026-01-01',
    })).toBe('view=completed&completedFrom=2025-01-01&completedTo=2026-01-01')
    expect(parseTodoAddress('/todo', 'view=completed&completedFrom=2025-01-01&completedTo=2026-01-01'))
      .toMatchObject({ view: 'completed', completedFrom: '2025-01-01', completedTo: '2026-01-01' })
    // A bound that is not a calendar day is somebody else's parameter: it is dropped rather than
    // narrowing the page to a question the screen never asked.
    expect(parseTodoAddress('/todo', 'view=completed&completedFrom=last%20year').completedFrom).toBeNull()
    // The window belongs to the finished view; a list address that carries one is the list screen.
    expect(parseTodoAddress('/todo', 'list=work&completedFrom=2025-01-01').completedFrom).toBeNull()
  })

  it('round-trips: a shape written and read again is the shape it started as', () => {
    const shapes = [
      { view: 'board' as const, listId: null, tagId: null, query: '', sort: null, dueFrom: null, dueTo: null },
      { view: 'today' as const, listId: null, tagId: null, query: '', sort: null, dueFrom: null, dueTo: null },
      { view: 'plan' as const, listId: null, tagId: null, query: 'tax', sort: 'priority' as const, dueFrom: null, dueTo: null },
      { view: 'calendar' as const, listId: null, tagId: null, query: '', sort: null, dueFrom: null, dueTo: null },
      { view: 'list' as const, listId: 'work', tagId: null, query: '', sort: null, dueFrom: '2026-10-01T00:00', dueTo: '2026-10-31T00:00' },
      { view: 'list' as const, listId: 'work', tagId: null, query: '', sort: null, dueFrom: null, dueTo: null, layout: 'columns' as const },
      { view: 'tag' as const, listId: null, tagId: 'errands', query: 'a b', sort: 'created' as const, dueFrom: null, dueTo: null },
      { view: 'completed' as const, listId: null, tagId: null, query: '', sort: null, dueFrom: null, dueTo: null },
      { view: 'completed' as const, listId: 'work', tagId: null, query: '', sort: null, dueFrom: null, dueTo: null },
      {
        view: 'completed' as const, listId: null, tagId: null, query: '', sort: 'priority' as const,
        dueFrom: null, dueTo: null, completedFrom: '2025-01-01', completedTo: '2026-01-01',
      },
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
    useTodos.setState({
      view: 'board', listId: null, tagId: null, query: '', sort: null, dueFrom: null, dueTo: null,
      selectedId: null, editorOpen: false, draft: null,
    })
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

  it('keeps the chosen layout while the rest of the view state is rewritten', () => {
    reset()
    useTodos.getState().setView('list', { listId: 'work' })
    setTodoLayout('columns')
    expect(window.location.search).toBe('?list=work&layout=columns')

    // A search or a filter rewrite is not a move back to the plain list. The store's selection does
    // not carry the layout, so the address writer is what has to keep it.
    useTodos.getState().setQuery('tax')
    expect(window.location.search).toBe('?list=work&layout=columns&q=tax')

    setTodoLayout('list')
    expect(window.location.search).toBe('?list=work&q=tax')
  })

  it('follows a completion window a back button brings back', () => {
    reset()
    useTodos.getState().setView('completed')
    window.history.replaceState(null, '', '/todo?view=completed&completedFrom=2025-01-01&completedTo=2026-01-01')
    useTodos.getState().syncFromAddress()
    expect(useTodos.getState().view).toBe('completed')
    expect(useTodos.getState().completedFrom).toBe('2025-01-01')
    expect(useTodos.getState().completedTo).toBe('2026-01-01')
  })
})
