// @vitest-environment node
/**
 * Nothing that only *shows* a note may run one.
 *
 * A share page, an exported HTML file, a print frame, a deck, an RSS feed, an assistant transcript and the
 * note's own preview all render text a reader did not choose to execute. Templater templates are live code:
 * `<% tp.file.content %>` is a program, and a renderer that runs one turns "someone shared a link" into
 * "someone ran code against the vault of whoever opened it". The plan's §7.4 and §7.6 make that a red line,
 * so it needs a guard that reads the shipped graph rather than a comment that promises intent.
 *
 * The guard is structural. The interpreter sits behind exactly one module — `src/client/lib/templater/index.ts`
 * — and everything that can start a run (`renderTemplate`, `configureTemplater`, `installTemplaterHost`) is
 * exported from it. So "this surface cannot execute a template" is one question: can this file reach that
 * door, or reach anything the door is built from? A file that never resolves a specifier into
 * `lib/templater/` or `features/templater/` cannot.
 *
 * A full dependency graph is not what this checks — this project adds no dependencies and is not going to
 * gain one for a guard, and a transitive walk would need a resolver per alias. What it does instead is
 * stronger for the surfaces that matter and cheap to keep true: it pins the *complete* set of shipped client
 * modules that reference the sandbox at all (a new name anywhere in `src/client` fails this run), and it
 * asserts each rendering surface references none. The door has exactly one reacher and reaches it with
 * `await import()`, which is the same mechanism that keeps the worker, the wasm and moment off the first
 * screen — `tests/templater-offline-footprint.test.ts` measures that half against the built bundle.
 *
 * Specifiers are read out of `import … from '…'`, bare `import '…'`, `export … from '…'` and `import('…')`,
 * the way `tests/templater-protocol-purity.test.ts` reads them: prose that merely names a `features/…` file
 * in a comment must not turn this off, and a guard that fires on comments gets deleted within a week.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { posix } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Everything below is compared against repository-relative, forward-slash paths. */
const slash = (value: string) => value.replace(/\\/g, '/')

/** The shipped modules under a directory, tests left out: they are not in the bundle. */
function shippedSources(directory: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = slash(`${directory}/${entry.name}`)
    if (entry.isDirectory()) found.push(...shippedSources(full))
    else if (/\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(full)
  }
  return found.sort()
}

/** Where a specifier lands, in repository terms, or `null` when it is a package. */
function resolveSpecifier(specifier: string, importer: string): string | null {
  // The two aliases the client uses are resolved here rather than by a bundler: `@/` is `src/client` and
  // `@shared/` is `src/shared`, which is the difference between catching `@/lib/templater` and missing it.
  if (specifier.startsWith('@/')) return posix.normalize(`src/client/${specifier.slice(2)}`)
  if (specifier.startsWith('@shared/')) return posix.normalize(`src/shared/${specifier.slice(8)}`)
  if (!specifier.startsWith('.')) return null
  return posix.normalize(posix.join(posix.dirname(importer), specifier))
}

type Edge = { specifier: string, form: 'static' | 'type' | 'dynamic' | 'reexport', resolved: string }

/** Every module a file pulls in, with the kind of edge it is. Source may be handed in for the control case. */
function edgesOf(path: string, source = readFileSync(path, 'utf8')): Edge[] {
  const edges: Edge[] = []
  const push = (specifier: string, form: Edge['form']) => {
    const resolved = resolveSpecifier(specifier, path)
    if (resolved) edges.push({ specifier, form, resolved })
  }
  for (const match of source.matchAll(/import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g)) push(match[1]!, 'dynamic')
  // The binding list of an `import`/`export … from` never holds a quote, so excluding quotes from it is what
  // keeps a lazy `[\s\S]*?` from hopping over one statement into the next statement's `from`.
  // `import type` is recorded as its own form: it is erased before bundling, so it cannot ship the sandbox
  // onto the first screen — but it is still a reference, and the allowlist has to see it.
  for (const match of source.matchAll(/(?:^|[\n;{}])\s*import\s+(type\s+)?[^'"]*?\bfrom\s*['"`]([^'"`]+)['"`]/g)) {
    push(match[2]!, match[1] ? 'type' : 'static')
  }
  // `import 'x'` with no bindings still ships the module, so it still counts as an edge.
  for (const match of source.matchAll(/(?:^|[\n;{}])\s*import\s*['"`]([^'"`]+)['"`]/g)) push(match[1]!, 'static')
  for (const match of source.matchAll(/(?:^|[\n;{}])\s*export\s+[^'"]*?\bfrom\s*['"`]([^'"`]+)['"`]/g)) push(match[1]!, 'reexport')
  return edges
}

const SANDBOX = ['src/client/lib/templater/', 'src/client/features/templater/']
const isSandboxEdge = (edge: Edge) => SANDBOX.some((prefix) => `${edge.resolved}/`.startsWith(prefix))
const reachesDoor = (edge: Edge) => edge.resolved === 'src/client/lib/templater/index'
  || edge.resolved === 'src/client/lib/templater'

/** The names that start a run. Called from a renderer, a note becomes code. */
const EXECUTORS = ['renderTemplate', 'configureTemplater', 'installTemplaterHost', 'runTemplaterHooks', 'cancelTemplateRun']

/** §7.6's list of surfaces that show text and may not execute it. */
const SURFACES: Array<{ name: string, paths: string[] }> = [
  { name: 'a public share page', paths: ['src/client/features/share'] },
  { name: 'the note preview renderer', paths: ['src/client/features/preview'] },
  { name: 'the assistant transcript and its artifacts', paths: ['src/client/features/chat'] },
  { name: 'the markdown engine all of them render with', paths: ['src/client/lib/markdown'] },
  { name: 'the HTML and PDF export, with its print frame', paths: ['src/client/lib/export-note.ts'] },
  { name: 'the deck printer and the deck exporter', paths: ['src/client/features/presentation'] },
  { name: 'the feed and its printed view', paths: ['src/client/features/rss', 'src/client/lib/rss'] },
  { name: "QuickAdd's older {{}} template path", paths: ['src/client/lib/quickadd', 'src/client/features/quickadd'] },
]

function surfaceFiles(paths: string[], surface: string): string[] {
  const files: string[] = []
  for (const path of paths) {
    expect(existsSync(path), `${surface} points at ${path}, which is gone — the guard would guard nothing`).toBe(true)
    if (statSync(path).isDirectory()) files.push(...shippedSources(path))
    else files.push(path)
  }
  return files.sort()
}

/**
 * Every shipped client module outside the sandbox that references it, and what it is allowed to want.
 *
 * This is the whole of the port's reachability, so the list is a lock: a new importer anywhere in
 * `src/client` fails this run until it is argued for here, and an entry that stops importing the sandbox has
 * to be deleted from here. Each name is the wiring or the authoring path; none is a renderer.
 */
const ALLOWED_IMPORTERS: Record<string, string> = {
  'src/client/App.tsx': 'mounts the command wiring, the file-creation trigger and the start-up bridge',
  'src/client/editor/templater.ts': 'highlights template syntax in the note the reader is writing',
  'src/client/editor/templater-completion.ts': 'offers completions from the syntax reference',
  'src/client/features/command/registry.ts': 'registers the four commands and the cursor-jump key',
  'src/client/features/templates/gallery-modals.tsx': 'mounts the template code editor the gallery opens',
  'src/client/features/templates/template-gallery.tsx': 'hosts the chooser that raises the library',
  'src/client/features/workspace/Workspace.tsx': 'hands the note editor the `tp.user` completion source, which reaches the store only through `features/templater/script-completion.ts` behind a dynamic import',
}

function sandboxImporters(): Map<string, Edge[]> {
  const hits = new Map<string, Edge[]>()
  for (const file of shippedSources('src/client')) {
    if (SANDBOX.some((prefix) => `${file}/`.startsWith(prefix))) continue
    const edges = edgesOf(file).filter(isSandboxEdge)
    if (edges.length) hits.set(file, edges)
  }
  return hits
}

/**
 * Every shipped module that names the door, including the sandbox's own files.
 *
 * `sandboxImporters()` deliberately skips everything under the two prefixes, which would also hide the one
 * file that is allowed to open the door — so this walks the whole tree and reports edges instead of importers.
 */
function doorReachability(): Array<{ file: string, specifier: string, form: Edge['form'] }> {
  const found: Array<{ file: string, specifier: string, form: Edge['form'] }> = []
  for (const file of shippedSources('src/client')) {
    for (const edge of edgesOf(file)) {
      if (reachesDoor(edge)) found.push({ file, specifier: edge.specifier, form: edge.form })
    }
  }
  return found
}

describe('a surface that shows a note cannot run a template', () => {
  for (const surface of SURFACES) {
    const files = surfaceFiles(surface.paths, surface.name)
    it(`keeps the sandbox out of ${surface.name}`, () => {
      expect(files.length, `${surface.name} has no shipped module left to check`).toBeGreaterThan(0)
      for (const file of files) {
        for (const edge of edgesOf(file)) {
          expect(
            isSandboxEdge(edge),
            `${file} reaches the template sandbox through '${edge.specifier}' `
            + `(${edge.form} -> ${edge.resolved}); ${surface.name} renders text it must not execute`,
          ).toBe(false)
        }
        const source = readFileSync(file, 'utf8')
        for (const name of EXECUTORS) {
          // Matched as a call site, not as a word: a comment may name `renderTemplate` honestly, a page may not run it.
          expect(
            new RegExp(`\\b${name}\\s*\\(`).test(source),
            `${file} calls ${name}(), which starts a template run`,
          ).toBe(false)
        }
      }
    })
  }
})

describe('the door has one reacher, and only the wiring touches the sandbox', () => {
  const imports = sandboxImporters()

  it('observes the sandbox from a bounded list of shipped modules', () => {
    const found = [...imports.keys()].sort()
    expect(found.length, 'no shipped module references the sandbox at all — the guard lost its subject')
      .toBeGreaterThan(0)
    const unexpected = found.filter((file) => !(file in ALLOWED_IMPORTERS))
    expect(
      unexpected,
      `new shipped modules reach the template sandbox: ${unexpected.join(', ')}. Argue each into `
      + `ALLOWED_IMPORTERS, which records why the listed ones are allowed: `
      + JSON.stringify(ALLOWED_IMPORTERS, null, 2),
    ).toEqual([])
    const stale = Object.keys(ALLOWED_IMPORTERS).filter((file) => !found.includes(file))
    expect(
      stale,
      `these modules no longer reference the sandbox, so the allowlist is carrying dead entries and the next `
      + `author will read it as a formality: ${stale.join(', ')} — delete them`,
    ).toEqual([])
  })

  it('keeps the interpreter door behind a single dynamic import', () => {
    const reachers = doorReachability()
    const offenders = reachers.filter((entry) => entry.file !== 'src/client/features/templater/run-shell.ts')
    expect(offenders, `a module outside the run shell imports the door: ${JSON.stringify(offenders)}`).toEqual([])
    // And even there, never as a shipped edge: `import type` is erased, `await import()` is a separate chunk,
    // and a static one would put the interpreter, the worker chunk and the wasm into the entry's own graph —
    // which is the first screen and the offline shell.
    const shipped = reachers.filter((entry) => entry.form === 'static' || entry.form === 'reexport')
    expect(shipped, `the door is imported statically, so the sandbox ships on the first screen: ${JSON.stringify(shipped)}`)
      .toEqual([])
    expect(reachers.length, 'nothing reaches the door any more — the guard has lost its subject').toBeGreaterThan(0)
  })

  it('keeps the authoring surface away from the host and the interpreter', () => {
    // The editor is the one allowlisted importer whose code runs on every keystroke, so its reach is pinned
    // narrower: the parser, the capability table and the syntax reference — never a host call, never the worker.
    for (const file of ['src/client/editor/templater.ts', 'src/client/editor/templater-completion.ts']) {
      const edges = imports.get(file) ?? []
      expect(edges.length, `${file} no longer imports the sandbox — update this guard`).toBeGreaterThan(0)
      for (const edge of edges) {
        expect(edge.resolved, `${file} reaches the page host through ${edge.specifier}`).not.toContain('/host/')
        expect(edge.resolved, `${file} reaches the worker through ${edge.specifier}`).not.toContain('/worker/')
        expect(reachesDoor(edge), `${file} reaches the door through ${edge.specifier}`).toBe(false)
      }
    }
  })

  it('catches the violation it exists to catch', () => {
    // The matcher is this guard's teeth, so it is proved on text shaped like a real mistake instead of being
    // trusted because the tree happens to be clean today.
    const violating = [
      "import { renderTemplate } from '../../lib/templater'",
      "import '../../lib/templater/worker/client'",
      "export { createTemplateRunId } from '../../lib/templater/run-id'",
      "const door = await import('../../lib/templater')",
      'const out = await renderTemplate(request)',
      '// A comment that only names configureTemplater must not be read as a call.',
    ].join('\n')
      + '\n'
    const edges = edgesOf('src/client/features/share/SharePage.tsx', violating)
    expect(edges.filter(isSandboxEdge).map((edge) => edge.form).sort())
      .toEqual(['dynamic', 'reexport', 'static', 'static'])
    expect(edges.filter(reachesDoor).map((edge) => edge.form).sort()).toEqual(['dynamic', 'static'])
    expect(EXECUTORS.filter((name) => new RegExp(`\\b${name}\\s*\\(`).test(violating))).toEqual(['renderTemplate'])
    // The prose half of the same text names an executor without calling it, which is what keeps this guard
    // out of the "delete me within a week" category the purity guard's header warns about.
    expect(/configureTemplater\s*\(/.test('// A comment that only names configureTemplater must not')).toBe(false)
  })
})
