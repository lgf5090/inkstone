import { describe, expect, it, vi } from 'vitest'
import {
  createUserScriptProvider,
  userScriptNameOf,
  type UserScriptPort,
  type UserScriptRecord,
} from './user-scripts'
import { MAX_USER_SCRIPTS_PER_RUN, MAX_USER_SCRIPTS_TOTAL_BYTES, MAX_USER_SCRIPT_BYTES } from '../limits'

/**
 * The rules a reader's script folder is judged by before any of it reaches the interpreter.
 *
 * These are the things that must not happen quietly: a name invented from a title that is not a script, two
 * files claiming one name with the later one winning, a folder that failed to read answering as "you never
 * saved that", a script dropped from a run so that a template naming it fails as though the file were missing.
 * And nothing here runs a script — the last test is the probe that says this module could not have.
 */

/** One script note: the title carries the `.js` that makes it a script, as plan §D13 defines it. */
interface FakeScript {
  id: string
  title: string
  path: string
  body: string
}

function script(id: string, body: string, overrides: Partial<FakeScript> = {}): FakeScript {
  const title = `${id}.js`
  return { id, title, path: `Scripts/${title}`, body, ...overrides }
}

/** A port that counts reads, so the "once per run" rule is a measurement rather than a claim. */
function fakePort(scripts: FakeScript[]): {
  port: UserScriptPort
  listings: () => number
  reads: () => Record<string, number>
} {
  const readCounts: Record<string, number> = {}
  let listings = 0
  const records: UserScriptRecord[] = scripts.map((one) => ({ id: one.id, title: one.title, path: one.path }))
  return {
    listings: () => listings,
    reads: () => readCounts,
    port: {
      listScripts: async () => {
        listings += 1
        return records
      },
      readScript: async (id: string) => {
        readCounts[id] = (readCounts[id] ?? 0) + 1
        const found = scripts.find((one) => one.id === id)
        if (!found) throw new Error(`no note ${id}`)
        return found.body
      },
    },
  }
}

function providerFor(scripts: FakeScript[]) {
  const harness = fakePort(scripts)
  return { ...harness, provider: createUserScriptProvider(harness.port) }
}

const FUNCTION_EXPORT = 'module.exports = (name) => `hi ${name}`'

/** The global object, read through a cast so a probe cannot be typed into existence. */
function globals(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>
}

describe('templater user scripts · naming', () => {
  it('takes the script name from the title’s `.js` suffix, case-insensitively on the extension', () => {
    expect(userScriptNameOf('my_script.js')).toBe('my_script')
    expect(userScriptNameOf('My_Script.JS')).toBe('My_Script')
    expect(userScriptNameOf('  padded.js  ')).toBe('padded')
  })

  it('refuses a title that is not a script, or whose stem could not be typed as a name', () => {
    for (const title of ['notes', 'notes.md', '.js', 'x.jss', './x.js', 'a/b.js', '..js']) {
      expect(userScriptNameOf(title), title).toBeNull()
    }
  })
})

describe('templater user scripts · describing one script', () => {
  it('finds a script by name and hands back its untouched text', async () => {
    const { provider, reads } = providerFor([script('greeting', FUNCTION_EXPORT)])
    const found = await provider.describe('greeting')
    expect(found.ok, JSON.stringify(found)).toBe(true)
    if (!found.ok) return
    expect(found.module.source).toBe(FUNCTION_EXPORT)
    expect(found.module.path).toBe('Scripts/greeting.js')
    expect(found.module.surface.kind).toBe('function')
    expect(reads()).toEqual({ greeting: 1 })
  })

  it('reports an unknown name as a load failure that names it', async () => {
    const { provider, reads } = providerFor([script('greeting', FUNCTION_EXPORT)])
    expect(await provider.describe('absent')).toMatchObject({
      ok: false,
      code: 'script-load-failed',
      detail: 'absent:not-found',
    })
    expect(reads()).toEqual({})
  })

  it('lists the folder once and reads one script at most once, however many calls name it', async () => {
    const { provider, listings, reads } = providerFor([script('greeting', FUNCTION_EXPORT)])
    await Promise.all([provider.describe('greeting'), provider.describe('greeting'), provider.describe('greeting')])
    expect(listings()).toBe(1)
    expect(reads()).toEqual({ greeting: 1 })
  })

  it('reads only the script a call named, and not the one it did not', async () => {
    const { provider, reads } = providerFor([script('greeting', FUNCTION_EXPORT), script('other', FUNCTION_EXPORT)])
    await provider.describe('greeting')
    expect(reads()).toEqual({ greeting: 1 })
  })

  it('treats a store rejection as one call’s failure, with the path and a logged cause', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const harness = fakePort([script('greeting', FUNCTION_EXPORT)])
    const broken = createUserScriptProvider({
      listScripts: harness.port.listScripts,
      readScript: async () => {
        throw new Error('the row is gone')
      },
    })
    expect(await broken.describe('greeting')).toMatchObject({
      ok: false,
      code: 'script-load-failed',
      detail: 'Scripts/greeting.js',
    })
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('the row is gone'))
    warning.mockRestore()
  })

  it('keeps a prototype name from reaching the object prototype', async () => {
    const { provider } = providerFor([script('greeting', FUNCTION_EXPORT)])
    expect(await provider.describe('toString')).toMatchObject({ detail: 'toString:not-found' })
    expect(await provider.describe('__proto__')).toMatchObject({ detail: '__proto__:not-found' })
  })

  it('refuses a class as something the panels should not offer, and a file with no export as unreadable', async () => {
    const classed = providerFor([script('maker', 'module.exports = class Widget {}')])
    expect(await classed.provider.describe('maker')).toMatchObject({
      ok: false,
      code: 'not-supported',
      detail: 'maker:class-export',
    })
    const silent = providerFor([script('silent', 'const unused = 1')])
    expect(await silent.provider.describe('silent')).toMatchObject({ ok: false, detail: 'silent:no-export' })
  })
})

describe('templater user scripts · the batch a run is handed', () => {
  it('carries every script as name, module path and text', async () => {
    const { provider } = providerFor([script('one', FUNCTION_EXPORT), script('two', FUNCTION_EXPORT)])
    const batch = await provider.gather()
    expect(batch.unavailable).toBeNull()
    expect(batch.sources).toEqual([
      { name: 'one', path: 'Scripts/one.js', source: FUNCTION_EXPORT },
      { name: 'two', path: 'Scripts/two.js', source: FUNCTION_EXPORT },
    ])
  })

  it('answers an empty folder with no scripts and no complaint', async () => {
    const { provider } = providerFor([])
    expect(await provider.gather()).toEqual({ sources: [], unavailable: null })
  })

  it('gathers once per run, because the listing and the reads are the run’s', async () => {
    const { provider, listings, reads } = providerFor([script('one', FUNCTION_EXPORT)])
    await provider.gather()
    await provider.gather()
    expect(listings()).toBe(1)
    expect(reads()).toEqual({ one: 1 })
  })

  it('says which module path a title became, whatever case the extension was written in', async () => {
    const { provider } = providerFor([script('Helper', FUNCTION_EXPORT, { title: 'Helper.JS', path: 'Scripts/Helper.JS' })])
    expect((await provider.gather()).sources).toEqual([
      { name: 'Helper', path: 'Scripts/Helper.js', source: FUNCTION_EXPORT },
    ])
  })

  it('refuses a name two notes claim, listing both paths, and still carries the script nobody argued about', async () => {
    const { provider, reads } = providerFor([
      script('dup', FUNCTION_EXPORT, { id: 'a', path: 'Scripts/a/dup.js' }),
      script('dup', FUNCTION_EXPORT, { id: 'b', path: 'Scripts/b/dup.js' }),
      script('single', FUNCTION_EXPORT, { id: 'c' }),
    ])
    const batch = await provider.gather()
    const refused = batch.sources.find((one) => one.name === 'dup')
    expect(refused?.refusal).toMatchObject({
      code: 'script-name-conflict',
      detail: 'dup:Scripts/a/dup.js,Scripts/b/dup.js',
    })
    expect(refused?.source).toBe('')
    expect(batch.sources.find((one) => one.name === 'single')?.source).toBe(FUNCTION_EXPORT)
    // Neither collided file is read: scanning one of them would be choosing a winner, which is the silence
    // this refusal exists to prevent.
    expect(reads()).toEqual({ c: 1 })
  })

  it('does not call the same note listed twice a conflict', async () => {
    const { provider } = providerFor([script('dup', FUNCTION_EXPORT), script('dup', FUNCTION_EXPORT, { id: 'again' })])
    const batch = await provider.gather()
    expect(batch.sources.filter((one) => one.name === 'dup')).toHaveLength(1)
    expect(batch.sources[0].refusal).toBeUndefined()
  })

  it('refuses an unreadable script with its path and carries the one beside it', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const harness = fakePort([script('one', FUNCTION_EXPORT), script('two', FUNCTION_EXPORT)])
    const provider = createUserScriptProvider({
      listScripts: harness.port.listScripts,
      readScript: async (id) => (id === 'two' ? Promise.reject(new Error('offline')) : harness.port.readScript(id)),
    })
    const batch = await provider.gather()
    expect(batch.sources.find((one) => one.name === 'two')?.refusal).toMatchObject({
      code: 'script-load-failed',
      detail: 'Scripts/two.js',
    })
    expect(batch.sources.find((one) => one.name === 'one')?.source).toBe(FUNCTION_EXPORT)
    warning.mockRestore()
  })

  it('refuses a file bigger than one script may be, by its path, and carries the small one beside it', async () => {
    const huge = `module.exports = () => '${'x'.repeat(MAX_USER_SCRIPT_BYTES + 10)}'`
    const { provider } = providerFor([script('huge', huge), script('small', FUNCTION_EXPORT)])
    const batch = await provider.gather()
    expect(batch.sources.find((one) => one.name === 'huge')?.refusal).toMatchObject({
      code: 'script-load-failed',
      detail: 'Scripts/huge.js:too-large',
    })
    expect(batch.sources.find((one) => one.name === 'small')?.source).toBe(FUNCTION_EXPORT)
  })

  it('refuses the whole folder once it is past what one run may hold, saying how many there are', async () => {
    const crowd = Array.from({ length: MAX_USER_SCRIPTS_PER_RUN + 1 }, (_, index) =>
      script(`s${String(index).padStart(3, '0')}`, FUNCTION_EXPORT))
    const { provider, reads } = providerFor(crowd)
    const batch = await provider.gather()
    expect(batch.sources).toHaveLength(crowd.length)
    expect(new Set(batch.sources.map((one) => one.refusal?.detail))).toEqual(new Set([`count:${crowd.length}`]))
    // The count is known from the listing, so a folder that cannot be run at all is not also read.
    expect(reads()).toEqual({})
  })

  it('refuses every script once the folder is past the run’s byte budget, saying how many bytes', async () => {
    const each = 'x'.repeat(Math.floor(MAX_USER_SCRIPTS_TOTAL_BYTES / 3) + 16)
    const bodies = ['a', 'b', 'c'].map((one) => script(`s${one}`, `module.exports = () => '${each}'`))
    const { provider } = providerFor(bodies)
    const batch = await provider.gather()
    expect(new Set(batch.sources.map((one) => one.refusal?.code))).toEqual(new Set(['user-scripts-unavailable']))
    expect(batch.sources[0].refusal?.detail).toMatch(/^bytes:/)
    for (const one of batch.sources) expect(one.source).toBe('')
  })

  it('carries a script that exports nothing, because that is the interpreter’s question to answer', async () => {
    const { provider } = providerFor([script('silent', 'const unused = 1')])
    expect(await provider.gather()).toEqual({
      sources: [{ name: 'silent', path: 'Scripts/silent.js', source: 'const unused = 1' }],
      unavailable: null,
    })
  })

  it('says the folder is unavailable when the listing fails, and asks again next time', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let attempts = 0
    const provider = createUserScriptProvider({
      listScripts: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('the store is offline')
        return [{ id: 'one', title: 'one.js', path: 'Scripts/one.js' }]
      },
      readScript: async () => FUNCTION_EXPORT,
    })
    expect(await provider.gather()).toEqual({ sources: [], unavailable: 'listing-failed' })
    expect((await provider.gather()).sources).toHaveLength(1)
    expect(attempts).toBe(2)
    warning.mockRestore()
  })

  it('does not evaluate a single byte of what it read', async () => {
    // The probe is the point: a module that reached for `new Function` or `eval` to answer a question about
    // exports would set this and pass every other test here anyway.
    const marker = 'globalThis.__inkstone_user_script_probe = 1'
    const { provider } = providerFor([script('probed', `module.exports = () => { ${marker}; return 1 }`)])
    await provider.gather()
    await provider.describe('probed')
    expect(globals().__inkstone_user_script_probe).toBeUndefined()
  })
})
