import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

/**
 * Chinese first-letter search lives in a chunk that arrives after boot, so a listing that memoises on
 * the query alone can freeze on the answer computed before the dictionary landed and stay wrong until
 * the reader types another character.
 *
 * Every such listing has to subscribe with `usePinyinVersion()` and list it in that memo's
 * dependencies. A render test cannot see this — by then the dictionary is always loaded — so the gate
 * reads the source instead: a memo that calls the fuzzy matcher, or calls any helper that reaches it,
 * must name `pinyinVersion` in its dependency array.
 */

const CLIENT_ROOT = resolve(process.cwd(), 'src/client')

/** `file#name` keys for the functions a reader can already tell are reading-dependent. */
const SEEDS = [
  'lib/fuzzy.ts#fuzzyMatch',
  'lib/fuzzy.ts#fuzzyFilter',
  'lib/fuzzy.ts#matchesQuery',
  'lib/pinyin.ts#pinyinKeysOf',
]

interface Module {
  path: string
  text: string
  /** Local name -> the `file#exportedName` pair it was imported or re-exported from. */
  imports: Map<string, string>
  /** Files this one re-exports wholesale, so a name imported here may live over there. */
  stars: string[]
  /** Top-level name -> the source text of its declaration. */
  decls: Map<string, string>
  memos: Array<{ body: string; deps: string; line: number }>
}

const knownFiles = new Set<string>()

function moduleTarget(fromPath: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const base = relative(CLIENT_ROOT, resolve(dirname(join(CLIENT_ROOT, fromPath)), specifier)).replace(/\\/g, '/')
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (knownFiles.has(candidate)) return candidate
  }
  return null
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

function load(): Module[] {
  const parsed: Array<{ module: Module; source: ts.SourceFile }> = []

  for (const path of sourceFiles(CLIENT_ROOT)) {
    const rel = relative(CLIENT_ROOT, path).replace(/\\/g, '/')
    knownFiles.add(rel)
    const text = readFileSync(path, 'utf8')
    parsed.push({
      module: { path: rel, text, imports: new Map(), stars: [], decls: new Map(), memos: [] },
      source: ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
    })
  }

  for (const { module, source } of parsed) {
    const named = (specifier: string, elements: readonly ts.ExportSpecifier[] | readonly ts.ImportSpecifier[]) => {
      const target = moduleTarget(module.path, specifier)
      if (!target) return
      for (const spec of elements) module.imports.set(spec.name.text, `${target}#${(spec.propertyName ?? spec.name).text}`)
    }

    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const clause = statement.importClause
        if (!clause) continue
        const target = moduleTarget(module.path, statement.moduleSpecifier.text)
        if (target && clause.name) module.imports.set(clause.name.text, `${target}#${clause.name.text}`)
        const bindings = clause.namedBindings
        if (bindings && ts.isNamedImports(bindings)) named(statement.moduleSpecifier.text, bindings.elements)
      }
      if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const specifier = statement.moduleSpecifier.text
        const target = moduleTarget(module.path, specifier)
        if (!target) continue
        if (statement.exportClause) named(specifier, statement.exportClause.elements)
        else module.stars.push(target)
      }
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        module.decls.set(statement.name.text, statement.getText(source))
      }
      if (ts.isClassDeclaration(statement) && statement.name) {
        module.decls.set(statement.name.text, statement.getText(source))
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer) {
            module.decls.set(declaration.name.text, declaration.getText(source))
          }
        }
      }
    }

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useMemo') {
        const factory = node.arguments[0]
        const deps = node.arguments[1]
        if (factory && deps && ts.isArrayLiteralExpression(deps)) {
          module.memos.push({
            body: factory.getText(source),
            deps: deps.getText(source),
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          })
        }
      }
      node.forEachChild(visit)
    }
    visit(source)
  }

  return parsed.map((entry) => entry.module)
}

/** Identifier immediately followed by `(`, anywhere in a snippet of source. */
function callsIn(text: string): string[] {
  return [...text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]!)
}

const modules = load()
const byPath = new Map(modules.map((module) => [module.path, module]))

/** Every `file#name` this call could be, following re-export barrels as far as they lead. */
function candidatesFor(module: Module, name: string, depth = 0): string[] {
  const imported = module.imports.get(name)
  if (imported) {
    const [file, exported] = imported.split('#')
    const owner = byPath.get(file!)
    if (owner?.stars.length && depth < 3) {
      return [imported, ...owner.stars.flatMap((star) => candidatesFor(byPath.get(star)!, exported!, depth + 1))]
    }
    return [imported]
  }
  return module.decls.has(name) ? [`${module.path}#${name}`] : []
}

/** `(file, name)` pairs whose call may consult the reading table, grown until it stops growing. */
const reading = new Set(SEEDS)
for (;;) {
  const before = reading.size
  for (const module of modules) {
    for (const [name, text] of module.decls) {
      const key = `${module.path}#${name}`
      if (reading.has(key)) continue
      if (callsIn(text).some((call) => candidatesFor(module, call).some((candidate) => reading.has(candidate)))) {
        reading.add(key)
      }
    }
  }
  if (reading.size === before) break
}

describe('pinyin search stays live', () => {
  it('tracks the matcher family it is guarding', () => {
    for (const seed of SEEDS) expect(reading, seed).toContain(seed)
    expect(reading.has('features/preview/outline-tree.ts#compileFilter')).toBe(true)
    expect(reading.has('lib/markdown/kanban/filter-sort.ts#itemMatchesQuery')).toBe(true)
  })

  it('memoises no reading-dependent listing without the dictionary version in its deps', () => {
    const stale: string[] = []

    for (const module of modules) {
      for (const memo of module.memos) {
        const calls = callsIn(memo.body)
        const guarded = calls.some((call) => candidatesFor(module, call).some((candidate) => reading.has(candidate)))
        if (!guarded || /\bpinyinVersion\b/.test(memo.deps)) continue
        stale.push(`${module.path}:${memo.line} deps ${memo.deps}`)
      }
    }

    expect(stale, `memoised listings that can freeze before the dictionary lands:\n${stale.join('\n')}`).toEqual([])
  })

  it('keeps raw substring filters out of the reading-dependent helpers', () => {
    const offenders: string[] = []
    for (const module of modules) {
      if (module.path === 'lib/fuzzy.ts') continue
      for (const [name, text] of module.decls) {
        if (!reading.has(`${module.path}#${name}`)) continue
        for (const match of text.matchAll(/\.toLowerCase\(\)\s*\.\s*includes\(/g)) {
          offenders.push(`${module.path}#${name}:${text.slice(0, match.index).split('\n').length}`)
        }
      }
    }
    expect(offenders, `filters that will not read Chinese initials:\n${offenders.join('\n')}`).toEqual([])
  })
})

/**
 * The two things that keep reading search cheap are invisible to a render test: the big listing has
 * to warm its own labels at idle, and nothing may download the dictionary before a session has shown
 * it needs one. Both live in source that a later edit can undo quietly, so they are checked here.
 */
function sourceOf(path: string): string {
  const module = byPath.get(path)
  if (!module) throw new Error(`no such module: ${path}`)
  return module.text
}

function bodyOf(text: string, anchor: string): string {
  const start = text.indexOf(anchor)
  if (start < 0) throw new Error(`anchor missing: ${anchor}`)
  const lines = text.slice(start).split('\n')
  for (let index = 1; index < lines.length; index++) {
    if (/^\s*[)}];/.test(lines[index]!)) return lines.slice(0, index + 1).join('\n')
  }
  return lines.join('\n')
}

describe('the reading search stays cheap', () => {
  it('the note listing warms its own labels, and only once the dictionary is there', () => {
    const noteList = sourceOf('features/list/NoteList.tsx')
    expect(noteList).toMatch(/warmPinyinKeys\(/)
    expect(noteList).toMatch(/if \(!pinyinIsLoaded\(\)\)/)
  })

  it('boot asks for the dictionary only when a title has a reading left to find', () => {
    const shell = sourceOf('features/shell/AppShell.tsx')
    expect(shell).toMatch(/textNeedsReading\(/)
    expect(bodyOf(shell, 'const warm = () => {')).not.toMatch(/preloadPinyin/)
  })

  it('subscribing to the version downloads nothing', () => {
    const pinyin = sourceOf('lib/pinyin.ts')
    expect(bodyOf(pinyin, 'function subscribe(')).not.toMatch(/preloadPinyin\(\)/)
  })
})
