// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * One token ladder, because one setting has one set of picks.
 *
 * `src/shared/assistant.ts` used to export three overlapping ladders — `TOKEN_STEPS`,
 * `CONTEXT_WINDOW_STEPS` and `CONTEXT_TOKEN_STEPS` — and each screen picked the one next to its own code.
 * The result was one setting offering a reader different ceilings in the budget tab than in the composer
 * chip row (W5-C), which is not something anybody can reason about. The two extra ladders are gone; every
 * pick now comes from `TOKEN_STEPS`.
 *
 * Two rules keep it that way:
 *
 *  1. the shared module exports exactly one numeric ladder — an array of at least three numbers, two of
 *     them token-sized — and its name is `TOKEN_STEPS`, so a fourth screen cannot add a second source of
 *     truth where the first one already sits;
 *  2. no file re-declares one. A numeric array with two or more token-shaped entries (a whole multiple of
 *     1024) is a ladder whoever wrote it, wherever it was written, including a `steps={…}` prop that hands
 *     a screen its own picks — which is exactly how three ladders reached three screens.
 *
 * The whitelist is by constant name, not by line number, because that is what a reviewer searches for: an
 * entry says "this array is a token ladder, and here is why it is not the setting's ladder". Today it is
 * empty, and an entry whose ladder has since been converged fails the same way a new one does.
 */
const SHARED_FILE = path.join('src', 'shared', 'assistant.ts')
const SRC_DIR = 'src'
/** The one ladder the shared module is allowed to export. */
const CANONICAL_LADDER = 'TOKEN_STEPS'
/** A number big enough to be a token budget and round enough to be a step of one. */
const TOKEN_UNIT = 1024

/** A ladder the scan found: who declares it, where, and what it holds. */
interface Ladder {
  file: string
  name: string
  line: number
  exported: boolean
  values: string
}

const keyOf = (ladder: Ladder): string => `${ladder.file} # ${ladder.name}`

function describeLadder(ladder: Ladder): string {
  return `${ladder.file}:${ladder.line} ${ladder.exported ? 'export const' : 'const'} ${ladder.name} = [${ladder.values}]`
}

/**
 * Ladders the second rule tolerates, by file and name.
 *
 * Nothing is here today: every thousand-sized array in `src` either is the setting's ladder or is not a
 * ladder at all (a byte size nobody chooses from a pick list). The map exists so a legitimate second list
 * can be recorded with a reason instead of forcing the guard to be loosened for everybody — and an entry
 * whose ladder has since been converged fails here, so the list can only shrink.
 */
const LADDER_BASELINE = new Map<string, string>([
])

/** Every element of an array literal read as a number, or nothing as soon as one of them is not. */
function numericSteps(node: ts.ArrayLiteralExpression): number[] {
  const values: number[] = []
  for (const element of node.elements) {
    if (!ts.isNumericLiteral(element)) return []
    const value = Number(element.getText().replace(/_/g, ''))
    if (!Number.isFinite(value)) return []
    values.push(value)
  }
  return values
}

/** A ladder: three or more numbers, two of which are whole thousands of tokens. */
function isTokenLadder(values: number[]): boolean {
  if (values.length < 3) return false
  return values.filter((value) => value >= TOKEN_UNIT && value % TOKEN_UNIT === 0).length >= 2
}

/** Every token ladder one source declares: exported, local, or handed to a `steps` prop. */
function laddersIn(file: string, sourceText: string): Ladder[] {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: Ladder[] = []
  const report = (name: string, array: ts.ArrayLiteralExpression, exported: boolean): void => {
    const values = numericSteps(array)
    if (!isTokenLadder(values)) return
    found.push({
      file,
      name,
      line: source.getLineAndCharacterOfPosition(array.getStart()).line + 1,
      exported,
      values: values.join(', '),
    })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && !!node.initializer && ts.isArrayLiteralExpression(node.initializer) && ts.isIdentifier(node.name)) {
      const statement = node.parent.parent
      const exported = !!statement && ts.isVariableStatement(statement)
        && (statement.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      report(node.name.text, node.initializer, exported)
    }
    // `steps={[4096, 8192, 65536]}`: a screen handed its own picks, which is how three ladders met.
    if (ts.isJsxAttribute(node) && node.name.getText() === 'steps' && node.initializer
      && ts.isJsxExpression(node.initializer) && node.initializer.expression
      && ts.isArrayLiteralExpression(node.initializer.expression)) {
      report('steps prop', node.initializer.expression, false)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

const relative = (file: string): string => path.relative(process.cwd(), file).replaceAll('\\', '/')

/**
 * The pre-filter, and why it is allowed.
 *
 * A step of a token ladder is a whole multiple of 1024, so it is written with at least four digits —
 * `1024`, `65_536`. A file that holds no such number cannot hold a ladder, and parsing all of `src` to find
 * one array would cost the suite seconds it does not need. The filter is checked against the module that
 * holds the ladder below, so a rule-relevant file that stops matching it fails there instead of passing
 * quietly.
 */
function couldHoldLadder(text: string): boolean {
  return /\d{4}/.test(text) || /_\d{3}/.test(text)
}

const ALL_LADDERS = sourceFiles(SRC_DIR)
  .map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }))
  .filter((entry) => couldHoldLadder(entry.text))
  .flatMap((entry) => laddersIn(relative(entry.file), entry.text))
const SHARED_LADDERS = ALL_LADDERS.filter((ladder) => ladder.file === relative(SHARED_FILE) && ladder.exported)
/** Anything but the canonical ladder, wherever it sits. */
const COMPETING = ALL_LADDERS.filter((ladder) => keyOf(ladder) !== `${relative(SHARED_FILE)} # ${CANONICAL_LADDER}`)

describe('one token ladder, exported from one place', () => {
  it('reads the shared module it governs', () => {
    const text = fs.readFileSync(SHARED_FILE, 'utf8')
    expect(text, 'the canonical ladder is gone, so this guard is reading nothing').toContain(`export const ${CANONICAL_LADDER}`)
    expect(couldHoldLadder(text), 'the pre-filter no longer matches the module that holds the ladder').toBe(true)
    expect(SHARED_LADDERS.map((ladder) => ladder.name)).toEqual([CANONICAL_LADDER])
    // The two ladders that split the picks must stay deleted, not merely unused.
    expect(text).not.toMatch(/CONTEXT_WINDOW_STEPS/)
    expect(text).not.toMatch(/CONTEXT_TOKEN_STEPS/)
    // And the screens that used to hold their own still reach for the shared one.
    expect(fs.readFileSync(path.join('src', 'client', 'features', 'chat', 'ModelEditorDialog.tsx'), 'utf8'))
      .toContain(CANONICAL_LADDER)
  })

  it('keeps exactly one exported numeric ladder in the shared module', () => {
    const offenders = SHARED_LADDERS
      .filter((ladder) => ladder.name !== CANONICAL_LADDER)
      .map((ladder) => `${describeLadder(ladder)} — a second ladder for one setting; extend ${CANONICAL_LADDER} or give these picks a different kind of value`)
    expect(offenders, `${offenders.length} exported ladder(s) compete in ${relative(SHARED_FILE)}.`).toEqual([])
  })

  it('fails when a file re-declares a token ladder', () => {
    const lines = COMPETING
      .filter((ladder) => !LADDER_BASELINE.has(keyOf(ladder)))
      .map((ladder) => `${describeLadder(ladder)} — import ${CANONICAL_LADDER} from '@shared/assistant', or add this to LADDER_BASELINE with why it is not the setting's ladder`)
    expect(lines, `${lines.length} competing token ladder(s) in src.`).toEqual([])
  })

  it('keeps the ladder baseline honest', () => {
    const keys = new Set(ALL_LADDERS.map(keyOf))
    const stale = [...LADDER_BASELINE.keys()].filter((key) => !keys.has(key))
    expect(stale, `these ladders are gone — delete the entry: ${stale.join(', ')}`).toEqual([])
    for (const [key, reason] of LADDER_BASELINE) {
      expect(reason.length, `${key} has no reason written`).toBeGreaterThan(40)
    }
  })

  it('fires on a second exported ladder and on a screen that hand-writes its picks', () => {
    // Positive control: three ladders lived in one file and nothing caught it, so a scan that could only
    // see one of them would be documenting the fix rather than guarding it.
    const secondLadder = `
      export const TOKEN_STEPS: readonly number[] = [1024, 4096, 8192, 16384]
      export const CONTEXT_TOKEN_STEPS: readonly number[] = [4096, 8192, 65536]
    `
    expect(laddersIn('planted.ts', secondLadder).map((ladder) => ladder.name))
      .toEqual([CANONICAL_LADDER, 'CONTEXT_TOKEN_STEPS'])

    const localCopy = `
      const WINDOW_STEPS = [4096, 8192, 65536]
      export const Picker = () => <Chips steps={[4096, 8192, 65536]} />
    `
    expect(laddersIn('planted.tsx', localCopy).map((ladder) => ladder.name)).toEqual(['WINDOW_STEPS', 'steps prop'])

    // Importing the shared ladder is the shape that clears both rules.
    const converged = `
      import { TOKEN_STEPS } from '@shared/assistant'
      export const Picker = () => <Chips steps={TOKEN_STEPS} />
    `
    expect(laddersIn('planted.tsx', converged)).toEqual([])

    // And an array that is not token-sized is not a ladder, so the rule reads ladders, not numbers.
    expect(laddersIn('planted.ts', 'const WIDTHS = [320, 640, 960]')).toEqual([])
  })
})
