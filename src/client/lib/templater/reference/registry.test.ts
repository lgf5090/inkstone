/**
 * The gate that keeps `./docs.ts` from drifting away from the two things it must never disagree with: the
 * locale catalogs (a description key that does not exist can only be shown as the key itself) and the
 * `tp` namespace the worker actually builds (`../../worker/bootstrap.ts`).
 *
 * The engine half is read off the file text rather than executed, because the namespace lives inside a JS
 * template literal that only exists once QuickJS has evaluated it — and the worker's own suite is the only
 * place that happens. A test that imported the prelude would be a page test reaching into worker code, so
 * this reads the source the way a reviewer would: the object literals the prelude builds `tp` out of, and
 * the names it puts in them.
 *
 * The text is read through `import.meta.glob(..., '?raw')`, the way `../context/snapshot.test.ts` reads
 * source for the same reason. A filesystem path cannot be resolved against `import.meta.url` here because
 * that is an `http://localhost` URL under this project's jsdom environment, and the client project compiles
 * without Node's types, so a `node:fs` import would not pass `npm run typecheck` either.
 */
import { describe, expect, it } from 'vitest'
import { EN_US_MESSAGES } from '@shared/locales/en-US'
import { ZH_CN_MESSAGES } from '@shared/locales/zh-CN'
import { CAPABILITY_PROFILES } from '../protocol'
import {
  REFERENCE_ENTRIES,
  REFERENCE_MODULES,
  findReferenceEntry,
  referenceEntriesForModule,
  referenceIsAvailable,
  referenceMemberPath,
  referenceModuleDoc,
  type ReferenceDocEntry,
} from './registry'

const en = EN_US_MESSAGES as unknown as Record<string, string>
const zh = ZH_CN_MESSAGES as unknown as Record<string, string>

const BOOTSTRAP_GLOB = '../worker/bootstrap.ts'

/**
 * The six modules whose member list upstream closed, and whose documented total the plan counts as the
 * 32 variables and functions (`reports/templater-port-plan.md`, appendix A). The other six are either
 * façades (`app`, `obsidian`), run-time namespaces (`user`, `frontmatter`), or names this build adds of its
 * own accord (`moment`, `base`).
 */
const CLOSED_MODULES = ['config', 'date', 'file', 'hooks', 'system', 'web']

interface Field {
  name: string
  value: string
}

describe('templater reference registry shape', () => {
  it('keeps module and member pairs unique', () => {
    const seen = new Set<string>()
    for (const entry of REFERENCE_ENTRIES) {
      const path = referenceMemberPath(entry)
      expect(seen.has(path), `duplicate registry entry ${path}`).toBe(false)
      seen.add(path)
    }
  })

  it('covers the 32 documented upstream variables and functions', () => {
    expect(REFERENCE_ENTRIES.filter((entry) => CLOSED_MODULES.includes(entry.module))).toHaveLength(32)
  })

  it('lists every module the entries belong to', () => {
    const modules = REFERENCE_MODULES.map((module) => module.module)
    expect(new Set(modules).size).toBe(modules.length)
    for (const entry of REFERENCE_ENTRIES) {
      expect(referenceModuleDoc(entry.module), `undocumented module tp.${entry.module}`).toBeDefined()
    }
  })

  it('gives every entry at least one example', () => {
    for (const entry of REFERENCE_ENTRIES) {
      expect(entry.examples.length, `${referenceMemberPath(entry)} has no example`).toBeGreaterThan(0)
      for (const example of entry.examples) expect(example.trim().length).toBeGreaterThan(0)
    }
  })

  it('names the member inside its own signature', () => {
    for (const entry of REFERENCE_ENTRIES) {
      expect(entry.signature, `${referenceMemberPath(entry)} signature omits its name`).toContain(entry.name)
    }
  })

  it('matches the argument list against the signature', () => {
    for (const entry of REFERENCE_ENTRIES) {
      // A placeholder member (`tp.user.<script_name>`) documents a call this build cannot enumerate, so its
      // signature has no parameter list to read.
      if (entry.dynamic === true) continue
      expect(
        signatureParameters(entry.signature),
        `${referenceMemberPath(entry)} argument names do not match its signature`,
      ).toEqual(entry.args.map((arg) => arg.name))
    }
  })

  it('marks only the run-time namespaces as dynamic', () => {
    for (const entry of REFERENCE_ENTRIES) {
      const placeholder = entry.signature.includes('<')
      // The flag is the engine gate's only exemption, so the two have to mean the same thing: a name in
      // angle brackets is a placeholder, and a placeholder is the only thing allowed to skip name matching.
      expect(Boolean(entry.dynamic), `${referenceMemberPath(entry)} dynamic flag does not match its signature`).toBe(placeholder)
      if (entry.dynamic === true) {
        expect(referenceModuleDoc(entry.module)?.dynamic, `${referenceMemberPath(entry)} is dynamic inside a closed module`).toBe(true)
      }
    }
  })

  it('requires only rights the capability contract actually has', () => {
    const rights = Object.keys(CAPABILITY_PROFILES.local)
    for (const entry of REFERENCE_ENTRIES) {
      for (const right of entry.requires ?? []) {
        expect(rights, `${referenceMemberPath(entry)} names an unknown capability`).toContain(right)
      }
    }
  })
})

describe('templater reference keys and the locale catalogs', () => {
  it('names every description, return and argument sentence in both catalogs', () => {
    const keys = new Set<string>()
    for (const module of REFERENCE_MODULES) keys.add(module.descriptionKey)
    for (const entry of REFERENCE_ENTRIES) {
      keys.add(entry.descriptionKey)
      if (entry.returnsKey !== undefined) keys.add(entry.returnsKey)
      for (const arg of entry.args) keys.add(arg.descriptionKey)
    }
    const missing: string[] = []
    for (const key of [...keys].sort()) {
      // A key outside this namespace would collide with another feature's copy, and would not be found by
      // whoever maintains the templater section of the catalogs.
      expect(key.startsWith('templater.ref.'), `${key} is outside the templater.ref namespace`).toBe(true)
      // Two members sharing one description sentence is how a rename ends up explained by the old wording.
      if (key.endsWith('.description')) {
        const owners = REFERENCE_ENTRIES.filter((entry) => entry.descriptionKey === key)
        expect(owners.length, `${key} describes ${owners.length} members`).toBeLessThanOrEqual(1)
      }
      if (typeof en[key] !== 'string' || en[key].length === 0) missing.push(`en-US ${key}`)
      if (typeof zh[key] !== 'string' || zh[key].length === 0) missing.push(`zh-CN ${key}`)
    }
    expect(missing, `reference keys with no catalog text:\n${missing.join('\n')}`).toEqual([])
  })
})

describe('templater reference registry against the engine prelude', () => {
  it('documents every member the prelude publishes', () => {
    const missing: string[] = []
    for (const [module, members] of publishedSurface()) {
      // A module the prelude leaves open-ended publishes no names to check: `tp.frontmatter` is filled from
      // the target note when a run installs, and `tp.user` answers whatever the template typed.
      for (const member of members) {
        if (findReferenceEntry(module, member) === undefined) missing.push(`tp.${module}.${member}`)
      }
    }
    expect(missing, `members the engine publishes but the reference does not document:\n${missing.join('\n')}`).toEqual([])
  })

  it('documents nothing the prelude does not publish', () => {
    const prelude = maskCode(preludeText())
    const surface = publishedSurface()
    for (const entry of REFERENCE_ENTRIES) {
      if (entry.dynamic === true) continue
      const members = surface.get(entry.module)
      expect(members, `tp.${entry.module} is not a module the prelude builds`).toBeDefined()
      if (members !== undefined && members.length > 0) {
        expect(members, `${referenceMemberPath(entry)} is not a member the prelude gives tp.${entry.module}`).toContain(entry.name)
        continue
      }
      // A leaf module (`tp.moment` is a function, not an object) has no member list to read, so the name
      // itself has to be what the prelude hands out.
      expect(prelude, `${referenceMemberPath(entry)} names something the prelude never builds`).toContain(entry.name)
    }
  })

  it('publishes exactly the modules the reference lists', () => {
    expect([...publishedSurface().keys()].sort()).toEqual(REFERENCE_MODULES.map((module) => module.module).sort())
  })

  it('reads a module list the engine still backs', () => {
    const surface = publishedSurface()
    // Both directions at once: the entry count and the member count have to be the same number, so an
    // entry added for a member the engine does not give cannot hide behind the other three gates.
    expect(referenceEntriesForModule('file')).toHaveLength((surface.get('file') ?? []).length)
    expect(referenceEntriesForModule('date')).toHaveLength((surface.get('date') ?? []).length)
  })
})

describe('templater reference lookup helpers', () => {
  it('answers the panel and the completion source from one table', () => {
    const rename = findReferenceEntry('file', 'rename')
    expect(rename?.signature).toContain('tp.file.rename')
    expect(referenceMemberPath(rename as ReferenceDocEntry)).toBe('tp.file.rename')
    expect(findReferenceEntry('file', 'not_a_member')).toBeUndefined()

    const suggester = findReferenceEntry('system', 'suggester')
    expect(suggester && referenceIsAvailable(suggester, CAPABILITY_PROFILES.community)).toBe(true)
    expect(suggester && referenceIsAvailable(suggester, CAPABILITY_PROFILES.startup)).toBe(false)
    const quote = findReferenceEntry('web', 'daily_quote')
    expect(quote && referenceIsAvailable(quote, CAPABILITY_PROFILES.local)).toBe(true)
    expect(quote && referenceIsAvailable(quote, CAPABILITY_PROFILES.community)).toBe(false)
  })
})

/**
 * The prelude's own text, without the surrounding TypeScript.
 *
 * `eager` because a gate that reads one file should not also have to await it, and the single entry is
 * taken by position with its count asserted, because a glob that quietly matched nothing would otherwise
 * read as a prelude that stopped declaring `PRELUDE`.
 */
function preludeText(): string {
  const sources = import.meta.glob('../worker/bootstrap.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
  const entries = Object.entries(sources).filter(([, text]) => typeof text === 'string')
  expect(entries, `${BOOTSTRAP_GLOB} was not read as source text`).toHaveLength(1)
  const file = entries[0]?.[1] ?? ''
  const start = file.indexOf('const PRELUDE = `')
  if (start < 0) throw new Error(`${BOOTSTRAP_GLOB} no longer declares a PRELUDE literal`)
  const open = start + 'const PRELUDE = `'.length
  const close = file.indexOf('\n})()`', open)
  if (close < 0) throw new Error(`${BOOTSTRAP_GLOB} PRELUDE literal does not end where this gate expects`)
  return file.slice(open, close)
}

/**
 * The modules the prelude builds, and the member names inside each one.
 *
 * Walked out of `const tp = {` rather than listed here, so the test follows the engine instead of restating
 * it: a module renamed in the prelude shows up as a mismatch, and one renamed here does not hide behind a
 * second copy of the list.
 */
function publishedSurface(): Map<string, string[]> {
  const prelude = maskCode(preludeText())
  const declaration = prelude.indexOf('const tp = {')
  if (declaration < 0) throw new Error('the prelude no longer builds a tp namespace')
  const surface = new Map<string, string[]>()
  for (const field of readObjectLiteral(prelude.slice(declaration + 'const tp = '.length))) {
    surface.set(field.name, membersOf(prelude, field.value, new Set()))
  }
  // `tp.obsidian`, `tp.app` and `tp.moment` are assigned after that literal, so their shape is not inside
  // it; reading the assignments keeps the façade members in the same comparison as everything else.
  for (const match of prelude.matchAll(/^ {2}tp\.(\w+) = ([\w$]+)\r?$/gm)) {
    surface.set(match[1] as string, membersOf(prelude, match[2] as string, new Set()))
  }
  return surface
}

/** Resolve one module value: an inline literal, a named object, a proxy over one, or a leaf. */
function membersOf(prelude: string, value: string, seen: Set<string>): string[] {
  if (value.startsWith('{')) return names(readObjectLiteral(value))
  if (!/^[\w$]+$/.test(value) || seen.has(value)) return []
  seen.add(value)
  const marker = `const ${value} = `
  const at = prelude.indexOf(marker)
  if (at < 0) return []
  const body = prelude.slice(at + marker.length)
  if (body.startsWith('{')) return names(readObjectLiteral(body))
  if (body.startsWith('new Proxy(')) {
    const open = body.indexOf('(')
    const argument = splitTopLevel(body.slice(open + 1, matchingClose(body, open)))[0] ?? ''
    return membersOf(prelude, argument.trim(), seen)
  }
  return []
}

function names(fields: Field[]): string[] {
  return fields.map((field) => field.name)
}

/**
 * The keys of an object literal, each with the text that gives it its value.
 *
 * Depth counts `{}()[]` together, because a member's value is usually an arrow function whose own body
 * holds braces: reading only what the braces suggest is what keeps `fileModule`'s sixteen members from
 * being mistaken for a folder of nested keys.
 */
function readObjectLiteral(text: string): Field[] {
  if (text[0] !== '{') return []
  const fields: Field[] = []
  let depth = 0
  let key: string | null = null
  let valueStart = 0
  let index = 0
  while (index < text.length) {
    const char = text[index] as string
    if (char === '{' || char === '(' || char === '[') {
      depth += 1
      index += 1
      continue
    }
    if (char === '}' || char === ')' || char === ']') {
      depth -= 1
      if (depth === 0) break
      index += 1
      continue
    }
    if (depth === 1 && char === ',') {
      if (key !== null) {
        fields.push({ name: key, value: text.slice(valueStart, index).trim() })
        key = null
      }
      index += 1
      continue
    }
    if (depth === 1 && key === null && /[A-Za-z_$]/.test(char)) {
      const token = readIdentifier(text, index)
      let next = token.index
      while (next < text.length && /\s/.test(text[next] as string)) next += 1
      if (text[next] === ':') {
        key = token.name
        valueStart = next + 1
        index = next + 1
        continue
      }
      // Shorthand (`config,`): the value the prelude keeps it under is its own name.
      if (text[next] === ',' || text[next] === '}') {
        fields.push({ name: token.name, value: token.name })
        index = next
        continue
      }
      index = token.index
      continue
    }
    index += 1
  }
  if (key !== null) fields.push({ name: key, value: text.slice(valueStart, index).trim() })
  return fields
}

/** The parameter names a signature declares, in order, ignoring commas nested inside a type. */
function signatureParameters(signature: string): string[] {
  const masked = maskCode(signature)
  const open = masked.indexOf('(')
  if (open < 0) return []
  const inner = masked.slice(open + 1, matchingClose(masked, open)).trim()
  if (inner.length === 0) return []
  return splitTopLevel(inner).map((parameter) => {
    const match = /^[\w$]+/.exec(parameter)
    return match === null ? parameter : match[0]
  })
}

/** Index of the bracket that closes the one at `open`. */
function matchingClose(masked: string, open: number): number {
  let depth = 0
  for (let index = open; index < masked.length; index += 1) {
    const char = masked[index] as string
    if (char === '(' || char === '{' || char === '[') depth += 1
    else if (char === ')' || char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  throw new Error(`unbalanced brackets in ${JSON.stringify(masked.slice(open, open + 40))}`)
}

/** Split on the commas at this bracket level, so a union type stays one parameter. */
function splitTopLevel(masked: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index] as string
    if (char === '(' || char === '{' || char === '[') depth += 1
    else if (char === ')' || char === '}' || char === ']') depth -= 1
    else if (char === ',' && depth === 0) {
      parts.push(masked.slice(start, index).trim())
      start = index + 1
    }
  }
  parts.push(masked.slice(start).trim())
  return parts.filter((part) => part.length > 0)
}

/**
 * A copy of `text` the same length, with comments and quoted runs blanked out.
 *
 * Every bracket walker here reads this. The prelude is one template literal, so its prose carries escaped
 * backticks and its strings carry `(` and `[` inside them; blanking both is what keeps an escaped backtick
 * from opening a string that never closes, and a comment's apostrophe from swallowing the rest of the file.
 * Length is preserved, so an offset here still names the same place in the original.
 */
function maskCode(text: string): string {
  const out = text.split('')
  const blank = (from: number, to: number) => {
    for (let index = from; index < to && index < out.length; index += 1) {
      if (out[index] !== '\n') out[index] = ' '
    }
  }
  let index = 0
  while (index < text.length) {
    const char = text[index] as string
    if (char === '\\') {
      blank(index, index + 2)
      index += 2
      continue
    }
    if (char === '/' && text[index + 1] === '/') {
      const end = text.indexOf('\n', index)
      const stop = end < 0 ? text.length : end
      blank(index, stop)
      index = stop
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      let scan = index + 1
      while (scan < text.length) {
        const inner = text[scan] as string
        if (inner === '\\') {
          scan += 2
          continue
        }
        if (inner === char) {
          scan += 1
          break
        }
        scan += 1
      }
      blank(index, scan)
      index = scan
      continue
    }
    index += 1
  }
  return out.join('')
}

function readIdentifier(text: string, from: number): { name: string; index: number } {
  let index = from
  while (index < text.length && /[\w$]/.test(text[index] as string)) index += 1
  return { name: text.slice(from, index), index }
}
