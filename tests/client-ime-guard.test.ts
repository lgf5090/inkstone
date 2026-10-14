// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * A bare key that is still typing goes to the input method, not to the app.
 *
 * While a Chinese or Japanese composition is open, Enter accepts a candidate, Escape cancels it and the
 * arrows page the list. An `onKeyDown` that acts on one of those keys inside a text field therefore runs
 * the action underneath at the very moment the user finishes the word: the note title saves as half a
 * pinyin string, the dialog closes with the composition still open, the chat sends a message that was
 * still being assembled. `AGENTS.md` rule 13 makes keyboard interaction an accessibility red line, and
 * this is the part of it that only shows up for the majority of this app's users.
 *
 * `src/client/lib/ime.ts` is the one answer to the question; this scan is what stops a new field from
 * forgetting to ask it. A handler that delegates Enter to `commitOnEnter` holds no literal key
 * comparison and is covered by that helper, so it passes without repeating the check.
 */
const CLIENT_DIR = path.join('src', 'client')

/** Keys an input method claims while composing. Everything else is a keystroke the app may own. */
const IME_CLAIMED_KEYS = ['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Backspace', 'Delete']

/** Real text fields, however they are spelled. */
const EDITABLE_ELEMENTS = ['input', 'textarea']

/** A component identified by where it is defined, so an icon called `Inbox` never borrows the pane's reach. */
type ComponentId = string

interface Unit {
  /** Repo-relative path, used both as the identity of this file and in every failure message. */
  name: string
  file: string
  text: string
  source: ts.SourceFile
  /** Local component definitions by the name this file writes, qualified by this file. */
  defs: Map<string, { id: ComponentId, body: ts.Node }>
  /** Imported names mapped to the file that defines them, following `as` aliases to the original export. */
  imports: Map<string, { id: ComponentId, exported: string, unit: Unit }>
}

interface Graph {
  units: Unit[]
  /** Every component and the components it renders, all keyed by `file#Name`. */
  renders: Map<ComponentId, Set<string>>
  writesField: Set<ComponentId>
  byId: Map<ComponentId, { unit: Unit, body: ts.Node }>
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, out)
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

function parseSource(name: string, text: string): Unit {
  return {
    name,
    file: name,
    text,
    source: ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
    defs: new Map(),
    imports: new Map(),
  }
}

function parse(file: string): Unit {
  return parseSource(path.relative(process.cwd(), file).replaceAll('\\', '/'), fs.readFileSync(file, 'utf8'))
}

/** `./form` and `../components/form` as the file they name, so an import edge can be followed. */
function resolveModule(fromFile: string, specifier: string, known: Set<string>): string | null {
  if (!specifier.startsWith('.')) return null
  const base = path.dirname(fromFile)
  const target = path.posix.normalize(path.posix.join(base, specifier))
  for (const candidate of [`${target}.tsx`, `${target}.ts`, `${target}/index.tsx`, `${target}/index.ts`, target]) {
    // A unit set that is not on disk still has to resolve, so the in-memory names count as files here.
    if (known.has(candidate) || (fs.existsSync(candidate) && fs.statSync(candidate).isFile()))
      return candidate
  }
  return null
}

function indexFile(unit: Unit, byName: Map<string, Unit>): void {
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      unit.defs.set(node.name.getText(), { id: `${unit.name}#${node.name.getText()}`, body: node })
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      unit.defs.set(node.name.getText(), { id: `${unit.name}#${node.name.getText()}`, body: node.initializer })
    }
    ts.forEachChild(node, visit)
  }
  visit(unit.source)
  for (const statement of unit.source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const resolved = resolveModule(unit.name, statement.moduleSpecifier.text, new Set(byName.keys()))
    const imported = resolved ? byName.get(resolved) : undefined
    const bindings = statement.importClause?.namedBindings
    if (!imported || !bindings || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      const local = element.name.getText()
      const exported = element.propertyName?.getText() ?? local
      unit.imports.set(local, { id: `${imported.name}#${exported}`, exported, unit: imported })
    }
  }
}

/**
 * Which components end up drawing a text field.
 *
 * `<PromptField>` is the only child of a `<div onKeyDown>` and renders an `<Input>`, so a rule that
 * looked only at literal `<input>` tags would call that container safe while it ate the user's Escape.
 * The answer is a fixpoint over the component graph: a component is editable if it writes a field, or if
 * anything it renders is. Edges are followed to the file that defines the name, because lucide exports an
 * icon called `Inbox` and the sidebar exports a pane with a search box of the same name.
 */
function buildGraph(units: Unit[]): Graph {
  const byName = new Map(units.map((unit) => [unit.name, unit]))
  for (const unit of units) indexFile(unit, byName)
  const graph: Graph = { units, renders: new Map(), writesField: new Set(), byId: new Map() }
  for (const unit of units) {
    for (const [name, def] of unit.defs) {
      graph.byId.set(def.id, { unit, body: def.body })
      const rendered = new Set<string>()
      const visit = (node: ts.Node): void => {
        if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
          const tag = node.tagName.getText()
          if (EDITABLE_ELEMENTS.includes(tag.toLowerCase())) graph.writesField.add(def.id)
          else if (/^[A-Z]/.test(tag)) {
            const local = unit.defs.get(tag)
            const external = unit.imports.get(tag)
            if (local) rendered.add(local.id)
            else if (external) rendered.add(external.id)
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(def.body)
      graph.renders.set(def.id, rendered)
    }
  }
  return graph
}

function editableComponents(graph: Graph): Set<ComponentId> {
  const editable = new Set(graph.writesField)
  for (let round = 0; round < 12; round++) {
    let changed = false
    for (const [id, rendered] of graph.renders) {
      if (editable.has(id)) continue
      for (const child of rendered) {
        if (editable.has(child)) {
          editable.add(id)
          changed = true
          break
        }
      }
    }
    if (!changed) break
  }
  return editable
}

/** The id a written tag refers to: this file's own component, the file it imported it from, or nobody's. */
function resolveTag(unit: Unit, tag: string): ComponentId | null {
  const local = unit.defs.get(tag)
  if (local) return local.id
  return unit.imports.get(tag)?.id ?? null
}

/** Does this element draw a text field itself or have one among its children? */
function drawsField(unit: Unit, host: ts.JsxOpeningElement | ts.JsxSelfClosingElement, graph: Graph, editable: Set<ComponentId>): boolean {
  const tag = host.tagName.getText()
  if (EDITABLE_ELEMENTS.includes(tag.toLowerCase())) return true
  const id = resolveTag(unit, tag)
  if (id && editable.has(id)) return true
  // Only an opening element has children; a self-closing one sits among its siblings, and reading the
  // parent's children would blame whatever happens to be rendered next to it.
  const children = ts.isJsxOpeningElement(host) ? (host.parent?.children ?? []) : []
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const childTag = node.tagName.getText()
      if (EDITABLE_ELEMENTS.includes(childTag.toLowerCase())) found = true
      else {
        const childId = resolveTag(unit, childTag)
        if (childId && editable.has(childId)) found = true
      }
    }
    if (!found) ts.forEachChild(node, visit)
  }
  for (const child of children) visit(child)
  return found
}

function bareKeys(node: ts.Node): string[] {
  const found = new Set<string>()
  const isKeyExpr = (expr: ts.Expression): boolean => ts.isPropertyAccessExpression(expr) && /(?:^|\.)key$/.test(expr.getText())
  const visit = (n: ts.Node): void => {
    if (ts.isBinaryExpression(n)
      && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(n.operatorToken.kind)) {
      const left = n.left
      const right = n.right
      if (isKeyExpr(left) && ts.isStringLiteral(right)) found.add(right.text)
      if (isKeyExpr(right) && ts.isStringLiteral(left)) found.add(left.text)
    }
    if (ts.isSwitchStatement(n) && isKeyExpr(n.expression)) {
      for (const clause of n.caseBlock.clauses)
        if (ts.SyntaxKind.CaseClause === clause.kind && ts.isStringLiteral(clause.expression)) found.add(clause.expression.text)
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return [...found].filter((key) => IME_CLAIMED_KEYS.includes(key))
}

/** Handlers that ask the composition question, in either of the two forms the codebase writes it. */
function consultsComposition(node: ts.Node): boolean {
  let yes = false
  const visit = (n: ts.Node): void => {
    if (yes) return
    if (ts.isCallExpression(n) && /(?:^|\.)isImeComposing$/.test(n.expression.getText())) yes = true
    if (ts.isPropertyAccessExpression(n) && /(?:^|\.)isComposing$/.test(n.getText())) yes = true
    if (!yes) ts.forEachChild(n, visit)
  }
  visit(node)
  return yes
}

/** Every bare-key `onKeyDown` that can receive a keystroke from a text field and does not ask about composition. */
function unguardedKeyHandlers(graph: Graph, editable: Set<ComponentId>): string[] {
  const offenders: string[] = []
  for (const unit of graph.units) {
    const visit = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node) && node.name.getText() === 'onKeyDown') {
        const initializer = node.initializer
        let handler: ts.Node | undefined = initializer && ts.isJsxExpression(initializer) ? initializer.expression : initializer
        const walked = new Set<string>()
        while (handler && ts.isIdentifier(handler) && !walked.has(handler.getText())) {
          walked.add(handler.getText())
          const next = unit.defs.get(handler.getText())
          if (!next) break
          handler = next.body
        }
        const host = node.parent?.parent
        if (handler && (ts.isJsxOpeningElement(host) || ts.isJsxSelfClosingElement(host))) {
          const keys = bareKeys(handler)
          if (keys.length > 0 && !consultsComposition(handler) && drawsField(unit, host, graph, editable)) {
            const line = unit.source.getLineAndCharacterOfPosition(node.getStart(unit.source)).line + 1
            offenders.push(`${unit.name}:${line} <${host.tagName.getText()}> handles ${keys.join('/')} while a composition may own it`)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(unit.source)
  }
  return offenders.sort()
}

function load(): { graph: Graph, editable: Set<ComponentId> } {
  const graph = buildGraph(walkFiles(CLIENT_DIR).map(parse))
  return { graph, editable: editableComponents(graph) }
}

describe('every bare key a text field can hand to the app is offered to the input method first', () => {
  it('finds no client key handler that skips the composition check', () => {
    const { graph, editable } = load()
    const offenders = unguardedKeyHandlers(graph, editable)
    expect(offenders, `${offenders.length} unguarded key handler(s); call isImeComposing(event) from src/client/lib/ime.ts`).toEqual([])
  })

  it('sees the field through a component, not only through a literal tag', () => {
    // The scan is only worth as much as its reach: a container that swallows Escape because a wrapped
    // field bubbles it up is the case a tag table would miss.
    const container = parseSource('a/dialog.tsx', `
      import { Field } from './field'
      export function Dialog() {
        return <div onKeyDown={(event) => { if (event.key === 'Escape') close() }}><Field /></div>
      }`)
    const field = parseSource('a/field.tsx', 'export function Field() { return <input /> }')
    const graph = buildGraph([container, field])
    expect(unguardedKeyHandlers(graph, editableComponents(graph)))
      .toEqual(['a/dialog.tsx:4 <div> handles Escape while a composition may own it'])
  })

  it('does not let an unrelated component of the same name borrow a field reach', () => {
    const icon = parseSource('b/icons.tsx', 'export function Inbox() { return <svg /> }')
    const menu = parseSource('b/menu.tsx', `
      import { Inbox } from './icons'
      export function MoveMenu() {
        return <div onKeyDown={(event) => { if (event.key === 'Escape') close() }}><Inbox /></div>
      }`)
    const graph = buildGraph([icon, menu])
    expect(unguardedKeyHandlers(graph, editableComponents(graph))).toEqual([])
  })

  it('lets a handler that asks the composition question pass', () => {
    const guarded = parseSource('c/guarded.tsx', `
      import { isImeComposing } from '../lib/ime'
      export function Field() {
        return <input onKeyDown={(event) => { if (isImeComposing(event)) return; if (event.key === 'Enter') save() }} />
      }`)
    const graph = buildGraph([guarded])
    expect(unguardedKeyHandlers(graph, editableComponents(graph))).toEqual([])
  })

  it('fails loudly when the scan stops covering the client', () => {
    const { graph, editable } = load()
    const handlers = graph.units.reduce((count, unit) => count + (unit.text.match(/onKeyDown=/g) ?? []).length, 0)
    expect(handlers, 'the scan found no key handler at all, so it cannot be trusted').toBeGreaterThan(40)
    const fields = graph.units.filter((unit) => /<input|<textarea/i.test(unit.text)).length
    expect(fields, 'the scan found no file drawing a text field, so it cannot be trusted').toBeGreaterThan(20)
    expect(editable.size, 'no component resolved to a text field').toBeGreaterThan(5)
  })
})
