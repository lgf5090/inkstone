import { type Completion, CompletionContext } from '@codemirror/autocomplete'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../lib/i18n'
import { findReferenceEntry, referenceModuleDoc, REFERENCE_ENTRIES, REFERENCE_MODULES } from '../lib/templater/reference/registry'
import { templaterCompletion, type TemplaterCompletionOptions } from './templater-completion'

/**
 * The engine, watched.
 *
 * "The document is never scanned whole" is the promise this source's window makes, and a correct but
 * quadratic version would pass every other test in this file. So the parse is counted by the text it was
 * handed, which is the only way to ask the question without a browser.
 */
const scans = vi.hoisted(() => ({ texts: [] as string[] }))

vi.mock('../lib/templater/engine/parser', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/templater/engine/parser')>()
  return {
    ...real,
    parseTemplate(template: string) {
      scans.texts.push(template)
      return real.parseTemplate(template)
    },
  }
})

// jsdom has no Range.getClientRects, which CodeMirror's measurement needs once a view is attached.
{
  const proto = Range.prototype as unknown as { getClientRects?: () => DOMRectList }
  if (!proto.getClientRects) proto.getClientRects = () => [] as unknown as DOMRectList
}

beforeAll(async () => {
  await initI18n()
})

const MODULES = REFERENCE_MODULES.map((module) => module.module)

function source(options: Partial<TemplaterCompletionOptions> = {}): ReturnType<typeof templaterCompletion> {
  return templaterCompletion({ intellisenseRender: () => '1', ...options })
}

async function completeAt(doc: string, caret = doc.length, options: Partial<TemplaterCompletionOptions> = {}) {
  const state = EditorState.create({ doc, selection: EditorSelection.cursor(caret) })
  const result = await source(options)(new CompletionContext(state, caret, true))
  return { result, state }
}

async function labelsOf(doc: string, caret = doc.length, options: Partial<TemplaterCompletionOptions> = {}): Promise<string[]> {
  const { result } = await completeAt(doc, caret, options)
  return result?.options.map((option) => option.label) ?? []
}

/** One row of the registry, by name, the way the rows are labelled. */
function registryNames(module: string): string[] {
  return REFERENCE_ENTRIES.filter((entry) => entry.module === module).map((entry) => entry.name)
}

/** The members a module owns: the registry's entries for it, minus a placeholder or the module itself. */
function documentedMembers(module: string): string[] {
  return REFERENCE_ENTRIES
    .filter((entry) => entry.module === module && !entry.dynamic && entry.name !== module)
    .map((entry) => entry.name)
}

/** What the documentation panel says about a row, one line per element. */
async function infoLines(option: Completion): Promise<string[]> {
  const rendered = typeof option.info === 'function' ? await option.info(option) : option.info
  if (!rendered) return []
  if (typeof rendered === 'string') return rendered.split('\n')
  const dom = 'childNodes' in rendered ? rendered : 'dom' in rendered ? rendered.dom : null
  if (!dom) return []
  return Array.from(dom.childNodes).map((node) => node.textContent ?? '').filter(Boolean)
}

async function rowFor(doc: string, label: string, options: Partial<TemplaterCompletionOptions> = {}): Promise<Completion> {
  const { result } = await completeAt(doc, undefined, options)
  expect(result, doc).not.toBeNull()
  const row = result!.options.find((option) => option.label === label)
  expect(row, `${label} was not offered in ${JSON.stringify(result!.options.map((option) => option.label))}`).toBeTruthy()
  return row!
}

/** Accept a row in a real view, and report what the note says afterwards and where the caret ended up. */
async function accept(
  doc: string,
  label: string,
  caret = doc.length,
  options: Partial<TemplaterCompletionOptions> = {},
): Promise<{ text: string, caret: number }> {
  const { result, state } = await completeAt(doc, caret, options)
  expect(result, doc).not.toBeNull()
  const row = result!.options.find((option) => option.label === label)
  expect(row, `${label} was not offered in ${JSON.stringify(result!.options.map((option) => option.label))}`).toBeTruthy()
  const host = document.createElement('div')
  document.body.append(host)
  const view = new EditorView({ state, parent: host })
  ;(row!.apply as (view: EditorView, completion: Completion, from: number, to?: number) => void)(
    view, row!, result!.from, view.state.selection.main.head,
  )
  const text = view.state.doc.toString()
  const anchor = view.state.selection.main.head
  view.destroy()
  host.remove()
  return { text, caret: anchor }
}

describe('where the menu appears', () => {
  it('stays out of anything that is not a command', async () => {
    expect((await completeAt('prose about tp.file.title and tp.date')).result).toBeNull()
    expect((await completeAt('{{ tp.file.title }}')).result).toBeNull()
    expect((await completeAt('a `tp.date.now` span in a sentence')).result).toBeNull()
    expect((await completeAt('- [ ] tp.file.rename the note')).result).toBeNull()
    expect((await completeAt('[[tp.file.title]]')).result).toBeNull()
  })

  it('waits for the dot after the namespace', async () => {
    expect((await completeAt('<% tp')).result).toBeNull()
    expect(await labelsOf('<% tp.')).toEqual(MODULES)
  })

  it('answers every opening form the engine reads', async () => {
    for (const open of ['<%', '<%*', '<%+', '<%*+', '<%+-', '<%_-', '<%_*']) {
      expect(await labelsOf(`${open} tp.`), open).toEqual(MODULES)
    }
    // A command the engine refuses is not one to complete inside of.
    expect((await completeAt('<%~ tp.')).result).toBeNull()
  })

  it('is alive in the tag the reader is still typing', async () => {
    expect(await labelsOf('<% tp.file.ren')).toContain('rename')
    expect(await labelsOf('<%* const x = 1\nawait tp.file.')).toContain('rename')
  })

  it('lets go of a command the caret has already left', async () => {
    expect((await completeAt('<% tp.file.title %> and then tp.')).result).toBeNull()
  })

  it('reads the command under the caret when the note holds several', async () => {
    const doc = '<% tp.file.title %>\nthat note is closed, this one is <% tp.'
    expect(await labelsOf(doc)).toEqual(MODULES)
  })

  it('follows the engine into a fenced block, because a run executes a command there too', async () => {
    expect(await labelsOf('```js\n<% tp.')).toEqual(MODULES)
  })

  it('spends one bounded parse on a note of any length', async () => {
    scans.texts.length = 0
    const doc = `${'prose '.repeat(6_000)}<% tp.`
    const { result } = await completeAt(doc)
    expect(result).not.toBeNull()
    expect(scans.texts).toHaveLength(1)
    for (const scanned of scans.texts) expect(scanned.length).toBeLessThanOrEqual(2_048)
  })
})

describe('what the rows offer', () => {
  it('offers the modules, and no member of a module the caret has not named', async () => {
    const labels = await labelsOf('<% tp.')
    expect(labels).toEqual(MODULES)
    expect(labels).not.toContain('rename')
    expect(labels).not.toContain('now')
  })

  it('offers exactly the registry’s members of the named module', async () => {
    const { result } = await completeAt('<% tp.file.')
    expect(result).not.toBeNull()
    const labels = result!.options.map((option) => option.label)
    expect(labels).toContain('rename')
    expect(labels).toContain('move')
    expect(labels).toContain('include')
    expect([...labels].sort()).toEqual([...registryNames('file')].sort())
    expect(labels).not.toContain('now')
  })

  it('holds every offered name to the registry, module by module', async () => {
    for (const module of MODULES) {
      expect(await labelsOf(`<% tp.${module}.`), module).toEqual(documentedMembers(module))
    }
  })

  it('keeps the façade’s documented members available', async () => {
    expect(await labelsOf('<% tp.app.')).toEqual(documentedMembers('app'))
    expect(await labelsOf('<% tp.obsidian.')).toEqual(documentedMembers('obsidian'))
  })

  it('writes no member for a module whose members are the reader’s own', async () => {
    // The registry's own `dynamic` flag is why: under these two the only entries are placeholders.
    for (const module of ['user', 'frontmatter']) {
      expect(REFERENCE_ENTRIES.filter((entry) => entry.module === module).every((entry) => entry.dynamic), module).toBe(true)
      expect((await completeAt(`<% tp.${module}.`)).result).toBeNull()
    }
    // `tp.moment` is the function itself, so there is no `tp.moment.moment` either.
    expect((await completeAt('<% tp.moment.')).result).toBeNull()
    expect(findReferenceEntry('moment', 'moment')).toBeTruthy()
  })

  it('refuses a chain nobody documented', async () => {
    expect((await completeAt('<% tp.nope.')).result).toBeNull()
    expect((await completeAt('<% tp.app.vault.')).result).toBeNull()
    expect((await completeAt('<% mytp.')).result).toBeNull()
    expect((await completeAt('<% tp.file.rename(')).result).toBeNull()
    expect((await completeAt('<% tp.file.title %)')).result).toBeNull()
  })

  it('starts the replacement at the half-typed name', async () => {
    const doc = '<% tp.file.ren'
    const { result } = await completeAt(doc)
    expect(result!.from).toBe(doc.length - 'ren'.length)
  })

  it('leaves a committed input-method segment alone', async () => {
    // CodeMirror tags composition input `input.type.compose` and its autocomplete only acts on `input.type`,
    // so no completion source in this editor carries an IME branch — neither `completion.ts` nor
    // `task-completion.ts` does. What is left to pin is that half a word in another script is not a path.
    // Built from code points so no Han character sits in a source file, which is what the comment gate
    // asks of anything that has to name Chinese.
    const committed = String.fromCharCode(0x4e2d)
    const committedWord = String.fromCharCode(0x6587, 0x4ef6)
    expect((await completeAt(`<% tp.${committed}`)).result).toBeNull()
    expect((await completeAt(`<% tp.file.${committedWord}`)).result).toBeNull()
    expect(await labelsOf('<% tp.file.tit')).toContain('title')
  })
})

describe('the documentation each level shows', () => {
  const now = () => findReferenceEntry('date', 'now')!
  const rowAt = (level: string, doc = '<% tp.date.', label = 'now') => rowFor(doc, label, { intellisenseRender: () => level })

  it('shows nothing at all at level 0', async () => {
    const { result } = await completeAt('<% tp.', undefined, { intellisenseRender: () => '0' })
    expect(result).not.toBeNull()
    for (const option of result!.options) {
      expect(option.label).toBeTruthy()
      expect(option.detail).toBeUndefined()
      expect(option.info).toBeUndefined()
    }
  })

  it('shows the signature, the description, the parameters and the return at level 1', async () => {
    const row = await rowAt('1')
    const documented = now()
    const lines = await infoLines(row)
    expect(row.detail).toBe(t(documented.descriptionKey))
    expect(lines[0]).toBe(documented.signature)
    expect(lines).toContain(t(documented.descriptionKey))
    for (const arg of documented.args) expect(lines, arg.name).toContain(`${arg.name}: ${t(arg.descriptionKey)}`)
    expect(lines).toContain(t(documented.returnsKey!))
    for (const example of documented.examples) expect(lines, example).not.toContain(example)
  })

  it('adds the examples at level 2', async () => {
    const lines = await infoLines(await rowAt('2'))
    for (const example of now().examples) expect(lines, example).toContain(example)
  })

  it('adds the module the member belongs to at level 3', async () => {
    const module = referenceModuleDoc('date')!
    expect(await infoLines(await rowAt('2'))).not.toContain(t(module.descriptionKey))
    expect(await infoLines(await rowAt('3'))).toContain(t(module.descriptionKey))
  })

  it('says outright that a dynamic module’s list is not a boundary, from level 1 up', async () => {
    const module = referenceModuleDoc('obsidian')!
    expect(module.dynamic).toBe(true)
    const lines = await infoLines(await rowAt('1', '<% tp.obsidian.', 'Notice'))
    expect(lines[0]).toBe(findReferenceEntry('obsidian', 'Notice')!.signature)
    expect(lines[1]).toBe(t(module.descriptionKey))
  })

  it('has nothing further to render at level 4', async () => {
    // Upstream's fifth level differs only in running the description through Templater itself, and a tooltip
    // may not start a run to draw one line of prose.
    const deepest = await infoLines(await rowAt('4'))
    expect(deepest.length).toBeGreaterThan(3)
    expect(deepest).toContain(t(referenceModuleDoc('date')!.descriptionKey))
    expect(deepest).toEqual(await infoLines(await rowAt('3')))
  })

  it('documents a module row from the registry’s module blurb', async () => {
    const module = referenceModuleDoc('file')!
    const lines = await infoLines(await rowFor('<% tp.', 'file'))
    expect(lines[0]).toBe(`tp.${module.module}`)
    expect(lines[1]).toBe(t(module.descriptionKey))
  })

  it('falls back to the shipped default rather than going silent', async () => {
    for (const raw of ['', '9', '1 ', 'RenderDescriptionParameterReturn']) {
      const row = await rowAt(raw)
      expect(row.detail, raw).toBeTruthy()
      expect(await infoLines(row), raw).toContain(t(now().descriptionKey))
    }
  })

  it('keeps a long description short enough for the row, and whole in the panel', async () => {
    const full = t(referenceModuleDoc('app')!.descriptionKey)
    const row = await rowFor('<% tp.', 'app')
    expect(row.detail!.length).toBeLessThanOrEqual(full.length)
    expect(full.startsWith(row.detail!)).toBe(true)
    expect((await infoLines(row))[1]).toBe(full)
  })
})

describe('what lands in the note', () => {
  it('completes a value without touching the rest of the tag', async () => {
    const { text, caret } = await accept('<% tp.file.tit %>', 'title', '<% tp.file.tit'.length)
    expect(text).toBe('<% tp.file.title %>')
    expect(caret).toBe('<% tp.file.title'.length)
  })

  it('completes a function into its call form with the caret on the arguments', async () => {
    const { text, caret } = await accept('<% tp.date.now', 'now')
    expect(text).toBe('<% tp.date.now()')
    expect(text.slice(caret - 1, caret)).toBe('(')
    expect(text.slice(caret, caret + 1)).toBe(')')
  })

  it('puts the caret past a call that takes nothing', async () => {
    const { text, caret } = await accept('<%* tp.file.selectio', 'selection')
    expect(text).toBe('<%* tp.file.selection()')
    expect(text.slice(caret - 2, caret)).toBe('()')
  })

  it('adopts the parenthesis already in the note instead of doubling it', async () => {
    const doc = '<% tp.date.now() %>'
    const { text, caret } = await accept(doc, 'now', '<% tp.date.now'.length)
    expect(text).toBe('<% tp.date.now() %>')
    expect(text.slice(caret - 1, caret)).toBe('(')
  })

  it('keeps the chain going when a module is picked', async () => {
    const { text, caret } = await accept('<% tp.', 'file')
    expect(text).toBe('<% tp.file.')
    expect(caret).toBe(text.length)
  })

  it('calls a module that is a function itself', async () => {
    const { text, caret } = await accept('<% tp.mome', 'moment')
    expect(text).toBe('<% tp.moment()')
    expect(text.slice(caret - 1, caret)).toBe('(')
  })

  it('reports the completion as a completion, not as typing', async () => {
    const doc = '<% tp.'
    const events: boolean[] = []
    const state = EditorState.create({
      doc,
      selection: EditorSelection.cursor(doc.length),
      extensions: [EditorView.updateListener.of((update) => {
        for (const transaction of update.transactions) events.push(transaction.isUserEvent('input.complete'))
      })],
    })
    const result = await source()(new CompletionContext(state, doc.length, true))
    expect(result).not.toBeNull()
    const row = result!.options.find((option) => option.label === 'file')!
    const host = document.createElement('div')
    document.body.append(host)
    const view = new EditorView({ state, parent: host })
    ;(row.apply as (view: EditorView, completion: Completion, from: number, to?: number) => void)(
      view, row, result!.from, view.state.selection.main.head,
    )
    expect(events).toEqual([true])
    view.destroy()
    host.remove()
  })
})

describe('members a run would refuse', () => {
  it('still completes them, and says why the run would not', async () => {
    const row = await rowFor('<% tp.file.re', 'rename', { profile: () => 'community' })
    expect(await infoLines(row)).toContain(t('templater.error.capability_blocked'))
  })

  it('says nothing of the kind when the profile allows it', async () => {
    const row = await rowFor('<% tp.file.re', 'rename', { profile: () => 'local' })
    expect(await infoLines(row)).not.toContain(t('templater.error.capability_blocked'))
  })

  it('stays out of the way until a profile is wired in', async () => {
    const row = await rowFor('<% tp.file.re', 'rename')
    expect(await infoLines(row)).not.toContain(t('templater.error.capability_blocked'))
  })

  it('keeps the marking out of level 0', async () => {
    const row = await rowFor('<% tp.file.re', 'rename', { profile: () => 'community', intellisenseRender: () => '0' })
    expect(row.info).toBeUndefined()
  })
})

describe('the reader’s own scripts', () => {
  const folder = {
    names: async () => ['greeting', 'helpers'],
    members: async (name: string) => (name === 'helpers' ? ['left', 'right'] : []),
  }

  it('lists the folder for `tp.user.`, which the registry alone cannot do', async () => {
    expect(await labelsOf('<% tp.user.', undefined, { userScripts: folder })).toEqual(['greeting', 'helpers'])
    // Without the page's answer there is nothing to offer: the registry's `tp.user.<script_name>` is a
    // placeholder, and writing it into a note would be writing a name no script answers.
    expect(await labelsOf('<% tp.user.')).toEqual([])
  })

  it('inserts a script name bare, because its export shape is inside its own text', async () => {
    const { result } = await completeAt('<% tp.user.gre', undefined, { userScripts: folder })
    const row = result?.options.find((option) => option.label === 'greeting')
    expect(row?.apply).toBe('greeting')
    expect(String(row?.detail)).toContain("Reader's own script")
  })

  it('lists the callable members of `tp.user.<script>.`', async () => {
    const { result } = await completeAt('<% tp.user.helpers.', undefined, { userScripts: folder })
    expect(result?.options.map((option) => option.label)).toEqual(['left', 'right'])
    // A member is known to be a function — an object export may only hold functions — so the call form is safe.
    expect(typeof result?.options[0]?.apply).toBe('function')
  })

  it('offers nothing for a function export, an unknown name, or a chain past the member', async () => {
    expect(await labelsOf('<% tp.user.greeting.', undefined, { userScripts: folder })).toEqual([])
    expect(await labelsOf('<% tp.user.absent.', undefined, { userScripts: folder })).toEqual([])
    expect(await labelsOf('<% tp.user.helpers.left(', undefined, { userScripts: folder })).toEqual([])
  })

  it('asks the page once per list, and never for a chain that is not `tp.user`', async () => {
    const names = vi.fn(async () => ['greeting'])
    const members = vi.fn(async () => ['left'])
    const source = { names, members }
    await labelsOf('<% tp.file.', undefined, { userScripts: source })
    expect(names).not.toHaveBeenCalled()
    expect(members).not.toHaveBeenCalled()
    await labelsOf('<% tp.user.', undefined, { userScripts: source })
    expect(names).toHaveBeenCalledTimes(1)
  })

  it('writes the name without documentation when the reader turned the panel off', async () => {
    const { result } = await completeAt('<% tp.user.', undefined, { userScripts: folder, intellisenseRender: () => '0' })
    expect(result?.options.map((option) => option.label)).toEqual(['greeting', 'helpers'])
    for (const option of result?.options ?? []) expect(option.detail).toBeUndefined()
  })
})

describe('the switch', () => {
  it('offers nothing while it is off', async () => {
    let on = false
    expect((await completeAt('<% tp.', undefined, { enabled: () => on })).result).toBeNull()
    on = true
    expect((await completeAt('<% tp.', undefined, { enabled: () => on })).result).not.toBeNull()
  })
})
