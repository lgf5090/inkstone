import { describe, expect, it, vi } from 'vitest'
import type { HostCall } from '../protocol'
import {
  answerUserScriptCall,
  createUserScriptProvider,
  decodeUserScriptCall,
  scanUserScript,
  userScriptNameOf,
  type UserScriptFailure,
  type UserScriptLookup,
  type UserScriptPort,
  type UserScriptProvider,
  type UserScriptRecord,
} from './user-scripts'

/**
 * These are the rules a reader's script file is judged by, so they read as a list of things that must never
 * happen quietly: a name invented from a comment, a module the app cannot provide let through, a broken file
 * that takes other templates down with it, a failure turned into `undefined`.
 *
 * The scanner is deliberately weaker than upstream's `acorn` parse (plan §D8: this app does not depend on it),
 * so some tests below exist to pin the weakness rather than the behaviour. Each one says which way it fails,
 * and every one of them fails *closed*: the name is missing and the call is refused, never guessed.
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
function fakePort(scripts: FakeScript[]): { port: UserScriptPort; listings: () => number; reads: () => Record<string, number> } {
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

function providerFor(scripts: FakeScript[]): UserScriptProvider {
  return createUserScriptProvider(fakePort(scripts).port)
}

/** A resolved module, or a failing test that says which code refused it. */
async function described(provider: UserScriptProvider, name: string): Promise<UserScriptLookup> {
  return provider.describe(name)
}

async function refused(provider: UserScriptProvider, name: string): Promise<UserScriptFailure> {
  const found = await described(provider, name)
  if (found.ok) throw new Error(`described ${name} as a ${found.module.surface.kind} export instead of refusing`)
  return found
}

/** One script, read straight from its body without a folder or a store. */
function surfaceOf(body: string) {
  return scanUserScript(body)
}

function callArgs(name: unknown, args: unknown[] = []): HostCall {
  return { runId: 'run-1', callId: 'call-1', method: 'user.script', args: [name, args] }
}

/** A call whose payload was built by hand, for the shapes a template can write but the VM should not send. */
function rawCall(args: unknown[]): HostCall {
  return { runId: 'run-1', callId: 'call-1', method: 'user.script', args }
}

describe('templater user scripts · naming', () => {
  it('takes the script name from the title’s `.js` suffix, case-insensitively on the extension', () => {
    expect(userScriptNameOf('my_script.js')).toBe('my_script')
    expect(userScriptNameOf('Daily Note.JS')).toBe('Daily Note')
    expect(userScriptNameOf('  padded.js  ')).toBe('padded')
  })

  it('refuses a title that is not a script, or whose stem could not be typed as a name', () => {
    expect(userScriptNameOf('note.md')).toBeNull()
    expect(userScriptNameOf('no-extension')).toBeNull()
    // `.js` alone has no name, and a name with a separator would claim a path it does not have.
    expect(userScriptNameOf('.js')).toBeNull()
    expect(userScriptNameOf('nested/name.js')).toBeNull()
  })

  it('reads a `user.script` host call as a name and an argument list, and refuses anything else', () => {
    const decoded = decodeUserScriptCall(callArgs('my_script', ['a', 1]))
    if (!decoded.ok) throw new Error('refused a well-formed call')
    expect(decoded.invocation).toEqual({ name: 'my_script', members: [], args: ['a', 1] })

    // The name arrives from a template: `tp.user[null]()` is a thing someone can write.
    expect(decodeUserScriptCall(callArgs(null))).toMatchObject({ ok: false, code: 'not-supported', detail: 'user.script:name' })
    expect(decodeUserScriptCall(rawCall(['ok']))).toMatchObject({
      ok: false,
      code: 'not-supported',
      detail: 'user.script:arguments',
    })
    expect(decodeUserScriptCall(rawCall(['ok', 'not-an-array']))).toMatchObject({ ok: false, detail: 'user.script:arguments' })
  })
})

describe('templater user scripts · export surface read without executing', () => {
  it('reads a plain function export and its parameter names', () => {
    const surface = surfaceOf('module.exports = function (msg) { return `hi ${msg}` }')
    expect(surface.kind).toBe('function')
    expect(surface.params).toEqual(['msg'])
    expect(surface.members).toEqual([])
  })

  it('reads arrow, async, named and generator function exports', () => {
    expect(surfaceOf('module.exports = (a, b) => a + b').params).toEqual(['a', 'b'])
    expect(surfaceOf('module.exports = async function (name) { }').params).toEqual(['name'])
    expect(surfaceOf('module.exports = function greet(from, to) { }').params).toEqual(['from', 'to'])
    expect(surfaceOf('module.exports = function* (seed) { yield seed }').params).toEqual(['seed'])
    // A bare arrow parameter, which has no parentheses to read.
    expect(surfaceOf('module.exports = text => text.trim().length').params).toEqual(['text'])
  })

  it('reads default exports, which upstream prefers over `module.exports`', () => {
    expect(surfaceOf('exports.default = function (x) { }').kind).toBe('function')
    expect(surfaceOf('module.exports.default = (x, y) => x + y').params).toEqual(['x', 'y'])
  })

  it('reads an object export written every way upstream documents', () => {
    const surface = surfaceOf(`module.exports = {
  note: (text) => text,
  tip: function (text, kind) { return text + kind },
  warning(text, extra = 'x') { return text },
  plain: helper,
  'quoted key': (v) => v,
};
const helper = (a, ...rest) => a + rest.length`)
    expect(surface.kind).toBe('object')
    expect(surface.members.map((one) => one.name)).toEqual(['note', 'tip', 'warning', 'plain', 'quoted key'])
    expect(surface.members.map((one) => one.params)).toEqual([['text'], ['text', 'kind'], ['text', 'extra'], ['a', 'rest'], ['v']])
    expect(surface.members.every((one) => one.callable)).toBe(true)
    expect(surface.membersComplete).toBe(true)
  })

  it('reads repeated `exports.<name>` writes as the object they build', () => {
    const surface = surfaceOf(`exports.one = (a) => a;
exports.two = function (b, c) { };`)
    expect(surface.kind).toBe('object')
    expect(surface.members.map((one) => one.name)).toEqual(['one', 'two'])
    expect(surface.members[1]!.params).toEqual(['b', 'c'])
  })

  it('reads `module.exports.<name>` writes the same way, because they land on the same object', () => {
    const surface = surfaceOf('module.exports.one = (a) => a;\nmodule.exports.two = (b) => b;')
    expect(surface.kind).toBe('object')
    expect(surface.members.map((one) => one.name)).toEqual(['one', 'two'])
  })

  it('ignores a bare `exports = …`, which rebinds the wrapper’s parameter instead of exporting', () => {
    // Upstream keeps reading the object it was handed, so anything else here would be a name invented.
    expect(surfaceOf('exports = function (x) { return x }').kind).toBe('none')
  })

  it('reads upstream’s own callout example as a documented object of arrows', () => {
    // `docs/src/user-functions/script-user-functions.md`, verbatim.
    const surface = surfaceOf(`function formatAsCallout(text, type = "note") {
  const blockQuoteLines = text.split("\\n").map((line) => \`> \${line}\`);
  return \`> [!\${type}]\\n\${blockQuoteLines.join("\\n")}\`;
}

module.exports = {
  note: (text) => formatAsCallout(text, "note"),
  tip: (text) => formatAsCallout(text, "tip"),
  warning: (text) => formatAsCallout(text, "warning"),
};`)
    expect(surface.kind).toBe('object')
    expect(surface.members.map((one) => one.name)).toEqual(['note', 'tip', 'warning'])
    expect(surface.members.every((one) => one.callable && one.params.length === 1)).toBe(true)
    expect(surface.membersComplete).toBe(true)
  })

  it('follows upstream’s precedence: default beats module.exports, module.exports beats member writes', () => {
    // `UserScriptFunctions.ts:120` reads `exp["default"] ?? mod.exports`.
    expect(surfaceOf('exports.default = (x) => x; module.exports = { a: (y) => y };').kind).toBe('function')
    const replaced = surfaceOf('exports.a = (x) => x; module.exports = { b: (y) => y };')
    expect(replaced.members.map((one) => one.name)).toEqual(['b'])
    expect(surfaceOf('exports.only = (x) => x;').members.map((one) => one.name)).toEqual(['only'])
  })

  it('resolves an identifier export against the declaration it names', () => {
    // The exact shape `docs/src/user-functions/script-user-functions.md` teaches.
    const surface = surfaceOf(`/**
 * This does something cool
 * @param first the thing
 * @returns a number
 */
function doSomething(first, second) { return first + second }
module.exports = doSomething;`)
    expect(surface.kind).toBe('function')
    expect(surface.params).toEqual(['first', 'second'])
    expect(surface.docs.summary).toBe('This does something cool')
    expect(surface.docs.returns).toBe('a number')
    // Only what the block documents is published as documentation — upstream's
    // `get_argument_documentation(doc.arguments)` keys the same list off the `@param` tags it found, so
    // `second`, which has no tag, is in the signature and not in the descriptions.
    expect(surface.docs.params).toEqual([{ name: 'first', description: 'the thing' }])
  })

  it('refuses to say anything about an export whose value it cannot read', () => {
    // A re-export through `require` is a real file upstream resolves at load; there is no value to describe.
    expect(surfaceOf("module.exports = require('./other.js')").kind).toBe('none')
    expect(surfaceOf('module.exports = build()').kind).toBe('none')
    expect(surfaceOf('const value = 1; module.exports = value').kind).toBe('none')
  })

  it('sees a class export but refuses to call it', () => {
    // Upstream registers it because `typeof class === 'function'`, and the template then meets a constructor
    // error. Here the file is refused at load, naming the script instead.
    expect(surfaceOf('module.exports = class Helper { run() { } }').kind).toBe('class')
    const provider = providerFor([script('helpers', 'module.exports = class Helper { run() { } }')])
    return expect(refused(provider, 'helpers')).resolves.toMatchObject({ code: 'not-supported', detail: 'helpers:class-export' })
  })

  it('refuses a file with no export at all, which is upstream’s “No exports detected.”', () => {
    expect(surfaceOf('function helper(a) { return a }').kind).toBe('none')
    expect(surfaceOf('const x = 1').kind).toBe('none')
  })

  it('does not read an export out of a comment or a string', () => {
    expect(surfaceOf('// module.exports = { fake: (a) => a }').kind).toBe('none')
    expect(surfaceOf('/* module.exports = function (a) {} */').kind).toBe('none')
    expect(surfaceOf('const sample = "module.exports = { fake: 1 }";').kind).toBe('none')
    expect(surfaceOf('const compare = 1; module.exports = compare === 1 ? noop : noop;').kind).toBe('none')
  })

  it('keeps template literals, including a literal nested inside an interpolation, out of the surface', () => {
    const surface = surfaceOf(`const wrap = (lines) => lines.map((line) => \`> \${line}\`).join('\\n');
module.exports = { wrap, plain: (x) => x };`)
    expect(surface.members.map((one) => one.name)).toEqual(['wrap', 'plain'])
    expect(surface.membersComplete).toBe(true)
    // The apostrophe inside a template body must not be read as a quote that ends a string.
    expect(surfaceOf("const warn = () => `don't do that`; module.exports = { warn };").members.map((one) => one.name)).toEqual(['warn'])
  })
})

describe('templater user scripts · signatures from JSDoc', () => {
  it('uses the documented names when the written parameter is destructured', () => {
    const surface = surfaceOf(`/**
 * Format a row.
 * @param row the cell values
 * @param width total width
 */
module.exports = function ({ cells, gap }, width) { return cells.join(gap) };`)
    expect(surface.params).toEqual(['row', 'width'])
    expect(surface.docs.params[0]!.description).toBe('the cell values')
  })

  it('accepts the `{type}` and `[optional]` forms TSDoc allows', () => {
    const surface = surfaceOf('/** @param {string} name the file @param {number} [count] times */\nmodule.exports = function (name, count) { };')
    expect(surface.params).toEqual(['name', 'count'])
    expect(surface.docs.params.map((one) => one.name)).toEqual(['name', 'count'])
  })

  it('publishes nothing for a parameter list it could not read, instead of guessing a name', () => {
    const undocumented = surfaceOf('module.exports = function ({ a, b }) { return a + b };')
    expect(undocumented.params).toEqual([])
    expect(undocumented.membersComplete).toBe(true)
    // An explicitly empty list stays empty: a comment that documents arguments the script ignores would
    // otherwise tell a template to pass them.
    expect(surfaceOf('/** @param ignored nothing */\nmodule.exports = function () { return 1 };').params).toEqual([])
  })

  it('attaches a block only to the thing written directly under it', () => {
    const surface = surfaceOf(`/** the one that counts */
module.exports = { one: (a) => a };`)
    expect(surface.docs.summary).toBe('the one that counts')
    const far = surfaceOf(`/** a stray comment about dates */

const VERSION = '2026-01-01';
module.exports = function (x) { return x };`)
    expect(far.docs.summary).toBe('')
  })
})

describe('templater user scripts · scanner limits', () => {
  it('drops a name written on the same line as a regular expression it read as division', () => {
    // A `/` after `)` is division to any scanner without a parse. A regex literal written there — legal, if
    // unusual — is therefore not blanked, and the quote inside it blanks the rest of the line. Upstream's
    // `acorn` pass (`TpDocumentation.ts:302`) gets this right; this fails closed: the export is missing and
    // the script is refused, rather than a half-read surface being offered to a template.
    const lost = surfaceOf('function pick(n) { if (n) /["\']/.test(n); } module.exports = { label: () => "x" };')
    expect(lost.kind).toBe('none')
    // The same script with the export on its own line is read normally, which is the shape a reader writes.
    const kept = surfaceOf('function pick(n) { if (n) /["\']/.test(n); }\nmodule.exports = { label: () => "x" };')
    expect(kept.members.map((one) => one.name)).toEqual(['label'])
  })

  it('marks a member list incomplete on a spread or a computed key and never invents the names behind it', () => {
    const spread = surfaceOf('const shared = { hidden: (a) => a };\nmodule.exports = { ...shared, shown: (b) => b };')
    expect(spread.members.map((one) => one.name)).toEqual(['shown'])
    expect(spread.membersComplete).toBe(false)

    const computed = surfaceOf('const key = "dynamic";\nmodule.exports = { [key]: (a) => a };')
    expect(computed.members).toEqual([])
    expect(computed.membersComplete).toBe(false)
  })

  it('reports a getter as unreadable rather than as a function it cannot see the result of', () => {
    // Upstream evaluates the getter at load and registers whatever came back.
    const surface = surfaceOf('module.exports = { get one() { return (a) => a }, two: (b) => b };')
    expect(surface.members.map((one) => one.name)).toEqual(['two'])
    expect(surface.membersComplete).toBe(false)
  })

  it('treats a value it cannot see as a function as not callable', () => {
    const surface = surfaceOf('module.exports = { label: "a string", count: 1 + 2 / 1 };')
    expect(surface.members.map((one) => [one.name, one.callable])).toEqual([
      ['label', false],
      ['count', false],
    ])
  })

  it('describes a file with a syntax error, because nothing here parses JavaScript', () => {
    // Upstream's `broken.js` e2e case fails when the browser parses the blob script. This module has no
    // parser and does not want one: the export statement is real text and is reported as a function. The
    // interpreter that eventually evaluates the body is what turns `return ;;)` into `script-load-failed`,
    // so this is a limit of *where* the error is found, not a pass: the run still fails, one call at a time.
    const surface = surfaceOf('module.exports = function () {\n    return ;;)\n}')
    expect(surface.kind).toBe('function')
  })
})

describe('templater user scripts · require allowlist', () => {
  it('allows the two names the interpreter actually has', () => {
    expect(surfaceOf("require('moment'); require('obsidian');\nmodule.exports = (x) => x").requires).toEqual(['moment', 'obsidian'])
  })

  it('records every specifier the body mentions, in source order and once each', () => {
    const surface = surfaceOf(`const m = require('moment');
const again = require("moment");
const o = require('obsidian');
module.exports = () => [m, again, o]`)
    expect(surface.requires).toEqual(['moment', 'obsidian'])
  })

  it('does not read a require out of a comment or a string', () => {
    expect(surfaceOf("// require('fs')\nmodule.exports = () => 1").requires).toEqual([])
    expect(surfaceOf("const text = \"require('fs')\";\nmodule.exports = () => text").requires).toEqual([])
  })

  it('names a require it cannot resolve as dynamic, so the only possible answer is refusal', () => {
    expect(surfaceOf('const name = "moment";\nconst m = require(name);\nmodule.exports = () => m').requires).toEqual(['dynamic'])
  })

  it('refuses a Node built-in or an unknown package, and says which', async () => {
    const provider = providerFor([
      script('uses_fs', "const fs = require('fs');\nmodule.exports = () => fs"),
      script('uses_lodash', "const _ = require('lodash');\nmodule.exports = () => _"),
      script('uses_node_prefix', "const p = require('node:path');\nmodule.exports = () => p"),
      script('uses_dynamic', 'const name = "fs";\nconst x = require(name);\nmodule.exports = () => x'),
    ])
    expect(await refused(provider, 'uses_fs')).toMatchObject({ code: 'script-require-denied', detail: 'uses_fs:fs' })
    expect(await refused(provider, 'uses_lodash')).toMatchObject({ code: 'script-require-denied', detail: 'uses_lodash:lodash' })
    expect(await refused(provider, 'uses_node_prefix')).toMatchObject({ code: 'script-require-denied', detail: 'uses_node_prefix:node:path' })
    expect(await refused(provider, 'uses_dynamic')).toMatchObject({ code: 'script-require-denied', detail: 'uses_dynamic:dynamic' })
  })

  it('allows a sibling script inside the folder and refuses one that is not there', async () => {
    const port = fakePort([
      script('helper', 'module.exports = (x) => x'),
      script('uses_sibling', "const h = require('./helper.js');\nmodule.exports = (y) => h(y)"),
      script('uses_without_extension', "const h = require('./helper');\nmodule.exports = (y) => h(y)"),
      script('uses_missing', "const h = require('./nope.js');\nmodule.exports = () => h"),
      script('uses_parent', "const h = require('../helper.js');\nmodule.exports = () => h"),
      script('uses_outside', "const h = require('../notes/secret.js');\nmodule.exports = () => h"),
    ])
    const provider = createUserScriptProvider(port.port)
    expect((await described(provider, 'uses_sibling')).ok).toBe(true)
    expect((await described(provider, 'uses_without_extension')).ok).toBe(true)
    expect(await refused(provider, 'uses_missing')).toMatchObject({ code: 'script-require-denied', detail: 'uses_missing:./nope.js' })
    expect(await refused(provider, 'uses_parent')).toMatchObject({ code: 'script-require-denied', detail: 'uses_parent:../helper.js' })
    expect(await refused(provider, 'uses_outside')).toMatchObject({ code: 'script-require-denied', detail: 'uses_outside:../notes/secret.js' })
  })

  it('resolves a sibling relative to the script that required it, not to the folder root', async () => {
    const port = fakePort([
      script('nested', 'module.exports = (x) => x', { title: 'nested.js', path: 'Scripts/lib/nested.js' }),
      script('uses_nested', "const n = require('./lib/nested.js');\nmodule.exports = () => n"),
      script('uses_nested_wrongly', "const n = require('./nested.js');\nmodule.exports = () => n"),
    ])
    const provider = createUserScriptProvider(port.port)
    expect((await described(provider, 'uses_nested')).ok).toBe(true)
    expect(await refused(provider, 'uses_nested_wrongly')).toMatchObject({ detail: 'uses_nested_wrongly:./nested.js' })
  })
})

describe('templater user scripts · one call, one script', () => {
  it('finds a script by name and carries its untouched text into the plan', async () => {
    const body = '/** greet someone */\nmodule.exports = function (name) { return "Hello " + name }'
    const provider = providerFor([script('greeting', body)])
    const prepared = await provider.prepare({ name: 'greeting', members: [], args: ['John'] })
    if (!prepared.ok) throw new Error(`refused: ${prepared.code} ${prepared.detail}`)
    expect(prepared.plan.module.source).toBe(body)
    expect(prepared.plan.module.path).toBe('Scripts/greeting.js')
    expect(prepared.plan.args).toEqual(['John'])
    expect(prepared.plan.params).toEqual(['name'])
    expect(prepared.plan.members).toEqual([])
  })

  it('reports an unknown name as a load failure that names it', async () => {
    const provider = providerFor([script('greeting', 'module.exports = () => 1')])
    expect(await refused(provider, 'nope')).toMatchObject({ code: 'script-load-failed', detail: 'nope:not-found' })
  })

  it('treats two notes claiming one name as an error listing both paths, and reads neither', async () => {
    const port = fakePort([
      script('dupe', 'module.exports = () => 1', { id: 'a', path: 'Scripts/dupe.js' }),
      script('dupe', 'module.exports = () => 2', { id: 'b', path: 'Scripts/old/dupe.js' }),
    ])
    const provider = createUserScriptProvider(port.port)
    expect(await refused(provider, 'dupe')).toMatchObject({
      code: 'script-load-failed',
      detail: 'dupe:conflict:Scripts/dupe.js,Scripts/old/dupe.js',
    })
    // The collision is decided from the listing alone; a duplicate pair is never read off the store.
    expect(port.reads()).toEqual({})
  })

  it('ignores the same note listed twice instead of calling it a conflict', async () => {
    const port = fakePort([script('same', 'module.exports = () => 1'), script('same', 'module.exports = () => 1')])
    const provider = createUserScriptProvider(port.port)
    expect((await described(provider, 'same')).ok).toBe(true)
  })

  it('turns a store rejection into one call’s failure, with the path and a logged cause', async () => {
    const warn = vi.spyOn(globalThis.console, 'warn').mockImplementation(() => undefined)
    const provider = createUserScriptProvider({
      listScripts: async () => [{ id: 'gone', title: 'gone.js', path: 'Scripts/gone.js' }],
      readScript: async () => {
        throw new Error('network went away')
      },
    })
    expect(await refused(provider, 'gone')).toMatchObject({ code: 'script-load-failed', detail: 'Scripts/gone.js' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('network went away'))
    warn.mockRestore()
  })

  it('reports a file with no readable export as unreadable, not as an empty namespace', async () => {
    const provider = providerFor([script('nothing', 'const helper = (a) => a')])
    expect(await refused(provider, 'nothing')).toMatchObject({ code: 'script-load-failed', detail: 'nothing:no-export' })
  })

  it('refuses a direct call to an object export and a member of a function export', async () => {
    const provider = providerFor([
      script('as_object', 'module.exports = { one: () => 1 }'),
      script('as_function', 'module.exports = () => 1'),
    ])
    expect(await provider.prepare({ name: 'as_object', members: [], args: [] })).toMatchObject({
      code: 'not-supported',
      detail: 'as_object:object-export',
    })
    expect(await provider.prepare({ name: 'as_function', members: ['one'], args: [] })).toMatchObject({
      code: 'not-supported',
      detail: 'as_function:function-export',
    })
  })

  it('refuses a member the script does not export, or one that is not a function, by its dotted name', async () => {
    const provider = providerFor([script('callouts', 'module.exports = { note: (t) => t, footer: "a string" }')])
    expect(await provider.prepare({ name: 'callouts', members: ['tip'], args: [] })).toMatchObject({
      code: 'not-supported',
      detail: 'callouts.tip',
    })
    expect(await provider.prepare({ name: 'callouts', members: ['footer'], args: [] })).toMatchObject({
      code: 'not-supported',
      detail: 'callouts.footer:not-a-function',
    })
    // Upstream's object exports are one level deep: every value must be a function.
    expect(await provider.prepare({ name: 'callouts', members: ['note', 'more'], args: [] })).toMatchObject({
      code: 'not-supported',
      detail: 'callouts.note.more',
    })
    const good = await provider.prepare({ name: 'callouts', members: ['note'], args: ['text'] })
    if (!good.ok) throw new Error('refused a member call the script does support')
    expect(good.plan.params).toEqual(['t'])
  })

  it('keeps a prototype name from reaching the object prototype', async () => {
    const provider = providerFor([script('greeting', 'module.exports = () => 1')])
    expect(await refused(provider, '__proto__')).toMatchObject({ code: 'script-load-failed', detail: '__proto__:not-found' })
    expect(await refused(provider, 'constructor')).toMatchObject({ code: 'script-load-failed', detail: 'constructor:not-found' })
  })
})

describe('templater user scripts · reading each script once per run', () => {
  it('lists the folder once and reads one script at most once, however many calls name it', async () => {
    const port = fakePort([script('greeting', 'module.exports = (name) => name'), script('other', 'module.exports = () => 1')])
    const provider = createUserScriptProvider(port.port)
    await provider.prepare({ name: 'greeting', members: [], args: ['a'] })
    await provider.prepare({ name: 'greeting', members: [], args: ['b'] })
    await provider.describe('greeting')

    expect(port.listings()).toBe(1)
    expect(port.reads()).toEqual({ greeting: 1 })
  })

  it('reads only the script a call named, and not the one it did not', async () => {
    const port = fakePort([script('greeting', 'module.exports = (name) => name'), script('never_used', 'module.exports = () => 1')])
    const provider = createUserScriptProvider(port.port)
    await provider.prepare({ name: 'greeting', members: [], args: [] })
    // A folder of ten scripts costs one read, which is what keeps a broken or huge file from being every
    // template's problem the way upstream's load-everything loop makes it.
    expect(port.reads()).toEqual({ greeting: 1 })
    expect(port.reads().never_used).toBeUndefined()
  })

  it('shares one read between two calls made at the same time', async () => {
    const port = fakePort([script('greeting', 'module.exports = (name) => name')])
    const provider = createUserScriptProvider(port.port)
    const both = await Promise.all([
      provider.prepare({ name: 'greeting', members: [], args: ['a'] }),
      provider.prepare({ name: 'greeting', members: [], args: ['b'] }),
    ])
    expect(both.every((one) => one.ok)).toBe(true)
    expect(port.reads()).toEqual({ greeting: 1 })
  })

  it('keeps one broken script broken for its own calls only, and does not cache a failed listing', async () => {
    let listings = 0
    const records: UserScriptRecord[] = [
      { id: 'broken', title: 'broken.js', path: 'Scripts/broken.js' },
      { id: 'fine', title: 'fine.js', path: 'Scripts/fine.js' },
    ]
    const provider = createUserScriptProvider({
      listScripts: async () => {
        listings += 1
        if (listings === 1) throw new Error('the folder was not there')
        return records
      },
      readScript: async (id: string) => (id === 'broken' ? 'module.exports = (' : 'module.exports = () => 1'),
    })
    const warn = vi.spyOn(globalThis.console, 'warn').mockImplementation(() => undefined)

    // The listing failed, so nothing is known yet: this call is told the script could not be read.
    expect(await refused(provider, 'fine')).toMatchObject({ code: 'script-load-failed', detail: 'fine:not-found' })
    expect(listings).toBe(1)
    warn.mockRestore()

    // A second call gets a second chance at the listing, and the good script renders. The bad one still fails,
    // and only for the template that named it.
    expect((await described(provider, 'fine')).ok).toBe(true)
    expect(await refused(provider, 'broken')).toMatchObject({ code: 'script-load-failed', detail: 'broken:no-export' })
  })
  it('refuses every relative require that does not land on a script in the listing', async () => {
    // Planted to prove the guard fires. The rule is a lookup, not a prefix check: whatever a specifier
    // resolves to has to be one of the notes the page listed, which is the folder the reader picked. A path
    // that climbs out therefore has nothing to match, and a path that climbs out *and back in* can only name
    // another script in that same folder — see `resolveRelativePath` for why that is not an escape.
    const port = fakePort([
      script('helper', 'module.exports = (x) => x', { path: 'Scripts/lib/helper.js' }),
      script('escapes_sibling', "const h = require('../lib/helper.js');\nmodule.exports = () => h"),
      script('escapes_outside', "const h = require('../../notes/secret.js');\nmodule.exports = () => h"),
      script('escapes_roundtrip', "const h = require('../../Scripts/lib/helper.js');\nmodule.exports = () => h"),
      script('escapes_absolute', "const h = require('/Scripts/lib/helper.js');\nmodule.exports = () => h"),
      script('escapes_bare', "const h = require('lib/helper.js');\nmodule.exports = () => h"),
      script('escapes_parent_of_root', "const h = require('../../../Scripts/lib/helper.js');\nmodule.exports = () => h"),
    ])
    const provider = createUserScriptProvider(port.port)
    // `Scripts/escapes_sibling.js` reaching `../lib/helper.js` leaves the folder: nothing there is listed.
    expect(await refused(provider, 'escapes_sibling')).toMatchObject({ code: 'script-require-denied', detail: 'escapes_sibling:../lib/helper.js' })
    expect(await refused(provider, 'escapes_outside')).toMatchObject({ code: 'script-require-denied' })
    // An absolute-looking or bare specifier is not a sibling at all, so the allowlist is the only door.
    expect(await refused(provider, 'escapes_absolute')).toMatchObject({ code: 'script-require-denied', detail: 'escapes_absolute:/Scripts/lib/helper.js' })
    expect(await refused(provider, 'escapes_bare')).toMatchObject({ code: 'script-require-denied', detail: 'escapes_bare:lib/helper.js' })
    // These two walk out of `Scripts/` and back into it, which lands on the listed helper: allowed, and still
    // no further than the folder the reader chose.
    expect((await described(provider, 'escapes_roundtrip')).ok).toBe(true)
    expect((await described(provider, 'escapes_parent_of_root')).ok).toBe(true)
  })

  it('reads a backslash-spelled sibling specifier as the same path a reader would mean', async () => {
    // The path a Windows-shaped note title or a copied script produces; `normalizeVirtualPath` folds it, and
    // the lookup still has to land on a listed script.
    const port = fakePort([
      script('helper', 'module.exports = (x) => x', { path: 'Scripts/lib/helper.js' }),
      script('uses_backslash', "const h = require('.\\\\lib\\\\helper.js');\nmodule.exports = () => h"),
      script('uses_backslash_outside', "const h = require('..\\\\..\\\\notes\\\\secret.js');\nmodule.exports = () => h"),
    ])
    const provider = createUserScriptProvider(port.port)
    expect((await described(provider, 'uses_backslash')).ok).toBe(true)
    expect(await refused(provider, 'uses_backslash_outside')).toMatchObject({ code: 'script-require-denied' })
  })

  it('refuses a template name that only differs by case or by the missing extension', async () => {
    // Upstream matches `file.basename` exactly, and a case-folded second chance would let one template name a
    // different file than the reader wrote.
    const provider = providerFor([script('Greeting', 'module.exports = () => 1')])
    expect(await refused(provider, 'greeting')).toMatchObject({ code: 'script-load-failed', detail: 'greeting:not-found' })
    expect(await refused(provider, 'Greeting.js')).toMatchObject({ code: 'script-load-failed', detail: 'Greeting.js:not-found' })
    expect((await described(provider, 'Greeting')).ok).toBe(true)
  })
})

describe('templater user scripts · the body is never executed here', () => {
  it('describes a script whose export statement would run code, without running any of it', async () => {
    // Nothing on the page may evaluate template or script text: no `new Function`, no `eval`, no blob script
    // tag the way `UserScriptFunctions.ts:19` does. A side effect in the body is the test for that — if this
    // module evaluated the text, the assignment below would happen and the counter would move.
    const touched = globalThis as unknown as Record<string, unknown>
    delete touched.__inkstone_user_script_probe
    const body = `globalThis.__inkstone_user_script_probe = "executed";
module.exports = function () { return "never called" };`
    const provider = providerFor([script('with_side_effect', body)])

    const found = await described(provider, 'with_side_effect')
    if (!found.ok) throw new Error(`refused: ${found.code} ${found.detail}`)
    expect(touched.__inkstone_user_script_probe).toBeUndefined()
    expect(found.module.surface.params).toEqual([])

    const result = await answerUserScriptCall(callArgs('with_side_effect'), provider)
    expect(result.ok).toBe(false)
    expect(touched.__inkstone_user_script_probe).toBeUndefined()
    delete touched.__inkstone_user_script_probe
  })
})

describe('templater user scripts · answering the host call', () => {
  it('answers a refused call as that call’s failure, with its ids and code', async () => {
    const provider = providerFor([script('greeting', "require('fs');\nmodule.exports = () => 1")])
    const result = await answerUserScriptCall(callArgs('greeting'), provider)
    expect(result).toEqual({
      runId: 'run-1',
      callId: 'call-1',
      ok: false,
      code: 'script-require-denied',
      detail: 'greeting:fs',
    })
  })

  it('answers a clean call with the refusal the wire currently forces, naming the script', async () => {
    // Until `user.script` is answered inside the worker, nothing can run the body — see this module's header.
    const provider = providerFor([script('greeting', 'module.exports = (name) => name')])
    const result = await answerUserScriptCall(callArgs('greeting', ['John']), provider)
    expect(result).toEqual({
      runId: 'run-1',
      callId: 'call-1',
      ok: false,
      code: 'not-supported',
      detail: 'greeting:user-script-execution',
    })
  })

  it('never leaves a call unanswered', async () => {
    const provider = providerFor([script('greeting', 'module.exports = (name) => name')])
    const results = await Promise.all([
      answerUserScriptCall(callArgs('greeting'), provider),
      answerUserScriptCall(callArgs('missing'), provider),
      answerUserScriptCall(callArgs(42), provider),
    ])
    expect(results.every((one) => one.ok === false && one.code !== '' )).toBe(true)
  })
})
