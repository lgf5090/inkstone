import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * A `memo` component keeps its whole subtree in the language it first rendered.
 *
 * `t()` reads the live locale, so a label only needs *a* re-render to change language — and `memo` is
 * precisely the thing that skips one: React bails out at the memo boundary, so the plain children below
 * it never run either. That made every board surface a stale translation waiting for a language switch
 * (K2-04f measured 12 of 16 probe cases red before anything was fixed), and the same defect has a second
 * shape: text read inside a `useMemo` factory is computed at data-change time and cached, which freezes
 * the language even in a component that does subscribe. Both shapes have to be caught structurally,
 * because neither is visible from the call site that introduces it.
 *
 * Scope: the kanban module. The same `useMemo` shape exists outside it (registered in
 * `.qoder/improvement/kanban/plan.md`, deliberately not fixed here), so widening this scan is a
 * separate change with a separate decision behind it.
 */
const KANBAN_ROOT = path.resolve('src/client/lib/markdown/kanban')
const SUBSCRIPTIONS = ['useLocale', 'useLocaleRepaint']

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    if (!/\.tsx?$/.test(entry.name) || /\.test(-helpers)?\./.test(entry.name)) return []
    return [full]
  })
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
}

function callsName(node: ts.Node, name: string): boolean {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name
}

function containsCall(node: ts.Node, name: string): boolean {
  if (callsName(node, name)) return true
  return node.getChildren().some((child) => containsCall(child, name))
}

/** The `memo(…)` components of a file, with the name they carry and whether they listen for the locale. */
function memoComponents(source: ts.SourceFile): { name: string, subscribed: boolean }[] {
  const found: { name: string, subscribed: boolean }[] = []
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && callsName(node.initializer, 'memo')) {
      const wrapped = node.initializer.arguments[0]
      if (wrapped && ts.isFunctionLikeDeclaration(wrapped)) {
        found.push({
          name: ts.isIdentifier(node.name) ? node.name.text : '?',
          subscribed: SUBSCRIPTIONS.some((hook) => containsCall(wrapped, hook)),
        })
      }
    }
    node.getChildren().forEach(visit)
  }
  visit(source)
  return found
}

/** `t(…)` calls evaluated while a `useMemo` factory runs, i.e. cached with the data instead of the language. */
function frozenMemoLabels(source: ts.SourceFile): string[] {
  const labels: string[] = []
  const factoryOf = (node: ts.Node) =>
    ts.isCallExpression(node) && callsName(node, 'useMemo') && ts.isFunctionLikeDeclaration(node.arguments[0] as ts.Node)
      ? node.arguments[0] as ts.FunctionLikeDeclaration
      : undefined
  const visit = (node: ts.Node) => {
    const factory = factoryOf(node)
    if (factory) {
      const collect = (inner: ts.Node) => {
        // A nested function is not the factory body; it runs later, on its own terms.
        if (inner !== factory && ts.isFunctionLikeDeclaration(inner)) return
        if (callsName(inner, 't')) labels.push(oneLine(inner.getText(source)))
        inner.getChildren().forEach(collect)
      }
      if (factory.body) collect(factory.body)
      return
    }
    node.getChildren().forEach(visit)
  }
  visit(source)
  return labels
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * A translation call outside any component body: the module evaluates it once at import, so the label is
 * the language whoever happened to load the chunk.
 */
function moduleScopeLabels(source: ts.SourceFile): string[] {
  const labels: string[] = []
  const visit = (node: ts.Node, depth: number) => {
    if (callsName(node, 't') && depth === 0) labels.push(oneLine(node.getText(source)))
    node.getChildren().forEach((child) => visit(child, ts.isFunctionLikeDeclaration(child) ? depth + 1 : depth))
  }
  visit(source, 0)
  return labels
}

const FILES = sourceFiles(KANBAN_ROOT)
const MEMOS = FILES.flatMap((file) => memoComponents(parse(file)).map((memo) => ({ ...memo, file: path.relative(KANBAN_ROOT, file) })))

describe('a memoized board surface repaints with the language', () => {
  it('every memo component of the kanban module listens for locale changes', () => {
    expect(MEMOS.filter((memo) => !memo.subscribed).map((memo) => `${memo.file}:${memo.name}`)).toEqual([])
  })

  it('finds the memo components, so the rule above cannot pass on an empty walk', () => {
    expect(FILES.length, 'no kanban source files were scanned').toBeGreaterThan(10)
    // 19 at write time; the floor only has to be far from zero to keep a broken walk red.
    expect(MEMOS.length, 'the memo walk found almost nothing').toBeGreaterThanOrEqual(15)
    expect(MEMOS.some((memo) => memo.subscribed), 'no memo component was seen subscribing').toBe(true)
  })

  it('reads both subscription spellings as listening', () => {
    for (const hook of SUBSCRIPTIONS) {
      expect(memoComponents(parseSnippet(`const X = memo(function X() { ${hook}(); return null })`))[0]?.subscribed).toBe(true)
    }
  })

  it('reports a memo component that renders labels and listens for nothing', () => {
    const found = memoComponents(parseSnippet('const X = memo(function X() { return t(\'preview.kanban_filter\') })'))
    expect(found).toHaveLength(1)
    expect(found[0]?.subscribed).toBe(false)
  })
})

describe('translated text is never cached with the data', () => {
  it('no kanban component reads a label inside a useMemo factory', () => {
    expect(
      FILES.flatMap((file) => frozenMemoLabels(parse(file)).map((label) => `${path.relative(KANBAN_ROOT, file)}:${label}`)),
    ).toEqual([])
  })

  it('no kanban module reads a label at module scope', () => {
    expect(
      FILES.flatMap((file) => moduleScopeLabels(parse(file)).map((label) => `${path.relative(KANBAN_ROOT, file)}:${label}`)),
    ).toEqual([])
  })

  it('catches a label read inside a useMemo and lets one read at render pass', () => {
    expect(frozenMemoLabels(parseSnippet('function C() { const s = useMemo(() => t(\'preview.kanban_filter\'), []) }')))
      .toEqual(['t(\'preview.kanban_filter\')'])
    expect(frozenMemoLabels(parseSnippet('function C() { const s = useMemo(() => [{ id: 1 }], []).map((x) => x.id) }'))).toEqual([])
  })

  it('lets a label read in a deferred callback through', () => {
    // A useCallback body runs when the callback runs, so a label read there is translated at use.
    expect(frozenMemoLabels(parseSnippet('function C() { const f = useCallback(() => t(\'preview.kanban_filter\'), []) }'))).toEqual([])
    expect(frozenMemoLabels(parseSnippet('function C() { const s = useMemo(() => { const g = () => t(\'x\'); return g }, []) }'))).toEqual([])
  })

  it('catches a translation the module body itself runs', () => {
    expect(moduleScopeLabels(parseSnippet('const LABEL = t(\'preview.kanban_filter\')'))).toEqual(['t(\'preview.kanban_filter\')'])
    expect(moduleScopeLabels(parseSnippet('function C() { return t(\'preview.kanban_filter\') }'))).toEqual([])
  })
})

/** Parse a snippet the same way a repo file is parsed, so the shape detectors are testable in isolation. */
function parseSnippet(text: string): ts.SourceFile {
  return ts.createSourceFile('snippet.tsx', text, ts.ScriptTarget.Latest, true)
}
