// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * A field the reader may leave out must not be validated by the validator that refuses an empty string.
 *
 * Five PATCH sites in `src/worker/routes/assistant.ts` read an optional, legitimately-empty body field
 * through `text()` — `instructions`, `priceCurrency`, and the three the model editor posts on every save.
 * `text()` throws `This cannot be empty.`, so the whole request 400'd and every other field travelling with
 * it was lost: the editor's own dialog took the failure as success (the client half is
 * `tests/client-save-await-discipline.test.ts`), so a reader who cleared a currency or a brief saw their
 * model come back unchanged with no reason given. The fix is the validator family that answers `''` for
 * absent and null — `optionalTextAllowEmpty`, `currencyValue`, `optionalSkillText`.
 *
 * The rule is about the shape, not about those five lines: a body field is read only when it is present
 * (`body.subtitle !== undefined ? …`, `typeof body.apiKey === 'string'`) or it is read inside a PATCH
 * handler, and either way the field is optional on the wire, so a validator that refuses the empty string
 * refuses the save. Both spellings are covered, which is what makes a sixth field of the same kind fail
 * here instead of failing in production.
 *
 * The whitelist is the other half of the rule: a field that has to hold something — a task title, a model
 * label, the one line of a memory — is answered by `text()` on purpose, in a PATCH as much as in a POST.
 * Refusing an empty title is not the bug; refusing an empty currency is. Each entry names the route, the
 * field, and why the empty string is not a value there, and an entry whose site has gone fails the same way
 * a new site does.
 */
const ROUTE_FILE = path.join('src', 'worker', 'routes', 'assistant.ts')
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete'])
/** A call to this validator is what the rule forbids for an optional field. */
const REQUIRED_TEXT_VALIDATOR = 'text'

/** Optional body fields that are read through `text()` on purpose, each with the reason. */
const REQUIRED_IN_PATCH = new Map<string, string>([
  [
    'PATCH /conversations/:id # title',
    'A conversation with no title is not a conversation the reader can find again; the list renames through an inline field that keeps its own guard, and an empty string means the field was cleared, not that it was left alone.',
  ],
  [
    'PATCH /conversations/:id/messages/:messageId # content',
    'The message body is the whole row: the route rewrites the thread from this message down, so an empty edit would delete the question and keep the answers that were drawn from it.',
  ],
  [
    'PATCH /memories/:id # content',
    'A memory is a fact, and the store keys the review trail on its text: `A memory has to say something.` is what the route answers with, and `category` beside it accepts the empty case through `asCategory`.',
  ],
  [
    'PATCH /tasks/:id # title',
    'The title is how a task is read in the list and in the activity row recorded beside it; `description` beside it is optional and goes through `optionalText`.',
  ],
  [
    'PATCH /projects/:id # name',
    'A project is picked by name in every scope menu, and the create path keys the dedupe on it (`findProjectByName`), so an empty name would make two projects indistinguishable; `description` and `instructions` beside it are optional.',
  ],
  [
    'PATCH /providers/:id # label',
    'The label is what the usage screen and the model picker print for a provider, so an empty one leaves a row nobody can name; `baseUrl`, `endpoints` and `reasoningDialect` beside it have their own validators.',
  ],
  [
    'PATCH /providers/:id/keys/:keyId # apiKey',
    'This branch only runs when a secret was actually typed — `body.apiKey === null` above it is how a key is cleared — so an empty string here is a paste that lost its characters, not a field left blank.',
  ],
  [
    'PATCH /models/:id # label',
    'The label names the model in the picker and on every usage row. `priceCurrency`, `contextTokens` and the rest of the editor is on the optional side of the rule.',
  ],
  [
    'PATCH /models/:id # model',
    'This is the upstream model id sent on the wire; `.replace(/\\s+/g, "")` beside it is what makes the requirement concrete — a blank id cannot answer a request.',
  ],
  // The MCP create and update both read these two, and the update's own route is what the rule looks at.
  [
    'PATCH /mcp/:id # label',
    'The server row is named by its label in the tools tab and in every approval prompt that mentions the server.',
  ],
  [
    'PATCH /mcp/:id # url',
    'The URL is only read when it changed (`body.url !== undefined`), and an MCP server without one cannot be dialed; `mcpUrlProblem` beside it is what rejects a URL that is present but unusable.',
  ],
])

/**
 * One live instance of the class, recorded rather than excused.
 *
 * `POST /conversations` already stores `''` for a title that was not sent, so an explicit empty title is
 * the same answer and gets `This cannot be empty.` back instead — the five-field bug, one field smaller.
 * Converging it (accept `''`, exactly as the absent case does) deletes this entry, and an entry that was
 * quietly dropped without the fix fails here, so the debt cannot be written off by deleting a line.
 */
const OPEN_VIOLATIONS = new Map<string, string>([
])

/** A site the rule found: where the optional field was read, and what the field was. */
interface Site {
  scope: string
  field: string
  line: number
}

const keyOf = (site: Site): string => `${site.scope} # ${site.field}`

function describeSite(site: Site): string {
  return `${site.scope} # ${site.field} (line ${site.line})`
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart()).line + 1
}

/**
 * The route or function a call belongs to.
 *
 * A route handler is labelled `PATCH /mcp/:id` from its own registration, so an entry in the whitelist
 * names the endpoint a reviewer would read; anything else gets the function it was written in, which is
 * how `mcpServerFields` — the helper shared by the create and the patch — stays on the record by name.
 */
function scopeOf(node: ts.Node): string {
  let current: ts.Node = node
  while (current.parent) {
    const parent = current.parent
    if (ts.isCallExpression(parent) && parent.arguments.length >= 2 && isRouteRegistration(parent)) {
      const index = parent.arguments.indexOf(current as ts.Expression)
      if (index >= 1) return `${routeLabel(parent)}`
    }
    if (ts.isFunctionDeclaration(parent) && parent.name) return parent.name.getText()
    if (ts.isMethodDeclaration(parent) && parent.name) return parent.name.getText()
    if ((ts.isArrowFunction(parent) || ts.isFunctionExpression(parent))
      && parent.parent && ts.isVariableDeclaration(parent.parent)) return parent.parent.name.getText()
    current = parent
  }
  return 'module'
}

/** Whether this call registers a route: `routes.patch('/mcp/:id', handler)`, either bracket spelling. */
function isRouteRegistration(node: ts.CallExpression): boolean {
  const target = node.expression
  if (ts.isPropertyAccessExpression(target)) return ROUTE_METHODS.has(target.name.text)
  if (ts.isElementAccessExpression(target)) {
    const index = target.argumentExpression
    return ts.isStringLiteral(index) && ROUTE_METHODS.has(index.text)
  }
  return false
}

/** `PATCH /mcp/:id` for a registration call, or `module` when the path is not a literal. */
function routeLabel(node: ts.CallExpression): string {
  const target = node.expression
  const method = ts.isPropertyAccessExpression(target)
    ? target.name.text
    : ts.isElementAccessExpression(target) && ts.isStringLiteral(target.argumentExpression)
      ? target.argumentExpression.text
      : 'route'
  const pathArg = node.arguments[0]
  const routePath = ts.isStringLiteral(pathArg) ? pathArg.text : pathArg.getText()
  return `${method.toUpperCase()} ${routePath}`
}

/** Whether this branch only runs when the field was sent — the test that makes it optional. */
function isPresenceTest(condition: string, field: string): boolean {
  if (!condition.includes(`body.${field}`)) return false
  return /!==\s*undefined|===\s*undefined|!==\s*null|\btypeof\b|\bin body\b|\?\?/.test(condition)
}

/** Every `text(body.field…)` read the rule covers in this source. */
function requiredValidatorSites(sourceText: string, file = ROUTE_FILE): Site[] {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found: Site[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === REQUIRED_TEXT_VALIDATOR && node.arguments.length >= 1) {
      const argument = node.arguments[0]
      if (ts.isPropertyAccessExpression(argument) && ts.isIdentifier(argument.expression)
        && argument.expression.text === 'body') {
        const field = argument.name.text
        const scope = scopeOf(node)
        let presenceTested = false
        let current: ts.Node = node
        while (current.parent && !(ts.isFunctionLike(current.parent) || ts.isSourceFile(current.parent))) {
          const parent = current.parent
          if (ts.isIfStatement(parent) && isPresenceTest(parent.expression.getText(), field)) presenceTested = true
          if (ts.isConditionalExpression(parent) && isPresenceTest(parent.condition.getText(), field)) presenceTested = true
          current = parent
        }
        const patched = scope.startsWith('PATCH ') || scope.startsWith('PUT ')
        if (presenceTested || patched) found.push({ scope, field, line: lineOf(source, node) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

const REAL_SITES = requiredValidatorSites(fs.readFileSync(ROUTE_FILE, 'utf8'))

describe('an optional body field never meets the required-text validator', () => {
  it('reads a route file that still has both sides of the rule', () => {
    // A guard whose target moved would report a clean tree forever.
    const text = fs.readFileSync(ROUTE_FILE, 'utf8')
    expect(text, 'the assistant routes moved').toContain('assistantRoutes.patch(')
    expect(text, 'text() is no longer the required-text validator').toContain(`function ${REQUIRED_TEXT_VALIDATOR}(`)
    expect(text, 'the optional family is gone, so the rule has nothing to point at').toContain('optionalTextAllowEmpty(')
    expect(REAL_SITES.length, 'no site was read, so the scan cannot be trusted').toBeGreaterThan(5)
  })

  it('fails when a field that may be absent is validated by text()', () => {
    const offenders = REAL_SITES
      .filter((site) => !REQUIRED_IN_PATCH.has(keyOf(site)))
      .filter((site) => !OPEN_VIOLATIONS.has(keyOf(site)))
      .map((site) => `${describeSite(site)} — this field is optional on the wire; answer it with optionalTextAllowEmpty (or currencyValue for a field whose empty value is real), or add it to REQUIRED_IN_PATCH with why the empty string is not a value`)
    expect(offenders, `${offenders.length} optional field(s) still refuse an empty save.`).toEqual([])
  })

  it('keeps the required-field whitelist honest', () => {
    const keys = new Set(REAL_SITES.map(keyOf))
    const stale = [...REQUIRED_IN_PATCH.keys()].filter((key) => !keys.has(key))
    expect(stale, `these sites no longer read an optional field through text() — delete the entry: ${stale.join(', ')}`).toEqual([])
    for (const [key, reason] of REQUIRED_IN_PATCH) {
      expect(reason.length, `${key} needs a reason a reviewer can read`).toBeGreaterThan(40)
    }
  })

  it('keeps the recorded violation on the books until it is fixed', () => {
    const keys = new Set(REAL_SITES.map(keyOf))
    const paid = [...OPEN_VIOLATIONS.keys()].filter((key) => !keys.has(key))
    expect(paid, `this site no longer reads an optional field through text() — the fix landed, delete the entry: ${paid.join(', ')}`).toEqual([])
    const excused = [...OPEN_VIOLATIONS.keys()].filter((key) => REQUIRED_IN_PATCH.has(key))
    expect(excused, `a recorded violation cannot also be excused: ${excused.join(', ')}`).toEqual([])
  })

  it('fires on a new optional field and clears when it is answered by the optional family', () => {
    // Positive control: the rule was written after the five sites, so a scan that could not see a sixth
    // would be reporting the tree it wishes for. The planted handler is the shape that 400'd.
    const planted = `
      const routes = new Hono()
      routes.patch('/things/:id', async (c) => {
        const body = await readJson<Record<string, unknown>>(c)
        return c.json(await store.update(id, {
          ...(body.subtitle !== undefined ? { subtitle: text(body.subtitle, 40) } : {}),
          ...(body.priceCurrency !== undefined ? { priceCurrency: currencyValue(body.priceCurrency) } : {}),
        }))
      })
    `
    expect(requiredValidatorSites(planted, 'planted.ts').map(keyOf)).toEqual(['PATCH /things/:id # subtitle'])

    // The same handler answered by the optional family is not a site, so a fix clears the guard here.
    const fixed = planted.replace('text(body.subtitle, 40)', 'optionalTextAllowEmpty(body.subtitle, 40)')
    expect(requiredValidatorSites(fixed, 'planted.ts')).toEqual([])

    // And a field read unconditionally inside a PATCH is covered too — that is the message-content shape.
    const unconditional = `
      routes.patch('/notes/:id', async (c) => {
        const body = await readJson(c)
        const title = text(body.title, 60)
        return c.json({ title })
      })
    `
    expect(requiredValidatorSites(unconditional, 'planted.ts').map(keyOf)).toEqual(['PATCH /notes/:id # title'])
  })
})
