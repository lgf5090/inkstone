import { describe, expect, it } from 'vitest'
import { scanUserScript } from './user-script-scan'

/**
 * The scanner half of the user-script rules: what a script file is said to export, read off its text.
 *
 * A name is published only when the text says it, because the completion list and the reference panel show
 * these to the reader as facts about their own file, and a plausible guess is the failure that costs them a
 * note. The scanner is deliberately weaker than upstream's `acorn` parse (plan §D8: this app does not
 * depend on it), so some tests below exist to pin the weakness rather than the behaviour. Each one says which
 * way it fails, and every one of them fails *closed*: the name is missing and the call is refused, never
 * guessed.
 */

function surfaceOf(body: string) {
  return scanUserScript(body)
}

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

  it('sees a class export and says so, which is what the panels refuse to offer', () => {
    // Upstream registers a class because `typeof class === 'function'`, and the template then meets a
    // constructor error. The name is still the truth to report: `kind` is what a panel reads, and what the run
    // does with it is `./user-scripts.test.ts` and `../worker/vm.test.ts`'s question, not the scanner's.
    expect(surfaceOf('module.exports = class Helper { run() { } }').kind).toBe('class')
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
})
