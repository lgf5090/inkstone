import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * A `role="list"` is a promise about its children.
 *
 * The to-do module had three of them — the grouped task list, the board's cards and the "today" panel —
 * and not one child was a `listitem`: the groups are `<section>` regions, and the rows are cards. A
 * screen reader that meets the container announces "list" and then reads nothing into it, so the
 * structure it promises is worse than the plain container it replaced.
 *
 * The rule is read from the source rather than from a render, because the surfaces that carry it are
 * mounted in three different tests and a fourth would still not cover the next one added. It is
 * deliberately one-directional: a file may write `role="list"` as long as it also names a `listitem`,
 * which is the only shape the role can honestly describe.
 *
 * Read through the parser rather than by regex, so the comment above — and any comment that quotes the
 * attribute it is arguing about — is not mistaken for markup.
 */

const ROOT = 'src/client/features/todos'

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    // Tests are not shipped and speak about roles as strings; only the module's own markup is read.
    else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) out.push(full)
  }
  return out
}

/** Every `role="…"` written as a JSX attribute, ignoring comments and ordinary strings. */
function rolesIn(file: string): Set<string> {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const roles = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === 'role') {
      const initializer = node.initializer
      if (initializer && ts.isStringLiteral(initializer)) roles.add(initializer.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return roles
}

describe('the to-do module’s list semantics', () => {
  it('never names a list whose rows it cannot name as items', () => {
    const offenders = sourceFiles(ROOT).filter((file) => {
      const roles = rolesIn(file)
      return roles.has('list') && !roles.has('listitem')
    })
    expect(offenders, 'a role="list" with no listitem is read out as an empty list').toEqual([])
  })
})
