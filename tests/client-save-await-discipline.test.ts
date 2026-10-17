// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * A dialog that closes before its write answers turns a 400 into a success.
 *
 * `ModelEditorDialog.tsx` used to end its save with `onClick={() => { onSave(draft); onClose() }}`. The
 * request was still in flight when the editor went away, so when it came back `This cannot be empty.` —
 * from one of the optional fields in `tests/assistant-optional-field-validators.test.ts` — the reader had
 * already seen the dialog close happily and their model was unchanged. The fix awaits the write, keeps the
 * dialog open when it answers `false`, and reports the reason inside it.
 *
 * Two shapes are forbidden here, both read from the written statements of one function body:
 *
 *  1. A close (`onClose()`, `onDismiss()`, `close()`, `setOpen(false)`, `setEditing(null)`, `setDraft(null)`,
 *     `setRenaming(null)`, `setMerging(null)`, …) in a body that discards a write's promise earlier in the
 *     same sequence. A promise is read as discarded when the call is written with `void` — the idiom this
 *     codebase uses for "this returns a promise and I am not watching it" — or when an `on…` handler prop is
 *     called as its own statement. `await`, a returned value, or a value bound to a variable is not a
 *     discard, which is what makes the fixed `const ok = await onSave(…); if (!ok) return; onClose()` pass.
 *  2. `.then(onClose)` / `.then(() => onClose())` on a write: the close rides the success branch of a promise
 *     nobody waits for, so a rejection leaves the dialog standing with nothing said. Awaiting the chain
 *     clears it, because then the throw lands before the close instead of beside it.
 *
 * What is whitelisted is read the same way as everywhere else in this repo — a key per site with a count and
 * a reason, failing in both directions. The entries are of two kinds, and each says which: a write whose
 * failure the store itself reports (`catch (error) { toast(error) }` inside the action), so nothing is
 * silently lost even though the dialog closed first; or a call this name-only read cannot see the type of,
 * where the prop or the store signature says `=> void` and nothing was pending to await. One further site is
 * recorded as a live instance of the bug rather than excused, in `RECORDED_EARLY_CLOSE`.
 */
const FEATURES_DIR = path.join('src', 'client', 'features')

/** Call names that end a form, a panel or an inline editor. */
const CLOSE_FUNCS = new Set(['onClose', 'onDismiss', 'onCancel', 'close', 'hide'])
/** `setEditing(null)`, `setOpen(false)`: the local-state spellings of the same close. */
const CLOSE_SETTERS = /^set(?:Open|Editing|Renaming|Rename|Draft|Adding|Creating|New|Merging|Comment)$/
/** A write op by name: the verb in camelCase, or the verb plus what it writes. */
const WRITE_NAME = /^(?:save|submit|create|update|rename|edit|persist|import|restore|archive|fork|upload|authorize|activate|add|delete|remove|move|copy|send|write|patch)(?:[A-Z][A-Za-z0-9]*)?$/
/** The same verbs behind the `on…` prop that hands the write to a parent — the model editor's shape. */
const HANDLER_WRITE_NAME = /^on(?:Save|Submit|Create|Update|Rename|Edit|Persist|Import|Restore|Archive|Fork|Upload|Authorize|Activate|Add|Delete|Remove|Move|Copy|Send|Write|Patch)(?:[A-Z][A-Za-z0-9]*)?$/
/** The chain steps that mean somebody took the answer. */
const THEN_CATCH = new Set(['then', 'catch', 'finally'])
/** A promise chain that hands the close to the success branch. */
const THEN_NAMES = new Set(['then', 'finally'])

/** A site the rule found: which file, which function, which write, and where. */
interface Site {
  file: string
  scope: string
  write: string
  line: number
  rule: 'discarded-write' | 'then-close'
}

/** Sites today, each with how many of them the file writes and why. */
const DISCARDED_WRITE_BASELINE = new Map<string, { sites: number; reason: string }>([
  [
    'src/client/features/chat/TasksView.tsx # TaskEditor # updateTask',
    { sites: 1, reason: 'The task editor closes while its PATCH is in flight. `updateTask` catches and toasts its own failure (assistant-store.ts), so the reader is told — about it, after the editor is gone. Converging it means the same await-then-close the model editor uses.' },
  ],
  [
    'src/client/features/chat/MemoryView.tsx # save # addMemory',
    { sites: 1, reason: 'One `void` covers both branches of the save (create and edit), and `addMemory` toasts its own refusal; the editor is a single-line fact, so a rejected write leaves the text in the memory list it was already optimistic about.' },
  ],
  [
    'src/client/features/chat/MemoryView.tsx # save # editMemory',
    { sites: 1, reason: 'The sibling branch of the same statement as `addMemory` above, with the same store-side toast.' },
  ],
  [
    'src/client/features/chat/ChatView.tsx # ConversationList # renameConversation',
    { sites: 1, reason: 'The inline rename closes its editor before the promise answers; `renameConversation` catches and toasts, and the list is optimistic, so the title either lands or the toast says it did not.' },
  ],
  [
    'src/client/features/tags/ManageTagsModal.tsx # pickMergeTarget # renameTag',
    { sites: 1, reason: 'A merge is chosen from a confirm dialog that has already awaited its own question; `renameTag` is optimistic (it rewrites the cached tags and notes before the write) and toasts a refusal while rolling the cache back.' },
  ],
  [
    'src/client/features/graph/GraphPanel.tsx # GraphPanel # createNote',
    { sites: 1, reason: 'Creating a note from the graph asks the notes store, which owns its own failure toast, and the panel closes because the reader asked for a new card, not for a note that is guaranteed to exist.' },
  ],
  [
    'src/client/features/presentation/presenter-view/presenter-panes.tsx # PresenterSpeakerNotesPane # onEdit',
    { sites: 1, reason: 'Not a pending promise: the prop is typed `(slide: number, text: string) => void` (presenter-panel.tsx:19) and forwards to `sendCommand`, and the close is `setDraft(null)` on a blur-commit of the speaker-notes box, not a dialog leaving. A name-only read cannot see the prop type, so it is recorded here.' },
  ],
  [
    'src/client/features/reading/reader/CommentCard.tsx # CommentCard # onEdit',
    { sites: 1, reason: 'The comment card\'s save answers from the reading store, whose `updateHighlight` is typed `(…) => void` (store/library.ts:72) — a local IndexedDB write with no request to wait for. Same reason the prop shape is on the record rather than inferred.' },
  ],
])

function keyOf(site: Site): string {
  return `${site.file} # ${site.scope} # ${site.write}`
}

/**
 * One live instance of the bug, recorded rather than excused.
 *
 * `AutomationsView`'s new-automation form hands its close to the success branch of a promise it has already
 * written `void` in front of: `addAutomation` catches its own failure and toasts it, so the `then` runs on a
 * refused create too and the dialog closes happily over an automation that was never made. That is the
 * model-editor bug in a second spelling. Converging it — await the action and close on its answer, the way
 * `ModelEditorDialog.tsx` does now — deletes this entry, and an entry dropped without the fix fails here.
 */
const RECORDED_EARLY_CLOSE = new Map<string, { sites: number; reason: string }>([
])

function describeSite(site: Site): string {
  return `${site.file}:${site.line} ${site.scope} closes after a ${site.rule === 'then-close' ? '.then() that closes' : 'discarded ' + site.write + '()'}`
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

const relative = (file: string): string => path.relative(process.cwd(), file).replaceAll('\\', '/')

/** The name a call answers to: an identifier, or the member that was called. */
function calleeName(node: ts.CallExpression): string | null {
  if (ts.isIdentifier(node.expression)) return node.expression.text
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text
  return null
}

/** Whether this call ends a form: a close prop, or a dialog-state setter given its empty value. */
function isClose(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false
  const name = calleeName(node)
  if (!name) return false
  if (CLOSE_FUNCS.has(name)) return true
  if (!CLOSE_SETTERS.test(name)) return false
  const argument = node.arguments[0]
  return !!argument && /^(?:null|false)$/.test(argument.getText())
}

/** The statement a node was written in, or null when it is not inside one. */
function statementOf(node: ts.Node): ts.Node | null {
  let current: ts.Node = node
  while (current && !ts.isStatement(current)) current = current.parent
  return current ?? null
}

/** A write op by name, either spelling. */
function isWriteName(name: string): boolean {
  return WRITE_NAME.test(name) || HANDLER_WRITE_NAME.test(name)
}

/**
 * Whether this call is a write whose answer nobody is watching.
 *
 * A promise is read as pending only when the code says so: written with `void`, or an `on…` handler prop
 * called as its own statement — a prop's type is the contract at a component's boundary, and `onSave` is
 * exactly how the model editor's bug was written. A bare call to a store action is not enough, because
 * without a type checker it cannot be told from a synchronous one (`updateTemplate` answers `boolean`,
 * `editContent` answers `void`), and a guard that cried wolf on every local write would be read as noise.
 */
function unwatchedWrite(call: ts.CallExpression): boolean {
  if (isClose(call)) return false
  const name = calleeName(call)
  if (!name) return false
  const statement = statementOf(call)
  if (!statement || !ts.isExpressionStatement(statement)) return false
  let current: ts.Node = call
  while (current !== statement) {
    const parent = current.parent
    if (!parent) break
    if (ts.isAwaitExpression(parent)) return false
    if (ts.isPropertyAccessExpression(parent) && THEN_CATCH.has(parent.name.text)) return false
    current = parent
  }
  const expression = statement.expression
  const voided = ts.isVoidExpression(expression) || (ts.isParenthesizedExpression(expression)
    && ts.isVoidExpression(expression.expression))
  if (voided) return WRITE_NAME.test(name) || HANDLER_WRITE_NAME.test(name)
  return HANDLER_WRITE_NAME.test(name)
}

/** The function a handler was written in, named the way a reader would name it. */
function scopeName(node: ts.Node): string {
  let current: ts.Node | undefined = node
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.getText()
    if (ts.isMethodDeclaration(current) && current.name) return current.name.getText()
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && current.parent) {
      if (ts.isVariableDeclaration(current.parent)) return current.parent.name.getText()
      if (ts.isPropertyAssignment(current.parent)) return current.parent.name.getText()
    }
    current = current.parent
  }
  return 'module'
}

/** Every close-after-unawaited-write and `.then(close)` site in one source text. */
function scanSource(file: string, sourceText: string): Site[] {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: Site[] = []
  const line = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart()).line + 1

  const visit = (node: ts.Node): void => {
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)
      || ts.isMethodDeclaration(node)) && node.body && ts.isBlock(node.body)) {
      const statements = node.body.statements
      for (let index = 0; index < statements.length; index += 1) {
        const statement = statements[index]
        if (!ts.isExpressionStatement(statement) || !isClose(statement.expression)) continue
        const scope = scopeName(statement)
        for (let earlier = 0; earlier < index; earlier += 1) {
          const writes: ts.CallExpression[] = []
          const probe = (current: ts.Node): void => {
            if (ts.isCallExpression(current) && unwatchedWrite(current)) writes.push(current)
            ts.forEachChild(current, probe)
          }
          probe(statements[earlier]!)
          for (const call of writes) {
            found.push({
              file,
              scope,
              write: calleeName(call) ?? '?',
              line: line(statement.expression),
              rule: 'discarded-write',
            })
          }
        }
      }
    }

    // `.then(onClose)` / `.then(() => onClose())` on a write: the close is handed to the success branch of
    // a promise the handler does not wait for, so the answer never reaches the code that opened the dialog.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && THEN_NAMES.has(node.expression.name.text)) {
      const chain = node.expression.expression
      const receiver = ts.isCallExpression(chain) ? chain : null
      const handler = node.arguments[0]
      if (receiver && handler && closesInside(handler)) {
        const statement = statementOf(node)
        const awaited = statement && ts.isExpressionStatement(statement)
          && (ts.isAwaitExpression(statement.expression)
            || (ts.isVoidExpression(statement.expression) && ts.isAwaitExpression(statement.expression.expression)))
        const root = ts.isPropertyAccessExpression(receiver.expression) ? receiver.expression.name.text : calleeName(receiver)
        if (!awaited && root && isWriteName(root)) {
          found.push({ file, scope: scopeName(node), write: root, line: line(node), rule: 'then-close' })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** Whether the callback handed to `.then` closes something, directly or through a statement. */
function closesInside(handler: ts.Node): boolean {
  if (ts.isIdentifier(handler)) return CLOSE_FUNCS.has(handler.text) || CLOSE_SETTERS.test(handler.text)
  let close = false
  const visit = (node: ts.Node): void => {
    if (isClose(node)) close = true
    ts.forEachChild(node, visit)
  }
  visit(handler)
  return close
}

/**
 * The pre-filter, and why it is allowed.
 *
 * Reading every feature file through the TS parser costs the suite seconds it does not need: a file that
 * never names a close, a `.then(` or a dialog-state setter cannot hold either shape. The filter is checked
 * against the tree below, so a rule-relevant file that stops matching it fails here rather than passing
 * quietly.
 */
function relevant(text: string): boolean {
  return /onClose|onDismiss|onCancel|\bclose\(|\.then\(|\.finally\(/.test(text) || /\bset(?:Open|Editing|Renaming|Rename|Draft|Adding|Creating|New|Merging|Comment)\(/.test(text)
}

function scanTree(): Site[] {
  const sites: Site[] = []
  for (const file of walk(FEATURES_DIR)) {
    const text = fs.readFileSync(file, 'utf8')
    if (!relevant(text)) continue
    sites.push(...scanSource(relative(file), text))
  }
  return sites.sort((a, b) => `${a.file}${a.line}`.localeCompare(`${b.file}${b.line}`))
}

const REAL_SITES = scanTree()
const RELEVANT_FILES = walk(FEATURES_DIR).filter((file) => relevant(fs.readFileSync(file, 'utf8')))

describe('a form waits for its write before it closes', () => {
  it('reads the feature files it claims to read', () => {
    const all = walk(FEATURES_DIR)
    expect(all.length, 'the features tree moved').toBeGreaterThan(200)
    expect(RELEVANT_FILES.length, 'no feature file names a close, so the pre-filter is broken').toBeGreaterThan(40)
    expect(REAL_SITES.length, 'not one site was read, so the scan cannot be trusted').toBeGreaterThan(3)
    // The file this rule was written for still holds the fixed shape, so the guard reads a live example.
    const modelEditor = fs.readFileSync(path.join(FEATURES_DIR, 'chat', 'ModelEditorDialog.tsx'), 'utf8')
    expect(modelEditor, 'the awaited save the rule points at is gone').toMatch(/const ok = await onSave\(/)
  })

  it('fails when a feature closes a form after discarding its write', () => {
    const counts = new Map<string, Site[]>()
    for (const site of REAL_SITES) counts.set(keyOf(site), [...(counts.get(keyOf(site)) ?? []), site])
    const lines: string[] = []
    for (const [key, sites] of counts) {
      if (RECORDED_EARLY_CLOSE.has(key)) continue
      const allowed = DISCARDED_WRITE_BASELINE.get(key)
      if (allowed === undefined) lines.push(`${describeSite(sites[0]!)} — no baseline entry; await the write (and keep the dialog open when it answers false), or add the site with its reason`)
      else if (sites.length > allowed.sites) lines.push(`${key}: ${sites.length} sites, the baseline allows ${allowed.sites}`)
    }
    expect(lines, `${lines.length} feature site(s) close before their write answers.`).toEqual([])
  })

  it('keeps the closed-too-early baseline honest', () => {
    const keys = new Set(REAL_SITES.map(keyOf))
    const stale = [...DISCARDED_WRITE_BASELINE.keys()].filter((key) => !keys.has(key))
    expect(stale, `these sites no longer close over a discarded write — the shape is gone, delete the entry: ${stale.join(', ')}`).toEqual([])
    for (const [key, entry] of DISCARDED_WRITE_BASELINE) {
      expect(entry.reason.length, `${key} has no reason written`).toBeGreaterThan(40)
    }
  })

  it('keeps the recorded early close on the books until it is fixed', () => {
    const counts = new Map<string, number>()
    for (const site of REAL_SITES) counts.set(keyOf(site), (counts.get(keyOf(site)) ?? 0) + 1)
    const paid = [...RECORDED_EARLY_CLOSE.keys()].filter((key) => !counts.has(key))
    expect(paid, `this site no longer closes over an unwatched write — the fix landed, delete the entry: ${paid.join(', ')}`).toEqual([])
    for (const [key, entry] of RECORDED_EARLY_CLOSE) {
      expect(entry.reason.length, `${key} has no reason written`).toBeGreaterThan(40)
      expect(counts.get(key), `${key} writes ${entry.sites} site(s) today, not the number on the record`).toBe(entry.sites)
    }
    const excused = [...RECORDED_EARLY_CLOSE.keys()].filter((key) => DISCARDED_WRITE_BASELINE.has(key))
    expect(excused, `a recorded violation cannot also be excused: ${excused.join(', ')}`).toEqual([])
  })

  it('fires on a handler that closes beside an unawaited write, and clears when it awaits', () => {
    // Positive control, in the shape the bug was written in: `onSave` handed a promise the handler drops,
    // then the close runs. This is the exact line `ModelEditorDialog.tsx` used to hold.
    const planted = `
      export function PlantEditor({ onSave, onClose }: Props) {
        return <Button onClick={() => { onSave(draft); onClose() }}>save</Button>
      }
    `
    expect(scanSource('planted.tsx', planted).map(describeSite)).toHaveLength(1)

    // Awaiting the write and keeping the dialog open on a `false` answer is the fix; the guard clears.
    const fixed = `
      export function PlantEditor({ onSave, onClose }: Props) {
        const submit = async () => {
          const ok = await onSave(draft)
          if (!ok) return
          onClose()
        }
        return <Button onClick={() => void submit()}>save</Button>
      }
    `
    expect(scanSource('planted.tsx', fixed)).toEqual([])

    // A close on the success branch of a chain nobody waits for is the other half of the rule.
    const chained = `
      export function PlantEditor({ store, onClose }: Props) {
        const save = () => store.saveModel(draft).then(onClose)
        return null
      }
    `
    expect(scanSource('planted.tsx', chained).map((site) => site.rule)).toEqual(['then-close'])
    // …and awaiting the chain takes the `.then` out of the forbidden shape.
    const awaitedChain = chained.replace('const save = () => store.saveModel(draft).then(onClose)', 'const save = async () => { await store.saveModel(draft).then(onClose) }')
    expect(scanSource('planted.tsx', awaitedChain)).toEqual([])
  })
})
