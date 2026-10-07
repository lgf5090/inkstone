// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const DIALOG_NAMES = new Set(['alert', 'confirm', 'prompt'])
const NATIVE_RECEIVERS = new Set(['window', 'globalThis', 'self', 'top', 'parent'])
const LEAVE_PAGE_EVENTS = new Set(['beforeunload', 'unload', 'pagehide'])

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) yield* walk(target)
    else yield target
  }
}

function program(): Array<{ file: string; source: ts.SourceFile }> {
  const files = [
    ...walk(path.join(ROOT, 'src')),
    ...walk(path.join(ROOT, 'public')),
    path.join(ROOT, 'index.html'),
  ].filter((file) => /\.(ts|tsx|js)$/.test(file) && !/\.test\.[cm]?[jt]sx?$/.test(file))
  return files.map((file) => ({
    file: path.relative(ROOT, file),
    source: ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true),
  }))
}

const PROJECT = program()

function collectPatternNames(node: ts.Node | undefined, into: Set<string>): void {
  if (!node) return
  if (ts.isIdentifier(node)) into.add(node.text)
  else if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
    node.elements.forEach((element) => collectPatternNames((element as ts.BindingElement).name, into))
  }
}

function boundNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && node.importClause) {
      if (node.importClause.name) names.add(node.importClause.name.text)
      const bindings = node.importClause.namedBindings
      if (bindings) {
        if (ts.isNamespaceImport(bindings)) names.add(bindings.name.text)
        else bindings.elements.forEach((element) => names.add(element.name.text))
      }
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) names.add(node.name.text)
    if (ts.isVariableDeclaration(node)) collectPatternNames(node.name, names)
    if (ts.isParameter(node)) collectPatternNames(node.name, names)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return names
}

function nativeDialogCalls(file: string, source: ts.SourceFile): string[] {
  const bindings = boundNames(source)
  const findings: string[] = []
  const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isPropertyAccessExpression(callee) && DIALOG_NAMES.has(callee.name.text)
        && ts.isIdentifier(callee.expression) && NATIVE_RECEIVERS.has(callee.expression.text)) {
        findings.push(`${file}:${line(node)} ${callee.expression.text}.${callee.name.text}()`)
      }
      else if (ts.isElementAccessExpression(callee) && ts.isStringLiteral(callee.argumentExpression)
        && DIALOG_NAMES.has(callee.argumentExpression.text)
        && ts.isIdentifier(callee.expression) && NATIVE_RECEIVERS.has(callee.expression.text)) {
        findings.push(`${file}:${line(node)} ${callee.expression.text}['${callee.argumentExpression.text}']()`)
      }
      else if (ts.isIdentifier(callee) && DIALOG_NAMES.has(callee.text) && !bindings.has(callee.text)) {
        findings.push(`${file}:${line(node)} ${callee.text}()`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}

function opensTheLeavePageDialog(node: ts.Node): boolean {
  let blocked = false
  const visit = (current: ts.Node) => {
    if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)
      && current.expression.name.text === 'preventDefault') blocked = true
    if (ts.isBinaryExpression(current) && current.left.kind === ts.SyntaxKind.PropertyAccessExpression
      && (current.left as ts.PropertyAccessExpression).name.text === 'returnValue'
      && current.operatorToken.kind === ts.SyntaxKind.EqualsToken) blocked = true
    if (!blocked) ts.forEachChild(current, visit)
  }
  visit(node)
  return blocked
}

function declarationsNamed(source: ts.SourceFile, name: string): ts.Node[] {
  const found: ts.Node[] = []
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body) found.push(node.body)
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) found.push(node.initializer)
    if ((ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) && node.name.getText(source) === name
      && (node.body ?? node.initializer)) found.push((node.body ?? node.initializer)! as ts.Node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function leavePageFindings(file: string, source: ts.SourceFile): string[] {
  const findings: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'addEventListener' && node.arguments.length >= 2
      && ts.isStringLiteral(node.arguments[0]) && LEAVE_PAGE_EVENTS.has(node.arguments[0].text)) {
      const event = node.arguments[0].text
      const handler = node.arguments[1]
      if (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) {
        findings.push(`${file}: the ${event} handler has to be a named function with its reason documented`)
      }
      else {
        const name = ts.isIdentifier(handler) ? handler.text
          : ts.isPropertyAccessExpression(handler) ? handler.name.text : ''
        const bodies = declarationsNamed(source, name)
        if (!name || bodies.length === 0) findings.push(`${file}: the ${event} handler ${name || '?'} is not defined in this file`)
        else if (bodies.some(opensTheLeavePageDialog)) findings.push(`${file}: ${name} would raise the browser's own leave-page dialog`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}

describe('no native dialogs anywhere in the shipped code', () => {
  it('parses every file it scans', () => {
    const broken = PROJECT.filter(({ file, source }) =>
      (source as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics?.length)
      .map(({ file }) => file)
    expect(broken).toEqual([])
  })

  it('calls no window alert, confirm or prompt', () => {
    expect(PROJECT.flatMap(({ file, source }) => nativeDialogCalls(file, source))).toEqual([])
  }, 20_000)

  it('documents every leave-page listener and never raises the browser dialog', () => {
    expect(PROJECT.flatMap(({ file, source }) => leavePageFindings(file, source))).toEqual([])
  })

  it('routes confirmations through the overlay helper', () => {
    const helper = PROJECT.find(({ file }) => file === path.join('src', 'client', 'components', 'overlay.tsx'))
    expect(helper).toBeDefined()
    const confirmations = PROJECT.filter(({ file, source }) => file !== helper!.file)
      .filter(({ source }) => {
        let seen = false
        const visit = (node: ts.Node) => {
          if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'confirm'
            && node.arguments.length > 0 && ts.isObjectLiteralExpression(node.arguments[0])) seen = true
          ts.forEachChild(node, visit)
        }
        visit(source)
        return seen
      })
    expect(confirmations.length).toBeGreaterThan(0)
    const unbound = confirmations.filter(({ source }) => !boundNames(source).has('confirm')).map(({ file }) => file)
    expect(unbound).toEqual([])
  })
})
