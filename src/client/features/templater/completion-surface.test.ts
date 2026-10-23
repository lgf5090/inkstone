import { describe, expect, it, vi } from 'vitest'

/**
 * The two halves of the `tp.user` completion path: the facade the editor is allowed to import, and the page
 * glue behind it. What is pinned here is the *seam* — that a keystroke reaches the store through a lazy import
 * and that the answers come from the folder the reader chose, not from a table this file keeps.
 */
const listScripts = vi.fn()
const describeScript = vi.fn()
// The mocked session and library version have to be readable from inside `vi.mock` factories, which run
// before this file's own statements, so the two knobs live in a hoisted object.
const probe = vi.hoisted(() => ({ folder: null as string | null, version: 1 }))

vi.mock('../../lib/templater/host/store-port', () => ({
  libraryRows: () => ({ notes: [], folders: [], templates: [] }),
  storeUserScriptPort: () => ({ listScripts, readScript: vi.fn() }),
}))
vi.mock('../../lib/templater/host/note-index-cache', () => ({
  // The cache key is the folder plus this version, so a test that wants a fresh listing bumps it the way a
  // reader editing a note would.
  libraryVersion: () => probe.version,
}))
vi.mock('../../lib/templater/host/user-scripts', () => ({
  createUserScriptProvider: () => ({ describe: describeScript, gather: vi.fn() }),
  // The name rule is the one the real module owns; the facade only sees what it returns.
  userScriptNameOf: (title: string) => (title.toLowerCase().endsWith('.js') ? title.slice(0, -3) : null),
}))
vi.mock('../../store/session', () => ({
  useSession: { getState: () => ({ settings: { templater: { userScriptsFolderId: probe.folder } } }) },
}))

const surface = () => import('./completion-surface')

describe('the script completion surface', () => {
  it('answers names from the folder listing, in the names the titles give them', async () => {
    probe.folder = 'folder-1'
    probe.version = 1
    listScripts.mockResolvedValue([
      { id: 'a', title: 'greeting.js', path: 'Scripts/greeting.js' },
      { id: 'b', title: 'helpers.JS', path: 'Scripts/Nested/helpers.JS' },
      { id: 'c', title: 'not a script', path: 'Scripts/not a script' },
    ])
    const source = (await surface()).templaterScriptSource()
    expect(await source.names()).toEqual(['greeting', 'helpers'])
  })

  it('prints one row per name when two notes claim the same one', async () => {
    probe.folder = 'folder-1'
    probe.version = 2
    listScripts.mockResolvedValue([
      { id: 'a', title: 'greeting.js', path: 'Scripts/a/greeting.js' },
      { id: 'b', title: 'greeting.js', path: 'Scripts/b/greeting.js' },
    ])
    const source = (await surface()).templaterScriptSource()
    // The refusal belongs to the run, which names both paths; a completion list that repeats a word reads as
    // this file's own bug.
    expect(await source.names()).toEqual(['greeting'])
  })

  it('answers nothing when the reader has not chosen a folder, without touching the store', async () => {
    probe.folder = null
    listScripts.mockClear()
    const source = (await surface()).templaterScriptSource()
    expect(await source.names()).toEqual([])
    expect(await source.members('greeting')).toEqual([])
    expect(listScripts).not.toHaveBeenCalled()
  })

  it('reads members only for the script the caret named, and only its callable ones', async () => {
    probe.folder = 'folder-1'
    describeScript.mockResolvedValue({
      ok: true,
      module: { surface: { kind: 'object', members: [
        { name: 'left', callable: true, params: [], docs: { summary: '', params: [], returns: '' } },
        { name: 'count', callable: false, params: [], docs: { summary: '', params: [], returns: '' } },
      ] } },
    })
    const source = (await surface()).templaterScriptSource()
    expect(await source.members('helpers')).toEqual(['left'])
    expect(describeScript).toHaveBeenCalledWith('helpers')
  })

  it('says nothing about a script it could not read', async () => {
    describeScript.mockResolvedValue({ ok: false, code: 'script-load-failed', detail: 'gone:not-found' })
    const source = (await surface()).templaterScriptSource()
    expect(await source.members('gone')).toEqual([])
  })

  it('keeps the sandbox out of the editor’s own import graph', async () => {
    // The facade is what `CodeEditor` may import statically; it must resolve to the same answers while
    // loading the glue only when a list is actually asked for.
    const facade = await import('./script-completion')
    listScripts.mockResolvedValue([{ id: 'a', title: 'greeting.js', path: 'Scripts/greeting.js' }])
    probe.folder = 'folder-1'
    probe.version = 99
    expect(await facade.templaterUserScripts.names()).toEqual(['greeting'])
    describeScript.mockResolvedValue({ ok: true, module: { surface: { kind: 'function', members: [] } } })
    expect(await facade.templaterUserScripts.members('greeting')).toEqual([])
  })
})
