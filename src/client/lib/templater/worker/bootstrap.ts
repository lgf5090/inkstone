/**
 * The world a template sees, and nothing else.
 *
 * QuickJS gives an interpreter the standard library and no environment: no `window`, no `fetch`, no
 * `Worker`, no filesystem, no `require`. That is the whole reason this package exists instead of `new
 * Function` — but the namespace Templater's language promises still has to be *built*, and built so that
 * the nine names a template may speak are the only names it may speak. Everything here is therefore in
 * service of one list: `tp`, `app`, `obsidian`, `moment`, `console`, `TFile`, `TFolder`, `tR`, `__host`.
 * Helpers live inside the prelude's own closure and are handed back to TypeScript as handles that were
 * never assigned to a global, so "and only that" is a property of the machine rather than a claim in a
 * comment: `bootstrap.test.ts` reads the difference between an empty context's globals and this one's and
 * asserts that the difference is exactly those nine names.
 *
 * Three things are VM-side by necessity rather than preference.
 *
 * - `TFile`/`TFolder` are classes *defined inside the interpreter*, and host data is hydrated into them.
 *   Upstream's own documentation tells template authors to write `x instanceof tp.obsidian.TFolder`, and a
 *   host-side class handed over as a handle would make that test silently false — prototype chains do not
 *   cross the boundary. Hydrating from plain records is also what keeps a store handle out of the box.
 * - `moment` is loaded as source text, not as a host import. Its UMD wrapper attaches itself to `this`, and
 *   the locale file reads `global.moment` afterwards, so the core has to be evaluated first and both have
 *   to run in global code, where `this` is the interpreter's own global object. A template's
 *   `moment().format('Do MMMM')` and `tp.date` then share one instance, which is the only way chained
 *   calls, ISO durations and Chinese month names behave the way the reference panel says they do.
 * - The note index travels as one JSON table. `tp.config.target_file`, `folder.children` and lookup by
 *   title are synchronous in Obsidian, so they cannot be a round trip to the page; the snapshot the run
 *   arrived with already holds them, and hydrating on demand keeps a large vault off the heap until a
 *   template actually asks for it.
 */
import momentCoreSource from 'moment/min/moment.min.js?raw'
import momentZhCnSource from 'moment/locale/zh-cn.js?raw'
import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten-core'
import type { TemplateRunContext } from '../protocol'
import { capabilitiesFor } from '../protocol'
import type { VmMarshalling } from './host-bindings'
import { MAX_LOG_CHARS, MAX_LOG_LINES } from '../limits'

/**
 * The namespace, as one self-contained expression.
 *
 * It evaluates to an object of the things TypeScript needs to reach, and it installs nothing itself: the
 * caller assigns each allowed name onto the global. So the prelude's internals — `hostError`, the index
 * table, the hook list, `jsonToValue` — are not globals and cannot be named by a template, while the
 * classes and wrappers that *are* exposed reach them through the closure.
 *
 * No part of this string is ever built from template text or from snapshot data. Values cross as JSON
 * through `jsonToValue`, which is why this file can be read as trusted code rather than as an injection
 * point.
 */
const PRELUDE = `(() => {
  const jsonToValue = (text) => text === null ? null : JSON.parse(text)

  // An error the template can name: \`code\` is the token the interface translates, and the message keeps
  // the same "code: detail" shape the worker uses, so one reading works on both sides of the boundary.
  const hostError = (code, detail) => {
    const error = new Error(detail === undefined || detail === null ? code : code + ':' + detail)
    error.name = 'TemplaterError'
    error.code = code
    if (detail !== undefined && detail !== null) error.detail = detail
    return error
  }

  const callHost = (method, args) => {
    if (typeof __host !== 'object' || __host === null) throw hostError('sandbox-unavailable', method)
    return __host.call(method, args)
  }

  // Obsidian keeps file times as a 'YYYYMMDDHHMMSS' string and Templater feeds that string straight to
  // moment(), which reads it as ISO 8601 basic. Producing the same shape here is what makes
  // tp.file.creation_date() behave like the reference panel says, instead of merely looking right.
  const stamp = (epoch) => (typeof epoch === 'number' && isFinite(epoch)
    ? moment(epoch).format('YYYYMMDDHHMMSS') : '')

  // What the run was told about itself before any template text ran: the instant the page took, the
  // reader's language, and the selection the reader had made. Installed with the snapshot, because a
  // template must not be able to move any of the three, and \`tp.file.selection()\` has to answer the
  // selection the run *began* with rather than whatever the reader dragged over while it was running.
  const run = { startedAt: 0, locale: '', selection: '' }

  // Upstream reads a live clock; this port reads the one instant the page took, which is what
  // \`TemplateRunContext.startedAt\` exists for — without it two commands in one template can straddle
  // midnight and disagree about today.
  const nowMoment = () => (run.startedAt ? moment(run.startedAt) : moment())

  const basenameOf = (path) => {
    const text = String(path ?? '')
    return text.slice(text.lastIndexOf('/') + 1)
  }

  const extensionOf = (path) => {
    const name = basenameOf(path)
    const dot = name.lastIndexOf('.')
    return dot <= 0 ? '' : name.slice(dot + 1)
  }

  const withoutExtension = (path) => {
    const name = basenameOf(path)
    const dot = name.lastIndexOf('.')
    return dot <= 0 ? name : name.slice(0, dot)
  }

  const normalizePath = (path) => {
    if (typeof path !== 'string') return ''
    return path.replace(/\\\\/g, '/').replace(/^\\/+|\\/+$/g, '').replace(/\\/+/g, '/')
  }

  const parseLinktext = (linktext) => {
    const parts = String(linktext ?? '').split('#')
    const path = parts.shift() ?? ''
    if (parts.length === 0) return { path, subpath: null }
    const target = parts.join('#')
    const type = target[0] === '^' ? 'block-id' : 'heading'
    return { path, subpath: { type, target: type === 'block-id' ? target.slice(1) : target } }
  }

  // Obsidian's \`getAllTags\` answers a note's tags with their \`#\` still on them, and null when it has
  // none. The snapshot carries the names bare — computed host-side off the body and the frontmatter the
  // same way Obsidian does — so this only puts the mark back and keeps upstream's null.
  const withTagMark = (name) => {
    const text = String(name)
    return text[0] === '#' ? text : '#' + text
  }

  const getAllTags = (cache) => {
    const names = cache && Array.isArray(cache.tags) ? cache.tags : null
    if (!names || names.length === 0) return null
    return names.map(withTagMark)
  }

  // Upstream's inclusion guard, at the same number: \`InternalModuleFile.ts\` counts depth per run and
  // throws past ten, and its spec pins both the tenth level and the eleventh.
  const DEPTH_LIMIT = 10

  // Every note this app stores is Markdown, which is what \`context/file-wrapper.ts\` calls
  // MARKDOWN_EXTENSION. It is spelled again here rather than imported because the worker half may not
  // reach into a page module at all — the rule \`tests/templater-protocol-purity.test.ts\` reads off the graph.
  const MARKDOWN = 'md'

  // The three characters a note name cannot hold. Upstream's \`tp.file.rename\` refuses them before it moves
  // anything (\`InternalModuleFile.ts:281\`), and this app's tree reads a \`/\` as a folder and a \`:\` as a
  // drive, so the refusal is the same one for the same reason. Kept apart from \`normalizePath\` because a
  // name is not a path: folding the separators away would silently turn one refused name into another.
  const FORBIDDEN_IN_NAME = /[\\\\/:]+/

  const LINK_PATTERN = /^\\[\\[(.*)\\]\\]$/

  // The run's own note table, filled by TypeScript from the snapshot. It is data, not objects: entries are
  // looked up by path and hydrated on demand, so asking for one folder does not build twenty thousand files.
  const index = { notes: [], folders: [], templates: [], target: null, active: null, template: null }

  // One instance per path, so \`a === b\` and \`instanceof\` both hold for the same note asked for twice.
  const instances = new Map()

  class TAbstractFile {
    constructor(path, name) {
      this.path = path
      this.name = name
    }
    get parent() {
      const cut = this.path.lastIndexOf('/')
      if (cut === -1) return folderOf({ path: '', name: '' })
      const parentPath = this.path.slice(0, cut)
      const entry = index.folders.find((folder) => folder.path === parentPath)
      return folderOf(entry ?? { path: parentPath, name: basenameOf(parentPath) })
    }
  }

  class TFile extends TAbstractFile {
    constructor(data) {
      super(data.path, data.name ?? basenameOf(data.path))
      this.basename = data.basename ?? withoutExtension(data.path)
      this.extension = data.extension ?? extensionOf(data.path)
      this.stat = {
        ctime: stamp(data.createdAt),
        mtime: stamp(data.updatedAt),
        ctimeMs: typeof data.createdAt === 'number' ? data.createdAt : 0,
        mtimeMs: typeof data.updatedAt === 'number' ? data.updatedAt : 0,
        size: typeof data.size === 'number' ? data.size : (typeof data.content === 'string' ? data.content.length : 0),
        type: 'file',
      }
      this.content = typeof data.content === 'string' ? data.content : ''
      this.frontmatter = data.frontmatter ?? null
      this.tags = Array.isArray(data.tagNames) ? data.tagNames.slice() : []
      this.empty = data.isEmpty === true
    }
    get folder() {
      return this.parent
    }
    isFolder() {
      return false
    }
    async rename(name) {
      const answer = await callHost('note.rename', [this.path, name])
      return answer && typeof answer === 'object' ? hydrate(answer) : this
    }
    async delete() {
      return callHost('note.delete', [this.path])
    }
  }

  class TFolder extends TAbstractFile {
    constructor(path, name) {
      super(path, name ?? basenameOf(path))
    }
    isFolder() {
      return true
    }
    get children() {
      const prefix = this.path === '' ? '' : this.path + '/'
      const built = []
      for (const note of index.notes) {
        if (note.path.startsWith(prefix) && note.path.slice(prefix.length).indexOf('/') === -1) built.push(fileOf(note))
      }
      for (const folder of index.folders) {
        if (folder.path !== this.path && folder.path.startsWith(prefix) && folder.path.slice(prefix.length).indexOf('/') === -1) {
          built.push(folderOf(folder))
        }
      }
      return built
    }
  }

  const fileOf = (data) => {
    if (!data) return null
    const known = instances.get(data.path)
    if (known instanceof TFile) return known
    const built = new TFile(data)
    instances.set(data.path, built)
    return built
  }

  const folderOf = (data) => {
    if (!data) return null
    const path = data.path ?? ''
    const known = instances.get(path)
    if (known instanceof TFolder) return known
    const built = new TFolder(path, data.name ?? basenameOf(path))
    instances.set(path, built)
    return built
  }

  // Hydration from the wire: the worker's plain records become instances of the classes above, so
  // \`instanceof tp.obsidian.TFile\` and \`instanceof tp.obsidian.TFolder\` answer for real.
  const hydrate = (data) => {
    if (data === null || typeof data !== 'object') return null
    if (data.kind === 'folder' || (data.children !== undefined && data.basename === undefined)) return folderOf(data)
    return fileOf(data)
  }

  // \`tp.file.find_tfile\` takes whatever the template wrote and answers one file, or null.
  //
  // Four shapes have to work because templates write all four: the exact stored path, the path without
  // \`.md\`, a bare basename, and a bare title. The second one is the trap — \`withoutExtension\` answers a
  // *name*, so comparing it against a link that carries a folder (\`Reading/Target\`) never matches, and a
  // lookup that looks correct for root-level notes fails silently for everything filed away.
  const findByTitle = (title) => {
    const wanted = normalizePath(title)
    if (!wanted) return null
    // Library templates are searched by the same three readings, in their own list and after the notes, so
    // a row and a template that read the same name resolve to the note. The index the run arrived with
    // normally holds the projected \`Templates/<name>.md\` row already; the separate list is what keeps a
    // template addressable when the page left it out of the index but sent its body.
    const found = matchEntry(index.notes, wanted) ?? matchEntry(index.templates, wanted)
    return found ? fileOf(found) : null
  }

  const matchEntry = (entries, wanted) => {
    const nameOf = (path) => basenameOf(withoutExtension(path))
    const withExtension = wanted.endsWith('.' + MARKDOWN) ? wanted : wanted + '.' + MARKDOWN
    return entries.find((entry) => entry.path === wanted || entry.path === withExtension)
      ?? entries.find((entry) => nameOf(entry.path) === nameOf(wanted))
      ?? entries.find((entry) => entry.title === nameOf(wanted))
  }

  // \`tp.file.exists()\` and \`tp.file.find_tfile()\` with no argument: upstream hands the argument to
  // Obsidian's \`normalizePath\`, which throws on anything that is not a string. The empty string is left
  // alone, because upstream normalizes it and then genuinely looks for nothing and finds nothing.
  const requirePath = (member, value) => {
    if (typeof value !== 'string') throw hostError('path-invalid', 'tp.' + member)
    return normalizePath(value)
  }

  // How deep the current \`tp.file.include\` chain is. One counter per run, the way upstream holds it on
  // the module rather than passing it down.
  let includeDepth = 0

  // Upstream's second counter (\`InternalModuleFile.ts:22\`), kept separate from the inclusion one exactly as
  // it is there: a \`create_new\` nested inside an \`include\` is not the same recursion as ten includes.
  let createNewDepth = 0

  // The level the render being asked for sits at, counting from 1 — the \`depth\` field of
  // \`RenderIncludeRequest\` in \`../protocol.ts\`. The two counters are summed because they are the only two
  // ways this run can hold a render outstanding at once, and the number describes this run's own stack. The
  // page sums this field with the level it started each nested run at, which is how \`MAX_TEMPLATE_DEPTH\`
  // holds across the chain: each interpreter sees only its own counters, and the depth field is the only
  // way one run's stack reaches the next one's host.
  const renderDepth = () => includeDepth + createNewDepth

  // Asking the page to render one thing into text. This is the half the worker cannot do for itself: it holds
  // no parser and one interpreter per run, so a nested run is started on the page and answered finished.
  // The request is \`RenderIncludeRequest\`: a \`source\` naming a note (with its subpath) or raw text, this
  // run's own stack level, and \`asCreate\` when the render fills a note being created.
  const renderIncluded = async (source, asCreate) => {
    const request = { source, depth: renderDepth() }
    if (asCreate) request.asCreate = asCreate
    const answer = await callHost('note.renderInclude', [request])
    if (!answer || typeof answer !== 'object' || typeof answer.content !== 'string') {
      throw hostError('render-failed', 'note.renderInclude')
    }
    return answer.content
  }

  // \`RenderIncludeRequest\` names a subpath \`{ kind, text }\` and calls a block reference \`block\`, where
  // Obsidian's \`parseLinktext\` — which \`tp.obsidian.parseLinktext\` hands out unchanged — says
  // \`{ type, target }\` and \`block-id\`. Translated here, so the page is spoken to once in its own shape.
  const wireSubpath = (subpath) => (subpath
    ? { kind: subpath.type === 'block-id' ? 'block' : 'heading', text: subpath.target }
    : null)

  // \`tp.file.include\`: upstream resolves the link, reads the file and then *parses the result again* so the
  // commands inside it run (\`InternalModuleFile.ts:158-227\`). Handing back the stored text was the
  // placeholder for the render call that did not exist yet; it is now one call, which is also the only place
  // a \`#Heading\` or a \`#^block\` slice can be cut — upstream cuts it from the note's parse positions
  // (\`:199-211\`), and the snapshot deliberately does not carry those.
  const includeFile = async (include_link) => {
    if (includeDepth >= DEPTH_LIMIT) throw hostError('template-recursion', 'tp.file.include')
    includeDepth += 1
    try {
      const found = includeTargetOf(include_link)
      return await renderIncluded({ kind: 'note', path: found.path, subpath: wireSubpath(found.subpath) })
    } finally {
      includeDepth -= 1
    }
  }

  const includeTargetOf = (include_link) => {
    if (include_link instanceof TFile) {
      return { path: requirePath('file.include', include_link.path), subpath: null }
    }
    const text = String(include_link ?? '')
    const match = LINK_PATTERN.exec(text)
    if (match === null) throw hostError('path-invalid', 'tp.file.include')
    const parsed = parseLinktext(match[1])
    const found = findByTitle(normalizePath(parsed.path))
    if (!found) throw hostError('note-not-found', text)
    return { path: found.path, subpath: parsed.subpath }
  }

  // The folder half of \`tp.file.create_new\`, read the way upstream reads it:
  // \`folder instanceof TFolder ? folder.path : folder\` (\`Templater.ts:169\`). No folder at all is the tree
  // root here, which is upstream's \`root\` reading of the \`newFileLocation\` setting (\`:141-164\`): that
  // setting is the reader's, the frozen contract carries no field for it, and guessing a default folder the
  // page could not name would be worse than filing at the root.
  const folderPathOf = (folder) => {
    if (folder === undefined || folder === null || folder === '') return ''
    if (folder instanceof TFolder) return normalizePath(folder.path)
    if (typeof folder === 'string') return normalizePath(folder)
    throw hostError('path-invalid', 'tp.file.create_new.folder')
  }

  // The path a new note lands on: the folder, the name, and \`.md\` exactly once. Upstream asks Obsidian for
  // an unused path (\`Templater.ts:170-173\`); this app refuses a taken one (\`note-conflict\`, in
  // \`host/page-host.ts\`), so the answer here is the path that was asked for and nothing else. A \`filename\`
  // that carries folders is legal — upstream's own spec files a note at \`notes/sub/leaf-note\` from that one
  // argument (\`file.e2e.ts:1340\`).
  const createPathOf = (folder, filename) => {
    const parent = folderPathOf(folder)
    const wanted = filename ? requirePath('file.create_new', filename) : 'Untitled'
    const combined = normalizePath(parent + '/' + wanted)
    // A name that leaves nothing behind is a mistake in the template, not a note called after its folder.
    if (!wanted || !combined) throw hostError('path-invalid', 'tp.file.create_new')
    return extensionOf(combined).toLowerCase() === MARKDOWN ? combined : combined + '.' + MARKDOWN
  }

  // What one \`create_new\` template argument means: a path to render, or text to render as written.
  //
  // Upstream renders a \`TFile\` it can read (\`Templater.ts:194-203\`) and treats any other argument as the
  // template text itself (\`:204-214\`) — a string is never a name there. This app keeps library templates as
  // rows rather than files, so a string that names one of *those* is read as that row: it is the one case
  // where taking a string for a name is what the reader meant. Anything else stays text, including a string
  // that matches a note, so \`create_new('TODO', 'x')\` cannot silently copy the reader's TODO note.
  //
  // \`null\` is upstream's answer for an argument that is neither: its \`errorWrapper\` around the create and
  // around the render (\`:168-188\`, \`:200-220\`) turns either failure into \`undefined\`, which is why the
  // reference signature reads \`TFile | undefined\`. Naming it beats inventing a code no template was written
  // against.
  const templateSourceOf = (template) => {
    if (template instanceof TFile) {
      const path = requirePath('file.create_new', template.path)
      if (!path) throw hostError('path-invalid', 'tp.file.create_new')
      return { path }
    }
    if (typeof template !== 'string') return null
    const wanted = normalizePath(template)
    const found = wanted ? matchEntry(index.templates, wanted) : null
    return found ? { path: found.path } : { text: template }
  }

  // \`tp.file.create_new(template, filename = 'Untitled', open_new = false, folder?)\` — the parameter names,
  // their order and their defaults are upstream's (\`InternalModuleFile.ts:62-94\`), and the work they drive is
  // \`Templater.ts:134-253\).
  const createNewFile = async (template, filename = 'Untitled', open_new = false, folder) => {
    createNewDepth += 1
    if (createNewDepth > DEPTH_LIMIT) {
      // Upstream zeroes the counter on the way out rather than unwinding it (\`:75-80\`), so a run that
      // survives the rejection can create again. Kept, because the next call's answer is all a template can
      // observe of the difference.
      createNewDepth = 0
      throw hostError('template-recursion', 'tp.file.create_new')
    }
    try {
      const source = templateSourceOf(template)
      if (source === null) return undefined
      // The path is worked out before anything is rendered, so a name the page cannot use cannot also cost a
      // nested run.
      const path = createPathOf(folder, filename)
      // Rendering before creating is the port's order, not upstream's: upstream creates an empty file,
      // renders into it and deletes the file when the render fails (\`Templater.ts:216-220\`). The page's
      // \`note.create\` takes the body, so a failed render leaves no note behind.
      //
      // Both shapes of the template argument render, which is upstream's rule: a file row is read and
      // re-parsed, and a raw string is parsed as the template text itself (\`Templater.ts:194-214\`) —
      // \`create_new('Total: <% 1 + 1 %>', …)\` stores \`Total: 2\`, not the markup. \`asCreate\` carries the
      // note being made, so the child run reads \`tp.file.*\` as that note and \`tp.config.run_mode\` as
      // create-new; \`templatePath\` names the source row when there is one, which is upstream's
      // \`template_file\` for a file-sourced create and its \`undefined\` for a text-sourced one.
      const asCreate = { path, title: withoutExtension(basenameOf(path)) }
      if (source.path !== undefined) asCreate.templatePath = source.path
      const content = await renderIncluded(
        source.path === undefined ? { kind: 'text', text: source.text } : { kind: 'note', path: source.path, subpath: null },
        asCreate)
      const answer = await callHost('note.create', [path, content])
      const created = answer && typeof answer === 'object' ? hydrate(answer) : null
      // No row came back: upstream's \`created_note == null\` branch, which answers \`undefined\` rather than
      // throwing (\`Templater.ts:186-188\`).
      if (!created) return undefined
      // Upstream opens the note it made and, when there is no leaf to open it in, logs and answers
      // \`undefined\` even though the note exists (\`Templater.ts:229-234\`). Here the page holds the leaves,
      // so its own refusal travels as a code instead of being logged away.
      if (open_new) await callHost('note.open', [created.path])
      return created
    } finally {
      createNewDepth -= 1
    }
  }

  // The path the page put the note at, read off the row it answered with. \`rename\` and \`move\` both answer an
  // empty string upstream (\`InternalModuleFile.ts:248\` and \`:295\`) — the signature says \`Promise<string>\`
  // and the value says nothing — so the port answers the path, which is the only way a template can tell its
  // reader where the note went.
  const movedPathOf = (method, answer) => {
    if (!answer || typeof answer !== 'object' || typeof answer.path !== 'string') {
      throw hostError('render-failed', method)
    }
    return answer.path
  }

  // \`tp.file.rename(new_title)\` (\`InternalModuleFile.ts:279-297\`): the folder stays and the name moves.
  const renameFile = async (new_title) => {
    // Upstream tests these three characters, and nothing else, before it touches a file (\`:281\`), and a
    // non-string argument fails there the same way (calling \`.match\` on one is a TypeError). Here both read
    // \`path-invalid\` with the member named, because the value is the reader's text and the code is ours.
    if (typeof new_title !== 'string' || FORBIDDEN_IN_NAME.test(new_title)) {
      throw hostError('path-invalid', 'tp.file.rename')
    }
    const file = target()
    if (!file) throw hostError('note-not-found', 'tp.file.rename')
    // Upstream rebuilds \`parent.path + '/' + new_title + '.' + extension\` itself (\`:288-290\`); here
    // \`note.rename\` is handed the note's current path and one new name and keeps it in its folder, because
    // the page is the half that owns paths (\`host/page-host.ts\`). \`tp.file.title\` is unaffected either way:
    // upstream freezes the basename when it builds the namespace (\`:53\`, \`create_dynamic_templates\`), and
    // this port froze it at install.
    const answer = await callHost('note.rename', [file.path, new_title])
    const renamedPath = movedPathOf('note.rename', answer)
    // The live file object is what a rename changes in Obsidian, so a later \`tp.file.path(true)\` in the same
    // template reads the new path. \`tp.file.title\` is a separate, frozen value, which is the half upstream's
    // own spec pins as staying.
    if (file === target()) config.target_file = hydrate(answer)
    return renamedPath
  }

  // \`tp.file.move(new_path, file_to_move?)\` (\`InternalModuleFile.ts:235-250\`): move, rename, or both, of the
  // run's own note or of the file the template handed it.
  const moveFile = async (new_path, file_to_move) => {
    const wanted = requirePath('file.move', new_path)
    if (!wanted) throw hostError('path-invalid', 'tp.file.move')
    const file = file_to_move instanceof TFile ? file_to_move : target()
    if (!file) throw hostError('note-not-found', 'tp.file.move')
    // The moved note's own extension is appended to whatever the template wrote (\`:238\), whose spec pins
    // \`move("notes/moved.txt")\` landing on \`notes/moved.txt.md\` — \`file.e2e.ts:989-1002\`), so the append
    // stays unconditional. The fallback for an empty extension is upstream's own (\`Templater.ts:167\`).
    const destination = normalizePath(wanted + '.' + (file.extension || MARKDOWN))
    // The missing destination folders are the page's to create: upstream makes them itself (\`:239-246\`) in
    // one \`vault.createFolder\`, which \`host/page-host.ts\` walks segment by segment. Upstream's "absolute
    // path" half has nothing to answer here — this app has no disk, only the tree — so the template's path is
    // the virtual path, the same reading \`tp.file.path\` gives.
    const answer = await callHost('note.move', [file.path, destination])
    const movedPath = movedPathOf('note.move', answer)
    if (file === target()) config.target_file = hydrate(answer)
    return movedPath
  }

  const hooks = []

  const config = { run_mode: 0, target_file: null, active_file: null, template_file: null }

  // The cancel rules differ per call and come from upstream: prompt and suggester yield null,
  // multi_suggester yields an empty list. A template that never mentions cancellation still has to get the
  // answer Templater would have given it.
  const settle = async (pending, throwOnCancel, fallback) => {
    try {
      return await pending
    } catch (error) {
      if (error && error.code === 'prompt-cancelled') {
        if (throwOnCancel) throw error
        return fallback
      }
      throw error
    }
  }

  // Display text is what the wire carries, so the page is sent labels and the answer is mapped back to the
  // item by position. Two items shown identically resolve to the first, which is what upstream's suggester
  // does with a duplicate row too.
  const labelsOf = (text_items, list) => list.map((item, position) => (typeof text_items === 'function'
    ? String(text_items(item))
    : String((text_items ?? [])[position] ?? item)))

  const labelOf = (list, labels, item) => {
    const position = list.indexOf(item)
    return position === -1 ? String(item) : labels[position]
  }

  // \`tp.system.suggester(text_items, items, throw_on_cancel = false, placeholder = "", limit?,
  // default_value?)\` — the positional order and the defaults are upstream's, and the answer is the *item*,
  // not the row the reader clicked.
  const suggester = async (text_items, items, throw_on_cancel = false, placeholder = '', limit, default_value) => {
    const list = Array.isArray(items) ? items : []
    const labels = labelsOf(text_items, list)
    const answer = await settle(callHost('system.suggester', [{
      kind: 'suggest',
      title: '',
      values: labels,
      limit: typeof limit === 'number' ? limit : undefined,
      placeholder: String(placeholder),
      defaultValue: default_value === undefined ? undefined : labelOf(list, labels, default_value),
      throwOnCancel: throw_on_cancel === true,
    }]), throw_on_cancel === true, null)
    if (typeof answer !== 'string') return answer
    const position = labels.indexOf(answer)
    return position === -1 ? answer : list[position]
  }

  // \`tp.system.multi_suggester(text_items, items, throw_on_cancel = false, title = "", limit?,
  // default_values?)\`. Upstream's fourth argument is a heading here and a placeholder for the single
  // suggester, so the two are not interchangeable and each keeps its own field.
  const multiSuggester = async (text_items, items, throw_on_cancel = false, title = '', limit, default_values) => {
    const list = Array.isArray(items) ? items : []
    const labels = labelsOf(text_items, list)
    const picks = Array.isArray(default_values) ? default_values.map((one) => labelOf(list, labels, one)) : undefined
    const answer = await settle(callHost('system.multiSuggester', [{
      kind: 'multi-suggest',
      title: String(title),
      values: labels,
      limit: typeof limit === 'number' ? limit : undefined,
      defaultPicks: picks,
      throwOnCancel: throw_on_cancel === true,
    }]), throw_on_cancel === true, [])
    if (answer === null || answer === undefined) return []
    const chosen = Array.isArray(answer) ? answer : [answer]
    return chosen.map((one) => {
      const position = labels.indexOf(String(one))
      return position === -1 ? one : list[position]
    })
  }

  // The reader's own scripts, as the snapshot carried them in.
  //
  // This is the only place in the app that runs JavaScript the reader wrote. Upstream gets it into a callable
  // through the browser: \`UserScriptFunctions.ts:19-65\` wraps the body as
  // \`(function anonymous(require, module, exports){ … })\` and reads the function back off \`window\`. That door
  // is not open here and would not be allowed if it were — the app ships no \`unsafe-eval\`
  // (\`src/worker/lib/security-headers.ts\`) and the rule this whole package stands on is that reader code runs
  // only inside this interpreter. So the source travels in the snapshot and the engine evaluates it itself,
  // which is also why it has to: \`tp.user.<script>\` is synchronous in the template's eyes, and the answer a
  // host call brings back is JSON, so a script that exports a function or a closure could never cross it.
  //
  // The one deliberate difference from upstream is *what a script can see*. Upstream hands it a real
  // \`window\`; a script here sees only this interpreter, and the two names that would let it re-enter the run —
  // \`tp\` and \`tR\` — are parameters bound to \`undefined\`, so they shadow the globals for the whole body (plan
  // §D13's U7, which is the behaviour upstream has by accident of not putting \`tp\` on \`window\`).
  //
  // \`scripts.loaded\` is the per-run cache, and a run is the unit of validity: a note edited while a template
  // runs keeps the text the first access of that run saw, and the next run re-reads.
  const scripts = {
    allowed: false,
    /** Set when the page could not read the folder at all, which is not the same answer as a missing name. */
    unavailable: '',
    sources: new Map(),
    /** Every script's own module path back to its name, which is what a relative \`require\` lands on. */
    paths: new Map(),
    loaded: new Map(),
    /** The modules mid-evaluation, keyed by name, so a cycle can hand back what they export so far. */
    loading: new Map(),
  }

  // The two names a script may \`require\` that are not another script. There is no Node and no package
  // resolution inside the sandbox, so anything else — \`fs\`, \`crypto-js\`, a package name — is refused by name
  // rather than resolved to nothing.
  const SCRIPT_MODULE = (specifier) => specifier === 'moment' ? moment : specifier === 'obsidian' ? obsidian : null

  const folderOfPath = (path) => {
    const cut = path.lastIndexOf('/')
    return cut === -1 ? '' : path.slice(0, cut)
  }

  // \`./helper.js\` asked for from \`Scripts/x.js\` is \`Scripts/helper.js\`. \`normalizePath\` deliberately leaves
  // \`.\` and \`..\` alone because a note path is shown to the reader as written; here the segments have to be
  // walked, and a \`..\` that climbs past the root lands on a path no listed script owns — the set of paths is
  // exactly the folder the reader chose, which is what makes the walk safe instead of merely tidy.
  const resolveScriptPath = (fromPath, specifier) => {
    const walked = []
    for (const segment of (folderOfPath(fromPath) + '/' + specifier).split('/')) {
      if (segment === '' || segment === '.') continue
      if (segment === '..') {
        walked.pop()
        continue
      }
      walked.push(segment)
    }
    return walked.join('/')
  }

  // The message a script's own throw carries. Kept to one line and a length, because it is shown after the
  // translated label rather than instead of it, and a stack trace from inside a wasm interpreter is noise the
  // reader cannot act on — the path in front of it is the part that names the file to open.
  const oneLine = (text) => {
    const flat = String(text ?? '').split('\\n')[0].trim()
    return flat.length > 120 ? flat.slice(0, 120) : flat
  }

  const scriptFailureText = (path, error) => {
    if (error && typeof error === 'object' && typeof error.code === 'string') return null
    return path + ':' + oneLine(error && error.message ? error.message : error)
  }

  // An export is one function, or an object whose values are all functions — the two shapes upstream accepts
  // and the two a template can call (\`UserScriptFunctions.ts:122-152\`). Anything else is refused with the name
  // in it, because a script that exports a string would otherwise fail at the call site with no file to find.
  const exportSurface = (name, exported) => {
    if (!exported) throw hostError('script-load-failed', name + ':no-export')
    if (typeof exported === 'function') return exported
    if (typeof exported === 'object') {
      for (const key of Object.keys(exported)) {
        if (typeof exported[key] !== 'function') {
          throw hostError('script-load-failed', name + ':' + key + ':not-a-function')
        }
      }
      return exported
    }
    throw hostError('script-load-failed', name + ':export-invalid')
  }

  const loadScript = (name) => {
    if (scripts.loaded.has(name)) return scripts.loaded.get(name)
    // Two different refusals, and they must not be confused: a profile that was never given the right answers
    // \`capability-blocked\` (the template is the problem), and a reader whose folder does not hold that name
    // answers \`script-load-failed\` with the name in it (the script is the problem).
    if (!scripts.allowed) throw hostError('capability-blocked', 'tp.user.' + name)
    if (scripts.unavailable) throw hostError('user-scripts-unavailable', scripts.unavailable)
    const record = scripts.sources.get(name)
    if (!record) throw hostError('script-load-failed', name + ':not-found')
    // A script the page could not carry — too big for one run, or one of a folder past the count this run may
    // hold — arrives as a name with a reason instead of a text, so that the template which *names* it is the
    // run that fails, and not every template the folder belongs to.
    if (record.refusal) throw hostError(record.refusal.code, record.refusal.detail)
    const pending = scripts.loading.get(name)
    // A cycle gets the module as it stands, which is what CommonJS hands back and what a script that requires
    // its own caller expects. Upstream never resolved sibling scripts, so there is no behaviour to copy and
    // the rule is the one the module format itself has.
    if (pending !== undefined) return pending.exports
    const module = { exports: {} }
    const exportsObj = module.exports
    scripts.loading.set(name, module)
    try {
      const wrapper = new Function('tp', 'tR', 'require', 'module', 'exports', record.source + '\\n')
      wrapper(undefined, undefined, scriptRequireFor(name, record.path), module, exportsObj)
    } catch (error) {
      scripts.loading.delete(name)
      // A denial from a script this one required keeps its own code and its own name; anything else is
      // reported against the file the reader has to open.
      const text = scriptFailureText(record.path, error)
      if (text === null) throw error
      throw hostError('script-load-failed', text)
    }
    scripts.loading.delete(name)
    // \`exports.default\` first, then \`module.exports\`, exactly as upstream reads it (\`:120\`). The first read is
    // off the object the wrapper started with, so a script that replaced \`module.exports\` wholesale is not
    // asked for a \`default\` it never wrote, and one that exported an object with a \`default\` member among
    // others keeps that object rather than losing its members.
    const exported = exportsObj.default ?? module.exports
    const surface = exportSurface(name, exported)
    scripts.loaded.set(name, surface)
    return surface
  }

  const scriptRequireFor = (fromName, fromPath) => (specifier) => {
    // \`require(variable)\` says nothing about what is being asked for, and this app answers a question it
    // cannot read by refusing it, naming the script that wrote it.
    if (typeof specifier !== 'string' || specifier === '') {
      throw hostError('script-require-denied', fromName + ':dynamic')
    }
    const builtin = SCRIPT_MODULE(specifier)
    if (builtin) return builtin
    if (specifier[0] !== '.') throw hostError('script-require-denied', fromName + ':' + specifier)
    const target = resolveScriptPath(fromPath, specifier)
    // Node resolves \`./x\` to \`./x.js\` and a reader copying an upstream script may write either; both are
    // looked up among the scripts this run was given, so a missing sibling is refused rather than invented.
    const name = scripts.paths.get(target) ?? scripts.paths.get(target + '.js')
    if (name === undefined || name === null) throw hostError('script-require-denied', fromName + ':' + specifier)
    return loadScript(name)
  }

  // \`tp.user.<script>\` is loaded on the first thing the template does with it, and the value it hands back is
  // the script's own export — so an object export answers its members, which is the spelling upstream's docs
  // carry (\`tp.user.my_script.rename(text)\`) and the one a bare arrow function per key could not.
  //
  // Access itself does not throw for a name no script answers: upstream's namespace is a proxy that hands back
  // a callable for any key, so \`typeof tp.user.missing\` says \`function\` and only the call fails. Keeping that
  // is what lets a template check for a script the reader may not have installed, and a namespace that throws
  // on the check would turn a portable template into a broken one.
  const userNamespace = new Proxy({}, {
    get(_target, key) {
      if (typeof key === 'symbol') return undefined
      // A script named "then" is worth the false positive it causes; a namespace that answers "then" is
      // a thenable, and awaiting it — or any async path that passes tp.user through — calls into the
      // host and waits for a script the template never named.
      if (key === 'then' || key === 'catch' || key === 'finally') return undefined
      return scriptSurface(String(key))
    },
    has() {
      return false
    },
    ownKeys() {
      return []
    },
  })

  const scriptSurface = (name) => {
    const surface = new Proxy(function userScript() {}, {
      apply(_target, _thisArg, args) {
        const value = loadScript(name)
        if (typeof value !== 'function') throw hostError('not-supported', name + ':object-export')
        // \`this\` is left unset, which is what upstream's \`exportedFunction(...args)\` gives a script.
        return Reflect.apply(value, undefined, args)
      },
      get(_target, member) {
        if (typeof member === 'symbol') return undefined
        if (member === 'then' || member === 'catch' || member === 'finally') return undefined
        return loadScript(name)[member]
      },
      has(_target, member) {
        if (member === 'then' || member === 'catch' || member === 'finally') return false
        return Reflect.has(loadScript(name), member)
      },
    })
    return surface
  }

  // The marker text, exactly as upstream emits it: jumping is the parser's job, not the sandbox's, and a
  // template that is never rendered still has to leave the marker in its output.
  const cursorMarker = (order) => '<%' + ' tp.file.cursor(' + (order === undefined ? '' : order) + ') %>'

  // \`tp.file.cursor_append(content)\` (\`InternalModuleFile.ts:109-126\`): the text goes into the active editor
  // at the selection and the call hands back upstream's own empty string (\`:124\`), not a promise.
  // \`cursor.append\` is in the worker's \`SYNC_METHODS\` for exactly this — sent, remembered, and answered by
  // the page before the run is reported done — so a template writing
  // \`<% tp.file.cursor_append('x') %>\` cannot put \`[object Promise]\` into the reader's note. Upstream's
  // no-editor branch returns \`undefined\` (\`:118\`); here the page holds the editor, and its own answer says
  // whether anything was appended.
  const cursorAppend = (content) => {
    callHost('cursor.append', [{ text: String(content ?? '') }])
    return ''
  }

  const target = () => config.target_file

  // The basename the note has in the snapshot, which is what upstream's \`tp.file.title\` reads. The install
  // prefers the title the page froze for the run, because a note being created has no row to read from yet.
  const titleOf = () => (target() ? target().basename : '')

  // Upstream formats the note's own times and never falls back to the clock: with no target there is no
  // time to report, and answering \`Date.now()\` would be the invented data this layer may not print.
  const stamped = (member, key, format) => {
    const file = target()
    if (!file) throw hostError('note-not-found', 'tp.file.' + member)
    return moment(file.stat[key], 'YYYYMMDDHHMMSS').format(format)
  }

  const fileModule = {
    // Frozen at install, from the title the page decided before anything ran. Upstream reads
    // \`target_file.basename\` once, and its spec pins that a template renaming its own note still prints the
    // old title twice; a rename inside the run goes to the page and must not reach back in here.
    title: '',
    content: '',
    // An array, not a function: upstream's \`tags\` is a value on the object, and an array printed by a
    // template is its comma join — which is how \`#tag1,#tag2\` reaches the note, and how a note with no
    // tags prints nothing at all.
    tags: [],
    cursor: cursorMarker,
    creation_date: (format = 'YYYY-MM-DD HH:mm') => stamped('creation_date', 'ctime', format),
    last_modified_date: (format = 'YYYY-MM-DD HH:mm') => stamped('last_modified_date', 'mtime', format),
    // A note at the vault root has no folder to name, and upstream answers the empty string for it rather
    // than the root's own label.
    folder: (absolute = false) => {
      const parent = target() ? target().parent : null
      if (!parent) return ''
      return absolute ? parent.path : parent.name
    },
    // \`tp.file.path(true)\` is the vault-relative path, which this app has. The absolute half is not a
    // difference of degree: there is no vault directory on a disk, so the port answers the vault root as
    // \`/\` and the reference panel says so.
    path: (relative = false) => {
      const file = target()
      if (!file) throw hostError('note-not-found', 'tp.file.path')
      return relative ? file.path : '/' + file.path
    },
    exists: async (filepath) => {
      const answer = await callHost('note.exists', [requirePath('file.exists', filepath)])
      if (typeof answer !== 'boolean') throw hostError('render-failed', 'note.exists')
      return answer
    },
    find_tfile: (filename) => findByTitle(requirePath('file.find_tfile', filename)),
    include: includeFile,
    create_new: createNewFile,
    cursor_append: cursorAppend,
    move: moveFile,
    rename: renameFile,
    // The selection the run arrived with. Synchronous, as upstream's is: the page took it into the snapshot
    // before the program started, so a template writing \`<% tp.file.selection() %>\` without an \`await\` gets
    // text rather than \`[object Promise]\`, and a reader who drags over something else mid-run does not
    // change what the note says.
    selection: () => run.selection,
  }

  // Derived from Templater 2.26.0 (AGPL-3.0-only)
  // src/core/functions/internal_functions/date/InternalModuleDate.ts, with Inkstone adaptations. The only
  // deliberate change is where "now" comes from: the run's own instant rather than the live clock.
  const dateModule = {
    now: (format = 'YYYY-MM-DD', offset, reference, reference_format) => {
      let duration
      if (typeof offset === 'string') duration = moment.duration(offset)
      else if (typeof offset === 'number') duration = moment.duration(offset, 'days')
      return referenceOf(reference, reference_format, 'tp.date.now').add(duration).format(format)
    },
    tomorrow: (format = 'YYYY-MM-DD') => nowMoment().add(1, 'days').format(format),
    yesterday: (format = 'YYYY-MM-DD') => nowMoment().add(-1, 'days').format(format),
    weekday: (format = 'YYYY-MM-DD', weekday, reference, reference_format) => {
      // \`weekday\` takes no default, exactly as upstream: called with nothing, moment answers the getter
      // with a number and the \`.format\` after it is a TypeError — the parse error upstream's spec pins.
      // It is also locale-dependent, so this follows whichever locale the install selected.
      return referenceOf(reference, reference_format, 'tp.date.weekday').weekday(weekday).format(format)
    },
  }

  const referenceOf = (reference, reference_format, member) => {
    if (!reference) return nowMoment()
    // Upstream's own guard: a reference that will not read with the format it was given is a mistake in the
    // template, and a wrong date is worse than a failed run.
    if (!moment(reference, reference_format).isValid()) throw hostError('render-failed', member + '.reference')
    return moment(reference, reference_format)
  }

  const frontmatter = {}

  const webModule = {
    daily_quote: async (language) => {
      const answer = await callHost('web.dailyQuote', [quoteLanguage(language)])
      const record = answer && typeof answer === 'object' ? answer : null
      if (!record || typeof record.quote !== 'string' || typeof record.author !== 'string') {
        throw hostError('web-request-failed', 'web.dailyQuote')
      }
      return '> [!quote] ' + record.quote + '\\n> \\u2014 ' + record.author
    },
    // The first parameter is required here the way it is required upstream, although upstream's own
    // reference writes \`size?\`: the implementation is what a template runs, so it stays, and a missing
    // size simply leaves no size on the link.
    random_picture: async (size, query, include_size = false) => {
      const answer = await callHost('web.randomPicture', [query === undefined ? null : String(query)])
      const photo = answer && typeof answer === 'object' ? answer : null
      if (!photo || typeof photo.full !== 'string' || typeof photo.photog !== 'string' || typeof photo.photogUrl !== 'string') {
        throw hostError('web-request-failed', 'web.randomPicture')
      }
      let url = photo.full
      if (size && !include_size) {
        const wanted = String(size)
        if (wanted.includes('x')) {
          const parts = wanted.split('x')
          url = url.concat('&w=' + parts[0] + '&h=' + parts[1])
        } else {
          url = url.concat('&w=' + wanted)
        }
      }
      const alt = 'photo by ' + photo.photog + '(' + photo.photogUrl + ') on Unsplash'
      return include_size ? '![' + alt + '|' + String(size) + '](' + url + ')' : '![' + alt + '](' + url + ')'
    },
    // GET only, two parameters, and the second is a dot-separated walk into the response — upstream's
    // \`request(url, path?)\`. Upstream's outer catch flattens every failure to one sentence; here the
    // host's own code travels instead, and only the walk is reported by this layer.
    request: async (url, path) => {
      const answer = await callHost('web.request', [{ url: String(url ?? '') }])
      const data = jsonFromResponse(answer)
      if (!path || !data) return data
      return String(path).split('.').reduce((node, key) => {
        if (node && Object.prototype.hasOwnProperty.call(node, key)) return node[key]
        throw hostError('path-invalid', String(path))
      }, data)
    },
  }

  // Upstream's order: an explicit argument wins, then the reader's language, then English. The database
  // each code selects lives behind the page's proxy, which is also where an unregistered language falls
  // back to English, because that is where the URLs are.
  const quoteLanguage = (language) => {
    const given = typeof language === 'string' ? language.trim().toLowerCase() : ''
    if (given) return given
    const locale = typeof run.locale === 'string' ? run.locale.trim().toLowerCase() : ''
    return locale || 'en'
  }

  // The proxy answers \`{ status, ok, contentType, text }\`, so the body is \`text\` and the JSON is read
  // here, which is what upstream's \`response.json\` was for. A status outside 2xx is a failure: upstream's
  // own test is inverted and never fires, and the port plan records that this port is stricter on purpose.
  const jsonFromResponse = (answer) => {
    const response = answer && typeof answer === 'object' ? answer : null
    if (!response) throw hostError('web-request-failed', 'web.request')
    const status = typeof response.status === 'number' ? response.status : 0
    if (status < 200 || status > 299) throw hostError('web-request-failed', String(status))
    if (typeof response.text !== 'string') throw hostError('web-request-failed', 'web.request')
    try {
      return JSON.parse(response.text)
    } catch {
      throw hostError('web-request-failed', 'json')
    }
  }

  const tp = {
    file: fileModule,
    date: dateModule,
    frontmatter,
    system: {
      // \`tp.system.prompt(prompt_text, default_value, throw_on_cancel = false, multi_line = false,
      // select_default_value = false)\`: upstream's own order. Only the last three have defaults, and the
      // dialog itself is the page's — this is the argument list a template is written against.
      prompt: (prompt_text, default_value, throw_on_cancel = false, multi_line = false, select_default_value = false) => settle(callHost('system.prompt', [{
        kind: 'text',
        title: prompt_text === undefined ? '' : String(prompt_text),
        values: [],
        defaultValue: default_value === undefined ? undefined : String(default_value),
        multiLine: multi_line === true,
        selectDefaultValue: select_default_value === true,
        throwOnCancel: throw_on_cancel === true,
      }]), throw_on_cancel === true, null),
      suggester,
      multi_suggester: multiSuggester,
      clipboard: () => callHost('system.clipboard', []),
    },
    web: webModule,
    user: userNamespace,
    hooks: {
      on_all_templates_executed: (callback) => {
        if (typeof callback !== 'function') throw hostError('not-supported', 'hooks.register')
        hooks.push(callback)
        // The callback is kept before the page is told, because it cannot leave the interpreter: the call
        // exists to gate it and to let the page count it. If the page answers with a failure and nobody
        // awaited this, the rejection would have nowhere to go, so it is printed rather than lost.
        const registered = callHost('hooks.register', [hooks.length])
        if (registered && typeof registered.catch === 'function') registered.catch((error) => reportRejected(error))
        return registered
      },
    },
    config,
    obsidian: null,
    app: null,
    moment: null,
    base: { getFileLink: (fileOrLink) => '[[' + String(fileOrLink && fileOrLink.path !== undefined ? fileOrLink.path : fileOrLink ?? '') + ']]' },
  }

  // A rejection nobody awaited is the one failure this layer could lose, so it is not lost: it goes to the
  // console the template author already reads. \`console\` is installed by the host right after this.
  const reportRejected = (error) => {
    const text = error && error.message ? String(error.message) : String(error)
    if (typeof console !== 'undefined' && console && typeof console.error === 'function') {
      console.error('unhandled rejection: ' + text)
    }
  }

  // \`Notice\` draws a toast, and there is no toast in the frozen host method list, so it says so instead of
  // swallowing the message the template wanted shown.
  //
  // A function declaration rather than an arrow: templates write \`new tp.obsidian.Notice("done")\`, and
  // \`new\` on an arrow function throws a \`TypeError\` about constructors — an error with no \`code\`, so the
  // reader would get "is not a constructor" where the honest answer is "this app has no toast surface".
  function noticeUnsupported() {
    throw hostError('not-supported', 'obsidian.Notice')
  }

  // A member this app does not have is answered by something that keeps naming the path it was reached by:
  // templates chain (\`app.vault.adapter.exists(...)\`), and a refusal that stops being a name after one dot
  // turns "this app does not offer that" into "undefined is not a function".
  const refusedMember = (path) => new Proxy(function refused() {
    throw hostError('not-supported', path)
  }, {
    get(_target, key) {
      if (typeof key === 'symbol') return undefined
      if (key === 'then' || key === 'catch' || key === 'finally') return undefined
      return refusedMember(path + '.' + String(key))
    },
  })

  // A7, shared by every facade object: a member this app does not have answers a call that names the whole
  // path, so the template fails at the member it wrote instead of at the next thing that read the
  // \`undefined\`. Symbols and \`then\` keep the exemptions the \`tp.user\` namespace follows — a symbol is the
  // engine probing the object, and a \`then\` that looked like a method would turn \`await tp.app\` into a call
  // that never returns.
  const refuseUnknown = (path) => ({
    get(members, key) {
      if (Object.prototype.hasOwnProperty.call(members, key)) return members[key]
      if (typeof key === 'symbol') return undefined
      if (key === 'then' || key === 'catch' || key === 'finally') return undefined
      return refusedMember(path + '.' + String(key))
    },
  })

  // A note or folder argument is either the object a facade handed out or the path a template typed. The
  // shape is read rather than the class, because a record the page answered with has the same path and the
  // same right to be read as the instance hydrated from it.
  const pathArgument = (member, value) => {
    const text = typeof value === 'string'
      ? value
      : (value !== null && typeof value === 'object' && typeof value.path === 'string' ? value.path : null)
    if (text === null) throw hostError('path-invalid', member)
    return normalizePath(text)
  }

  const textArgument = (member, value) => {
    if (typeof value !== 'string') throw hostError('render-failed', member + '.content')
    return value
  }

  // A write answers the row it touched, and the row is what the index and the file objects are rebuilt from.
  // Anything else is the page failing to say, which is a failure of this run rather than a null to carry on
  // past.
  const recordAnswer = (member, answer) => {
    if (answer === null || typeof answer !== 'object' || typeof answer.path !== 'string') {
      throw hostError('render-failed', member)
    }
    return answer
  }

  const noteEntryOf = (path) => index.notes.find((entry) => entry.path === path) ?? null
  const folderEntryOf = (path) => index.folders.find((entry) => entry.path === path) ?? null

  // The note bodies the run carries with it: the note being written, the one that was open, the template
  // being applied and the library rows it was given. Everything else in the index is a path with no text
  // beside it, which is why \`getFileCache\` answers lightly for those and why reading one is a call.
  const heldNoteOf = (path) => {
    const held = [index.target, index.active, index.template].concat(index.templates)
    for (const ref of held) {
      if (ref && ref.path === path && typeof ref.content === 'string') return ref
    }
    return null
  }

  // What this run has already changed, laid over the snapshot's index for the synchronous lookups. The page
  // keeps its own overlay for the same reason (\`written\` in \`host/page-host.ts\`); a vault object that kept
  // reporting a note it had just created as missing would be the surprise, not this.
  const rememberNote = (entry) => {
    const at = index.notes.findIndex((one) => one.path === entry.path)
    if (at === -1) index.notes.push(entry)
    else index.notes[at] = entry
  }

  const forgetNote = (path) => {
    const at = index.notes.findIndex((one) => one.path === path)
    if (at !== -1) index.notes.splice(at, 1)
  }

  // \`folder.create\` walks a chain one segment at a time and makes every level that was missing, so its
  // answer names one folder while the tree gained several. Recording only the leaf would leave
  // \`getFolderByPath\` answering null about a folder the reader can already see.
  const rememberFolderChain = (created) => {
    let path = ''
    for (const segment of created.path.split('/')) {
      path = path === '' ? segment : path + '/' + segment
      if (folderEntryOf(path) !== null) continue
      index.folders.push(path === created.path ? created : { name: segment, path: path })
    }
  }

  const vaultMembers = {
    read: async (file) => {
      const path = pathArgument('tp.app.vault.read', file)
      const answer = await callHost('note.read', [path])
      const record = answer !== null && typeof answer === 'object' ? answer : null
      if (record === null || typeof record.content !== 'string') throw hostError('render-failed', 'note.read')
      return record.content
    },
    // The cached half means the cache: text the snapshot already holds is the answer, and only a note it does
    // not hold costs a round trip.
    cachedRead: async (file) => {
      const path = pathArgument('tp.app.vault.cachedRead', file)
      const held = heldNoteOf(path)
      if (held !== null) return held.content
      return vaultMembers.read(path)
    },
    // Obsidian's \`create\` asks the vault for an unused name and quietly makes \`Note 2\`. This app refuses a
    // taken path instead (\`note-conflict\` from the page), because two rows reading as one path is a state
    // its index would have to report as ambiguous later — so a template that wants a free name has to ask.
    create: async (path, data) => {
      const wanted = pathArgument('tp.app.vault.create', path)
      const body = textArgument('tp.app.vault.create', data)
      const answer = await callHost('note.create', [wanted, body])
      const entry = recordAnswer('note.create', answer)
      const created = fileOf({ ...entry, content: body })
      rememberNote(entry)
      return created
    },
    modify: async (file, data) => {
      const path = pathArgument('tp.app.vault.modify', file)
      const body = textArgument('tp.app.vault.modify', data)
      await callHost('note.write', [path, body])
      const entry = noteEntryOf(path)
      if (entry !== null) rememberNote({ ...entry, content: body })
    },
    // The app's delete is the recycle bin, and the store owns what happens after that, so Obsidian's
    // \`force\` has nothing here to skip: every delete this facade makes is a soft one.
    delete: async (file) => {
      const path = pathArgument('tp.app.vault.delete', file)
      await callHost('note.delete', [path])
      forgetNote(path)
    },
    exists: (fileOrPath) => {
      const path = pathArgument('tp.app.vault.exists', fileOrPath)
      return path === '' || noteEntryOf(path) !== null || folderEntryOf(path) !== null
    },
    getAbstractFileByPath: (path) => {
      const wanted = pathArgument('tp.app.vault.getAbstractFileByPath', path)
      if (wanted === '') return folderOf({ path: '', name: '' })
      const note = noteEntryOf(wanted)
      if (note !== null) return fileOf(note)
      const folder = folderEntryOf(wanted)
      return folder === null ? null : folderOf(folder)
    },
    getFileByPath: (path) => {
      const note = noteEntryOf(pathArgument('tp.app.vault.getFileByPath', path))
      return note === null ? null : fileOf(note)
    },
    getFolderByPath: (path) => {
      const wanted = pathArgument('tp.app.vault.getFolderByPath', path)
      if (wanted === '') return folderOf({ path: '', name: '' })
      const folder = folderEntryOf(wanted)
      return folder === null ? null : folderOf(folder)
    },
    getFiles: () => index.notes.map((entry) => fileOf(entry)),
    // Every note this app stores is Markdown, so the markdown half of the tree is the whole tree. The filter
    // stays because a template reads the call as "the notes, not the folders", and that is what it gets.
    getMarkdownFiles: () => index.notes
      .filter((entry) => extensionOf(entry.path).toLowerCase() === MARKDOWN)
      .map((entry) => fileOf(entry)),
    getAllLoadedFiles: () => [folderOf({ path: '', name: '' })]
      .concat(index.folders.map((entry) => folderOf(entry)))
      .concat(index.notes.map((entry) => fileOf(entry))),
    getRoot: () => folderOf({ path: '', name: '' }),
    createFolder: async (path) => {
      const wanted = pathArgument('tp.app.vault.createFolder', path)
      if (wanted === '') throw hostError('path-invalid', 'tp.app.vault.createFolder')
      const answer = await callHost('folder.create', [wanted])
      const entry = recordAnswer('folder.create', answer)
      rememberFolderChain(entry)
      return folderOf(entry)
    },
  }

  const HEADING_LINE = /^ {0,3}(#{1,6})[ \\t]+(.*)$/
  // \\x60 is a backtick, written as an escape so this file carries no third kind of quote inside the
  // one template literal that decides which quotes mean what.
  const FENCE_LINE = /^ {0,3}(\\x60{3}|~{3})/

  const headingsOf = (body) => {
    const found = []
    let insideFence = false
    for (const line of body.split('\\n')) {
      if (FENCE_LINE.test(line)) {
        insideFence = !insideFence
        continue
      }
      if (insideFence) continue
      const match = HEADING_LINE.exec(line)
      if (match !== null) found.push({ heading: match[2].trim(), level: match[1].length })
    }
    return found
  }

  // \`[[Target]]\` and \`![[Target]]\`, cut at the alias bar the way Obsidian's own link cache cuts them, and
  // with no positions: the snapshot carries none, so a cache says what the text says and nothing else.
  const linksOf = (body, wantEmbed) => {
    const found = []
    const pattern = /(!?)\\[\\[([^\\]\\n]*)\\]\\]/g
    let match = pattern.exec(body)
    while (match !== null) {
      if ((match[1] === '!') === wantEmbed) found.push({ link: match[2].split('|')[0], original: match[0] })
      match = pattern.exec(body)
    }
    return found
  }

  const cacheOfPath = (path) => {
    const held = heldNoteOf(path)
    if (held === null && noteEntryOf(path) === null) return null
    const body = held === null ? '' : held.content
    const tags = held !== null && Array.isArray(held.tagNames) ? held.tagNames.map(withTagMark) : []
    const matter = held !== null && held.frontmatter !== null && typeof held.frontmatter === 'object'
      ? held.frontmatter
      : null
    return { frontmatter: matter, tags, headings: headingsOf(body), links: linksOf(body, false), embeds: linksOf(body, true) }
  }

  const metadataMembers = {
    // A link is resolved the way \`tp.file.find_tfile\` resolves one: the stored path, the path without
    // \`.md\`, the basename, the title. \`sourcePath\` is Obsidian's parameter and this app has no
    // folder-relative resolution to do with it, so it cannot change which note a link names.
    getFirstLinkpathDest: (linkpath) => {
      const wanted = normalizePath(linkpath)
      const cut = wanted.indexOf('#')
      return cut === -1 ? findByTitle(wanted) : findByTitle(wanted.slice(0, cut))
    },
    getFileCache: (file) => cacheOfPath(pathArgument('tp.app.metadataCache.getFileCache', file)),
    getCache: (path) => cacheOfPath(pathArgument('tp.app.metadataCache.getCache', path)),
  }

  // The editor the run began with, as far as a template may see it, in the shape Obsidian gives it:
  // \`activeEditor.file\` and \`activeEditor.editor\`. Reading is real — the selection the page took, and the
  // text of the note when the snapshot carries it. Writing is not this object's job: the run's output and
  // \`tp.file.cursor_append\` are the two ways text reaches a note, and a method that looked like it changed
  // the editor would promise an undo history nobody here can offer. \`view\` stays null for the same reason
  // \`getLeaf\` answers null — the pane is the page's, not something a message can hand over.
  const editorSurface = {
    getSelection: () => run.selection,
    hasSelection: () => run.selection !== '',
    getValue: () => (config.active_file === null ? '' : config.active_file.content),
    replaceSelection: () => {
      throw hostError('not-supported', 'tp.app.workspace.activeEditor.editor.replaceSelection')
    },
    replaceRange: () => {
      throw hostError('not-supported', 'tp.app.workspace.activeEditor.editor.replaceRange')
    },
  }

  const activeEditorSurface = {
    get file() {
      return config.active_file
    },
    editor: editorSurface,
    view: null,
  }

  const workspaceMembers = {
    activeEditor: activeEditorSurface,
    getActiveFile: () => config.active_file,
    // The page owns the panes and cannot hand one to a template, so this answers what Obsidian answers when
    // there is no leaf. \`newLeaf\` has nothing here to ask for.
    getLeaf: () => null,
    openFile: async (file) => {
      await callHost('note.open', [pathArgument('tp.app.workspace.openFile', file)])
    },
    // An event bus a template could not listen to in the first place, so firing an internal event would be
    // a way to ask the app for something no host method allows. The name is said and refused.
    trigger: (name) => {
      throw hostError('not-supported', 'tp.app.workspace.trigger.' + String(name))
    },
  }

  const fileManagerMembers = {
    // Obsidian's one call renames and moves at once, which is why this goes to \`note.move\` with a whole new
    // path: \`tp.file.rename\` and \`tp.file.move\` are the same work split by argument. A destination with no
    // extension gets \`.md\`, because every note in this app's tree has one and a path without it would file
    // the note somewhere its own index cannot find it.
    renameFile: async (file, newPath) => {
      const from = pathArgument('tp.app.fileManager.renameFile', file)
      const wanted = pathArgument('tp.app.fileManager.renameFile', newPath)
      if (wanted === '') throw hostError('path-invalid', 'tp.app.fileManager.renameFile')
      const destination = extensionOf(wanted) === '' ? wanted + '.' + MARKDOWN : wanted
      const answer = await callHost('note.move', [from, destination])
      const entry = recordAnswer('note.move', answer)
      const moved = fileOf(entry)
      forgetNote(from)
      rememberNote(entry)
      // The live file object is what a move changes in Obsidian, so a template that moved its own note reads
      // the new path from \`tp.file.path(true)\` afterwards.
      if (target() !== null && target().path === from) config.target_file = moved
    },
  }

  const vault = new Proxy(vaultMembers, refuseUnknown('tp.app.vault'))
  const metadataCache = new Proxy(metadataMembers, refuseUnknown('tp.app.metadataCache'))
  const workspace = new Proxy(workspaceMembers, refuseUnknown('tp.app.workspace'))
  const fileManager = new Proxy(fileManagerMembers, refuseUnknown('tp.app.fileManager'))

  // A5: the front-matter half of Obsidian's text helpers, read off the text rather than parsed. The offsets
  // are characters and the positions are lines, both counted from the start of what the template passed, and
  // a block that never closes reports \`exists: false\` — the same answer Obsidian gives a note whose \`---\` is
  // still waiting for its partner.
  const getFrontMatterInfo = (text) => {
    const source = typeof text === 'string' ? text : ''
    const lines = source.split('\\n')
    const absent = { exists: false, frontmatter: '', from: 0, to: 0, start: 0, end: 0, lastFrontmatterLine: '' }
    if (lines[0].replace(/\\r$/, '') !== '---') return absent
    let offset = lines[0].length + 1
    let closing = -1
    for (let line = 1; line < lines.length; line += 1) {
      const bare = lines[line].replace(/\\r$/, '')
      if (bare === '---' || bare === '...') {
        closing = line
        break
      }
      offset += lines[line].length + 1
    }
    if (closing < 0) return absent
    const block = lines.slice(1, closing)
    let last = ''
    for (const line of block) {
      if (line.replace(/\\r$/, '').trim() !== '') last = line.replace(/\\r$/, '')
    }
    return {
      exists: true,
      frontmatter: block.join('\\n'),
      from: offset,
      to: Math.min(offset + lines[closing].length + 1, source.length),
      start: 0,
      end: closing,
      lastFrontmatterLine: last,
    }
  }

  // A5: the two YAML helpers. Upstream reaches for Obsidian's \`yaml\` library; this app's page side has that
  // library, but reaching it from a template would be a new host method, and the host method list is frozen.
  // So these two cover the shapes a template can actually produce here — a plain object, and the block this
  // app's own front-matter merge reads back — and refuse by name everything else. An anchor, an alias, a tag,
  // a block scalar, a flow mapping or a multi-document text would come back as a wrong object, and a wrong
  // object written into the reader's note is the failure this layer exists to prevent.
  const YAML_PLAIN_TEXT = /^[A-Za-z][A-Za-z0-9 +_.\\/-]*$/
  const YAML_NUMBER = /^-?\\d+(\\.\\d+)?([eE][-+]?\\d+)?$/
  const YAML_RESERVED_TEXT = ['true', 'false', 'null', '~', 'yes', 'no', 'on', 'off']

  // The whitelist is the reason \`2026-01-01\` and \`Note: today\` come out quoted: quoting something that did
  // not need it is a cosmetic cost, while leaving something unquoted that reads back as another type is a
  // wrong note.
  const yamlPlainText = (text) => {
    if (!YAML_PLAIN_TEXT.test(text)) return false
    if (YAML_RESERVED_TEXT.includes(text.toLowerCase())) return false
    return !text.endsWith(' ')
  }

  const yamlIsScalar = (value) => (typeof value === 'object' ? value === null || value instanceof Date : !Array.isArray(value))

  const yamlScalarText = (value) => {
    if (value === null || value === undefined) return 'null'
    if (typeof value === 'boolean') return value ? 'true' : 'false'
    if (typeof value === 'number') {
      if (!isFinite(value)) throw hostError('not-supported', 'obsidian.stringifyYaml.number')
      return String(value)
    }
    // A Date is written as the text the app's own YAML reader resolves back to a date; read through this
    // build's \`parseYaml\` it is text, which is the one direction the round trip does not close.
    if (value instanceof Date) return value.toISOString()
    if (typeof value === 'string') return yamlPlainText(value) ? value : JSON.stringify(value)
    throw hostError('not-supported', 'obsidian.stringifyYaml.' + typeof value)
  }

  const yamlKeyText = (key) => (yamlPlainText(key) ? key : JSON.stringify(key))

  const yamlMappingLines = (node, indent, seen) => {
    if (seen.has(node)) throw hostError('not-supported', 'obsidian.stringifyYaml.circular')
    seen.add(node)
    const pad = ' '.repeat(indent)
    const lines = []
    for (const key of Object.keys(node)) {
      const value = node[key]
      if (value === null || value === undefined || yamlIsScalar(value)) {
        lines.push(pad + yamlKeyText(key) + ': ' + yamlScalarText(value))
        continue
      }
      const inner = Array.isArray(value)
        ? yamlSequenceLines(value, indent + 2, seen)
        : yamlMappingLines(value, indent + 2, seen)
      if (inner.length === 0) {
        lines.push(pad + yamlKeyText(key) + ': ' + (Array.isArray(value) ? '[]' : '{}'))
        continue
      }
      lines.push(pad + yamlKeyText(key) + ':')
      for (const line of inner) lines.push(line)
    }
    seen.delete(node)
    return lines
  }

  const yamlSequenceLines = (list, indent, seen) => {
    if (seen.has(list)) throw hostError('not-supported', 'obsidian.stringifyYaml.circular')
    seen.add(list)
    const pad = ' '.repeat(indent)
    const lines = []
    for (const item of list) {
      if (item === null || item === undefined || yamlIsScalar(item)) {
        lines.push(pad + '- ' + yamlScalarText(item))
        continue
      }
      if (Array.isArray(item)) throw hostError('not-supported', 'obsidian.stringifyYaml.nested-sequence')
      const inner = yamlMappingLines(item, indent + 2, seen)
      if (inner.length === 0) {
        lines.push(pad + '- {}')
        continue
      }
      // The dash stands where the item's own indent would, so the first line loses two spaces and the rest
      // already carry them.
      lines.push(pad + '- ' + inner[0].slice(indent + 2))
      for (let index = 1; index < inner.length; index += 1) lines.push(inner[index])
    }
    seen.delete(list)
    return lines
  }

  const textOrEmpty = (lines, fallback) => (lines.length === 0 ? fallback : lines.join('\\n'))

  // An empty container is written in flow form because there is nothing to indent, which is what the app's
  // own YAML reader resolves from \`{}\` and \`[]\`.
  const stringifyYaml = (value) => {
    if (Array.isArray(value)) return textOrEmpty(yamlSequenceLines(value, 0, new Set()), '[]')
    if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      return textOrEmpty(yamlMappingLines(value, 0, new Set()), '{}')
    }
    return yamlScalarText(value)
  }

  // A \`#\` starts a comment only at the beginning of a line or after a space, and never inside a quoted
  // value: the two rules Obsidian's parser applies to the text a template writes back.
  const yamlStripComment = (line) => {
    let quote = ''
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]
      if (quote !== '') {
        if (char === quote) quote = ''
        continue
      }
      if (char === '"' || char === "'") {
        quote = char
        continue
      }
      if (char === '#' && (index === 0 || line[index - 1] === ' ' || line[index - 1] === '\\t')) return line.slice(0, index)
    }
    return line
  }

  const yamlRows = (source) => {
    const rows = []
    const lines = source.split('\\n')
    for (let number = 0; number < lines.length; number += 1) {
      const line = yamlStripComment(lines[number].replace(/\\r$/, ''))
      const trimmed = line.trim()
      if (trimmed === '') continue
      if (line.startsWith('\\t')) throw hostError('parse-invalid', 'obsidian.parseYaml.tab:' + (number + 1))
      if (trimmed === '---' || trimmed === '...') throw hostError('not-supported', 'obsidian.parseYaml.document')
      rows.push({ indent: line.length - line.replace(/^ +/, '').length, text: trimmed, number: number + 1 })
    }
    return rows
  }

  // \`key: value\` split at the first colon that sits outside a quote and is followed by a space or the end of
  // the line, which is what a plain YAML key has to look like.
  const yamlKeySplit = (text) => {
    let quote = ''
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index]
      if (quote !== '') {
        if (char === quote) quote = ''
        continue
      }
      if (char === '"' || char === "'") {
        quote = char
        continue
      }
      if (char === ':' && (index + 1 === text.length || text[index + 1] === ' ')) {
        return { key: text.slice(0, index), value: text.slice(index + 1).trim() }
      }
    }
    return null
  }

  const yamlFlowSplit = (inner) => {
    const parts = []
    let depth = 0
    let quote = ''
    let start = 0
    for (let index = 0; index < inner.length; index += 1) {
      const char = inner[index]
      if (quote !== '') {
        if (char === quote) quote = ''
        continue
      }
      if (char === '"' || char === "'") {
        quote = char
        continue
      }
      if (char === '[') depth += 1
      else if (char === ']') depth -= 1
      else if (char === ',' && depth === 0) {
        parts.push(inner.slice(start, index).trim())
        start = index + 1
      }
    }
    parts.push(inner.slice(start).trim())
    return parts.filter((part) => part !== '')
  }

  const yamlScalar = (text) => {
    if (text === '') return null
    const first = text[0]
    const last = text[text.length - 1]
    if (first === '&' || first === '*' || first === '!' || first === '|' || first === '>') {
      throw hostError('not-supported', 'obsidian.parseYaml.scalar')
    }
    if (first === '{') throw hostError('not-supported', 'obsidian.parseYaml.flow-mapping')
    if (first === '[') {
      if (last !== ']') throw hostError('parse-invalid', 'obsidian.parseYaml.flow-sequence')
      const inner = text.slice(1, -1).trim()
      return inner === '' ? [] : yamlFlowSplit(inner).map((part) => yamlScalar(part))
    }
    if (first === '"') {
      if (last !== '"' || text.length < 2) throw hostError('parse-invalid', 'obsidian.parseYaml.quote')
      try {
        return JSON.parse(text)
      } catch {
        throw hostError('parse-invalid', 'obsidian.parseYaml.quote')
      }
    }
    if (first === "'") {
      if (last !== "'" || text.length < 2) throw hostError('parse-invalid', 'obsidian.parseYaml.quote')
      return text.slice(1, -1).replace(/''/g, "'")
    }
    if (text === 'true') return true
    if (text === 'false') return false
    if (text === 'null' || text === '~') return null
    if (text === '.inf' || text === '-.inf' || text === '+.inf' || text === '.nan') {
      throw hostError('not-supported', 'obsidian.parseYaml.number')
    }
    return YAML_NUMBER.test(text) ? Number(text) : text
  }

  const yamlSequenceRow = (row) => row !== undefined && (row.text === '-' || row.text.startsWith('- '))

  const parseYamlSequence = (rows, cursor) => {
    const built = []
    const indent = rows[cursor.at].indent
    while (cursor.at < rows.length) {
      const row = rows[cursor.at]
      if (row.indent !== indent || !yamlSequenceRow(row)) break
      const rest = row.text === '-' ? '' : row.text.slice(2).trim()
      cursor.at += 1
      // \`- key: value\` is a mapping inside a sequence. Emitting it is easy and reading it back is a second
      // parser, so the shape this build refuses to read is named rather than guessed at.
      if (rest !== '' && yamlKeySplit(rest) !== null) {
        throw hostError('not-supported', 'obsidian.parseYaml.sequence-of-mappings')
      }
      // \`- - a\` is the same argument about a sequence: reading it as the text \`- a\` would be a wrong list.
      if (rest === '-' || rest.startsWith('- ')) {
        throw hostError('not-supported', 'obsidian.parseYaml.nested-sequence')
      }
      built.push(yamlScalar(rest))
    }
    return built
  }

  const parseYamlMapping = (rows, cursor) => {
    const built = {}
    const indent = rows[cursor.at].indent
    while (cursor.at < rows.length) {
      const row = rows[cursor.at]
      if (row.indent < indent) break
      if (row.indent > indent) throw hostError('parse-invalid', 'obsidian.parseYaml.indent:' + row.number)
      const split = yamlKeySplit(row.text)
      if (split === null) throw hostError('parse-invalid', 'obsidian.parseYaml.line:' + row.number)
      cursor.at += 1
      const key = String(yamlScalar(split.key))
      if (split.value !== '') {
        built[key] = yamlScalar(split.value)
        continue
      }
      const next = rows[cursor.at]
      if (next === undefined || next.indent <= indent) {
        built[key] = null
        continue
      }
      built[key] = yamlSequenceRow(next)
        ? parseYamlSequence(rows, cursor)
        : parseYamlMapping(rows, cursor)
    }
    return built
  }

  const parseYaml = (text) => {
    if (typeof text !== 'string') throw hostError('parse-invalid', 'obsidian.parseYaml')
    const rows = yamlRows(text)
    if (rows.length === 0) return null
    // A one-line document that is neither a key nor a list item is a scalar: \`parseYaml('[]')\` answers the
    // empty list and \`parseYaml('text')\` the text, which is what Obsidian's parser hands back for them.
    if (rows.length === 1 && !yamlSequenceRow(rows[0]) && yamlKeySplit(rows[0].text) === null) {
      return yamlScalar(rows[0].text)
    }
    const cursor = { at: 0 }
    const built = yamlSequenceRow(rows[0]) ? parseYamlSequence(rows, cursor) : parseYamlMapping(rows, cursor)
    if (cursor.at !== rows.length) {
      throw hostError('parse-invalid', 'obsidian.parseYaml.indent:' + rows[cursor.at].number)
    }
    return built
  }

  // A6: the platform flags, and only the ones this app can answer. Upstream runs inside the desktop or the
  // mobile app and reads the device; a template here runs in a browser tab that may be either, and the run's
  // context says nothing about which. The plan's answer is the fixed one: this is the desktop surface, and it
  // is not the packaged app. The rest of Obsidian's flags are about hardware the sandbox cannot see.
  const Platform = { isDesktop: true, isDesktopApp: false, isMobile: false, isMobileApp: false }

  // A6: Obsidian's \`requestUrl\`, over the one door this app has — the same-origin proxy behind
  // \`web.request\`, which is GET only. The other three request fields are refused by name rather than
  // dropped: a template that believed its POST had gone out would write a note about a result that never
  // happened. \`json\` answers null for a body that is not JSON, which is Obsidian's shape, not a swallowed
  // error: \`text\` still holds everything the far side said.
  const requestUrl = async (request) => {
    const given = request !== null && typeof request === 'object' ? request : null
    if (given === null) throw hostError('path-invalid', 'tp.obsidian.requestUrl')
    for (const member of ['method', 'headers', 'body']) {
      if (given[member] !== undefined) throw hostError('not-supported', 'tp.obsidian.requestUrl.' + member)
    }
    const url = typeof given.url === 'string' ? given.url : ''
    if (url.trim() === '') throw hostError('path-invalid', 'tp.obsidian.requestUrl.url')
    const answer = await callHost('web.request', [{ url }])
    const response = answer !== null && typeof answer === 'object' ? answer : null
    if (response === null) throw hostError('web-request-failed', 'web.request')
    const status = typeof response.status === 'number' ? response.status : 0
    const text = typeof response.text === 'string' ? response.text : ''
    const contentType = typeof response.contentType === 'string' ? response.contentType : ''
    const ok = typeof response.ok === 'boolean' ? response.ok : status >= 200 && status <= 299
    if (given.throw === true && !ok) throw hostError('web-request-failed', String(status))
    let parsed = null
    if (contentType.includes('json') || text.startsWith('{') || text.startsWith('[')) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = null
      }
    }
    // No \`arrayBuffer\`: the proxy carries text and refuses anything past its size limit, so there is no
    // binary this build could hand back, and a half-empty one would read as a downloaded file.
    return { status, ok, headers: { 'content-type': contentType }, text, json: parsed }
  }

  // \`tp.obsidian\`: the classes the interpreter defines, the pure text helpers, the platform flags and the one
  // request door. The four \`app\` objects are assembled above and installed beside this, so \`tp.app === app\`
  // and \`tp.obsidian === obsidian\` hold — which is what the upstream documentation's own examples assume, and
  // what makes \`obsidian.TFile\` the same class \`tp.obsidian.TFile\` is.
  //
  // Everything the app genuinely offers is on the table; anything else answers a call that throws, because
  // a template reading \`tp.obsidian.MarkdownView\` would otherwise get \`undefined\` and fail somewhere far
  // away from the reason. The name in the error is the member the template wrote.
  const obsidianMembers = {
    TAbstractFile,
    TFile,
    TFolder,
    normalizePath,
    parseLinktext,
    getAllTags,
    getFrontMatterInfo,
    parseYaml,
    stringifyYaml,
    requestUrl,
    Platform,
    Notice: noticeUnsupported,
  }

  const obsidian = new Proxy(obsidianMembers, refuseUnknown('tp.obsidian'))

  const app = new Proxy({ vault, metadataCache, workspace, fileManager }, refuseUnknown('tp.app'))

  tp.obsidian = obsidian
  tp.app = app
  tp.moment = moment

  // \`install\` is handed the snapshot as one JSON string rather than a marshalled object: the payload is
  // built on the host side with \`context.newString(JSON.stringify(...))\`, and reading \`data.notes\` off
  // that string would answer \`undefined\` for every field — which does not throw here, it quietly
  // installs an empty run and makes \`tp.config.target_file\` null. So it is parsed first and loudly.
  const install = (encoded) => {
    const data = typeof encoded === 'string' ? JSON.parse(encoded) : encoded
    run.startedAt = typeof data.startedAt === 'number' ? data.startedAt : 0
    run.locale = typeof data.locale === 'string' ? data.locale : ''
    run.selection = typeof data.selection === 'string' ? data.selection : ''
    installScripts(data)
    index.notes = Array.isArray(data.notes) ? data.notes : []
    index.folders = Array.isArray(data.folders) ? data.folders : []
    index.templates = Array.isArray(data.templates) ? data.templates : []
    index.target = data.target ?? null
    index.active = data.active ?? null
    index.template = data.template ?? null
    config.run_mode = typeof data.runMode === 'number' ? data.runMode : 0
    config.target_file = hydrate(index.target)
    config.active_file = hydrate(index.active)
    config.template_file = hydrate(index.template)
    // The frozen title: the page decides it before anything runs, because a create-new note has no row yet
    // and a renamed one must still answer what it was called when the template opened. Falling back to the
    // target's own basename is the case where the page had nothing to say.
    fileModule.title = typeof data.frozenTitle === 'string' && data.frozenTitle ? data.frozenTitle : titleOf()
    fileModule.content = typeof data.targetContent === 'string' ? data.targetContent : ''
    fileModule.tags = target() ? target().tags.map(withTagMark) : []
    fillFrontmatter()
    return true
  }

  // The scripts this run may reach, read off the snapshot's JSON.
  //
  // Every table is emptied first. A run owns one interpreter, but nothing in this file promises that a
  // second \`install\` never happens in the same context, and a reader's scripts answering a later run that
  // was never given them would be the one failure mode this half of the door cannot have.
  //
  // A name the page carried twice is not settled here: \`host/user-scripts.ts\` refuses the collision before a
  // snapshot is built, because "two files claim this name" is only useful to a reader when it names both.
  const installScripts = (data) => {
    scripts.allowed = data.userScriptsAllowed === true
    scripts.unavailable = typeof data.userScriptsUnavailable === 'string' ? data.userScriptsUnavailable : ''
    scripts.sources.clear()
    scripts.paths.clear()
    scripts.loaded.clear()
    scripts.loading.clear()
    const records = Array.isArray(data.userScripts) ? data.userScripts : []
    for (const record of records) {
      if (!record || typeof record.name !== 'string' || record.name === '') continue
      const path = typeof record.path === 'string' && record.path !== '' ? record.path : record.name + '.js'
      scripts.paths.set(path, record.name)
      const refusal = record.refusal
      if (refusal && typeof refusal.code === 'string' && refusal.code !== '') {
        scripts.sources.set(record.name, {
          path: path,
          refusal: { code: refusal.code, detail: typeof refusal.detail === 'string' ? refusal.detail : path },
        })
        continue
      }
      scripts.sources.set(record.name, { path: path, source: typeof record.source === 'string' ? record.source : '' })
    }
  }

  // \`tp.frontmatter\` is the target's parsed frontmatter, key for key, and nothing else — upstream builds
  // it from the metadata cache of exactly that file, so a key a note does not have is \`undefined\` and a
  // template printing it writes the word out.
  const fillFrontmatter = () => {
    const source = target() && target().frontmatter && typeof target().frontmatter === 'object'
      ? target().frontmatter
      : {}
    for (const key of Object.keys(frontmatter)) delete frontmatter[key]
    for (const key of Object.keys(source)) {
      // \`defineProperty\` rather than an assignment, because that is what the \`Object.fromEntries\` upstream
      // uses does: a note whose frontmatter has a \`__proto__\` key gets a key, not a new prototype.
      Object.defineProperty(frontmatter, key, {
        value: source[key],
        writable: true,
        enumerable: true,
        configurable: true,
      })
    }
  }
  return { install, hydrate, jsonToValue, hostError, TFile, TFolder, tp, app, obsidian, hooks, config }
})()`

/** The names the prelude itself provides; `console`, `moment` and `tR` are installed by this module. */
const PRELUDE_NAMES = ['tp', 'app', 'obsidian', 'TFile', 'TFolder'] as const

/**
 * The nine names a template may speak, and no others.
 *
 * Exported because `bootstrap.test.ts` compares this against the globals an empty context has, which is
 * how "and only that" stays true when somebody adds a helper to the prelude next year.
 */
export const TEMPLATE_GLOBAL_NAMES = ['tp', 'app', 'obsidian', 'moment', 'console', 'TFile', 'TFolder', 'tR', '__host'] as const

/** What `bootstrap.ts` hands the interpreter, and what it hands back to `vm.ts`. */
export interface Bootstrap extends VmMarshalling {
  /** Put `__host` where the prelude's classes can reach it, then seed the snapshot it reads. */
  install: (args: { snapshot: TemplateRunContext; host: QuickJSHandle }) => void
  /** The rendered text the program left in the global `tR`, used when it returned no string. */
  readOutput: () => string
  /** How many callbacks `tp.hooks.on_all_templates_executed` kept. */
  hookCount: () => number
  /** One hook, as a handle the caller owns and must dispose. */
  hookHandle: (index: number) => QuickJSHandle
  /**
   * A host-side note/folder record, turned into an instance of the class the interpreter owns.
   *
   * A ported module that answers `tp.app.vault.getAbstractFileByPath` gets a plain record out of the
   * snapshot and must hand back something `instanceof tp.obsidian.TFile` accepts; building the VM object
   * anywhere else would put a second, incompatible definition of the class in play.
   */
  hydrate: (value: unknown) => QuickJSHandle
  /** Lines the run printed, and lines the budget made drop. */
  logCount: () => number
  suppressedLines: () => number
  dispose: () => void
}

export interface BootstrapOptions {
  context: QuickJSContext
  /** Where a template's `console` output goes. The worker prints it; a test records it. */
  log: (level: string, text: string) => void
  locale: string
}

/**
 * Build the namespace inside a fresh context.
 *
 * Order matters twice over and both are load-bearing. moment's core must be evaluated before its locale,
 * because the locale's UMD fallback reads `global.moment`; and the prelude must be evaluated before the
 * snapshot is installed, because installing hydrates the target note into a class the prelude defines.
 */
export function createBootstrap(options: BootstrapOptions): Bootstrap {
  const { context, locale } = options
  const tracked: QuickJSHandle[] = []
  let logs = 0
  let suppressed = 0

  evaluate(momentCoreSource, 'moment-core.js')
  evaluate(momentZhCnSource, 'moment-locale-zh-cn.js')
  // The locale decides month names, weekday names and where a week starts, so it is set before anything
  // can read a date. `zh-CN` in any of its spellings takes the bundled Chinese locale; everything else
  // stays on moment's built-in English.
  selectLocale(locale.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en')

  const internal = unwrapEvaluated(context, context.evalCode(PRELUDE, 'bootstrap.js'))
  tracked.push(internal)

  for (const name of PRELUDE_NAMES) {
    const handle = context.getProp(internal, name)
    tracked.push(handle)
    context.setProp(context.global, name, handle)
  }

  // `tR` is the output accumulator. The compiled program declares its own `tR` inside the async function
  // body, which shadows this one; the global exists so an execution command can read and write `tR`
  // whichever way the compiler scoped it, and `readOutput` is only consulted when the program's own
  // resolved value is not a string.
  const emptyOutput = context.newString('')
  context.setProp(context.global, 'tR', emptyOutput)
  emptyOutput.dispose()

  const consoleHandle = buildConsole()
  tracked.push(consoleHandle)
  context.setProp(context.global, 'console', consoleHandle)

  // moment attached itself to the interpreter's global as a side effect of its UMD wrapper, so the exported
  // name is read back from there rather than reconstructed, and `tp.moment` is the same function.
  const momentHandle = context.getProp(context.global, 'moment')
  tracked.push(momentHandle)

  const hooksHandle = context.getProp(internal, 'hooks')
  tracked.push(hooksHandle)

  /** `JSON.parse(text)` inside the interpreter, from a string the host just made. */
  function toValue(value: unknown): QuickJSHandle {
    const text = context.newString(JSON.stringify(value ?? null) ?? 'null')
    return callInternal('jsonToValue', [text])
  }

  /**
   * One call of a prelude function, with the arguments handed over.
   *
   * `callFunction` consumes its argument handles and hands back a result the caller owns — measured rather
   * than assumed, because a wrong guess here is a double free inside the interpreter, which traps the
   * whole worker rather than reporting an error.
   */
  function callInternal(name: string, args: QuickJSHandle[]): QuickJSHandle {
    const fn = context.getProp(internal, name)
    const result = context.callFunction(fn, context.undefined, args)
    fn.dispose()
    if (result.error) {
      result.error.dispose()
      throw new TemplaterBootstrapError('render-failed', `bootstrap.${name}`)
    }
    return result.value
  }

  return {
    install({ snapshot, host }) {
      context.setProp(context.global, '__host', host)
      const payload = context.newString(JSON.stringify({
        notes: snapshot.index,
        folders: snapshot.folders,
        templates: snapshot.libraryTemplates.map((template) => virtualTemplate(template, snapshot.index)),
        target: withPath(snapshot.target, snapshot.index),
        active: withPath(snapshot.active, snapshot.index),
        template: virtualTemplate(snapshot.template, snapshot.index),
        runMode: runModeNumber(snapshot.mode),
        targetContent: snapshot.target?.content ?? '',
        // Four things the prelude cannot derive for itself: the instant every date in the run is measured
        // from, the title the page froze before anything ran, the reader's language, which is what an
        // argument-less `tp.web.daily_quote` resolves to, and the selection the reader had made.
        startedAt: snapshot.startedAt,
        frozenTitle: snapshot.frozenTitle,
        locale: snapshot.locale,
        selection: snapshot.selection,
        // The scripts arrive as data rather than as a door: the interpreter is the only thing allowed to
        // evaluate them, and `userScriptsAllowed` says whether this run was given the right at all, which is
        // a different answer from "the folder holds no script by that name" and reads as one otherwise.
        userScripts: snapshot.userScripts,
        userScriptsUnavailable: snapshot.userScriptsUnavailable,
        userScriptsAllowed: capabilitiesFor(snapshot.capabilities).userScripts,
      }))
      // `install` returns `true`; the handle is this side's to free, and the result of a failed install is
      // a run that never starts, which the caller reports.
      callInternal('install', [payload]).dispose()
    },
    toValue,
    error(code, detail) {
      const args = [context.newString(code)]
      if (detail !== undefined && detail !== '') args.push(context.newString(detail))
      return callInternal('hostError', args)
    },
    hydrate(value) {
      return callInternal('hydrate', [toValue(value)])
    },
    readOutput() {
      const global = context.global
      const accumulated = context.getProp(global, 'tR')
      const text = context.typeof(accumulated) === 'string' ? context.getString(accumulated) : ''
      accumulated.dispose()
      return text
    },
    hookCount() {
      const length = context.getProp(hooksHandle, 'length')
      const count = context.getNumber(length)
      length.dispose()
      return Number.isFinite(count) ? count : 0
    },
    hookHandle(index) {
      return context.getProp(hooksHandle, index)
    },
    logCount: () => logs,
    suppressedLines: () => suppressed,
    dispose() {
      for (const handle of tracked) {
        if (handle.alive) handle.dispose()
      }
      tracked.length = 0
    },
  }

  function evaluate(source: string, filename: string): void {
    const result = context.evalCode(source, filename)
    if (result.error) {
      const dumped = context.dump(result.error) as { message?: unknown } | undefined
      result.error.dispose()
      // A namespace that did not load is not a run. `sandbox-unavailable` is the honest code: the app
      // could not provide the interpreter, rather than the template having done something wrong.
      throw new TemplaterBootstrapError('sandbox-unavailable', `${filename}:${typeof dumped?.message === 'string' ? dumped.message : 'eval'}`)
    }
    result.value.dispose()
  }

  function selectLocale(name: string): void {
    const momentHandle = context.getProp(context.global, 'moment')
    // `moment('en')` parses a date; `moment.locale('en')` changes the locale. Calling the factory with
    // the name would silently succeed and leave every month name in the language the locale file last
    // registered, which is exactly the failure that makes a template's dates look wrong in only one
    // language and reads as a moment bug rather than a wiring one.
    const localeHandle = context.getProp(momentHandle, 'locale')
    const argument = context.newString(name)
    const thisArg = context.undefined
    const result = context.callFunction(localeHandle, thisArg, [argument])
    localeHandle.dispose()
    momentHandle.dispose()
    thisArg.dispose()
    if (result.error) {
      result.error.dispose()
      // English is the fallback moment always carries. A locale file that would not register is a
      // packaging failure, and saying so out loud keeps it from reading as a template bug later.
      options.log('error', 'templater locale could not be set: ' + name)
    } else {
      result.value.dispose()
    }
  }

  function buildConsole(): QuickJSHandle {
    const handle = context.newObject()
    for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
      const fn = context.newFunction(level, (...args) => {
        const text = args.map((one) => describe(context.dump(one))).join(' ').slice(0, MAX_LOG_CHARS)
        // The budget is per run and hard: past it the lines stop. `suppressed` is what lets the run say
        // how much it did not print, instead of leaving the reader with a log that looks complete.
        if (logs < MAX_LOG_LINES) {
          logs += 1
          options.log(level, text)
        } else {
          suppressed += 1
        }
      })
      context.setProp(handle, level, fn)
      fn.dispose()
    }
    return handle
  }
}

/** The name of the run mode, as the number upstream's `RunMode` enum used, in the same order. */
const RUN_MODE_NUMBERS: Record<string, number> = {
  'create-new': 0,
  'append-active': 1,
  'overwrite-file': 2,
  'overwrite-active': 3,
  'dynamic-processor': 4,
  startup: 5,
}

export function runModeNumber(mode: string): number {
  return RUN_MODE_NUMBERS[mode] ?? 0
}

/**
 * A note record, with the path the interpreter's file classes are built on.
 *
 * `RunNoteRef` deliberately carries no path: it is a database row plus a body, and the path a template sees
 * is a property of the folder it sits in, which the run's `index` already resolves. Reading it back from
 * there keeps one answer instead of two, and the fallback (`title.md`) covers the note being created — where
 * the row exists before any folder path was written for it. A template that renames or moves a note is
 * answered by the host, which owns the path from then on.
 */
function withPath(ref: { id: string; title: string } | null, index: TemplateRunContext['index']): Record<string, unknown> | null {
  if (!ref) return null
  const found = index.find((entry) => entry.id === ref.id)
  return { ...ref, path: found?.path ?? `${ref.title}.md` }
}

/**
 * A library template as the virtual file the port's D4 describes.
 *
 * Upstream addresses templates as files — `tp.config.template_file`, `include`, `find_tfile` by name — and
 * Inkstone keeps them as rows. The path is not invented here: it is read back from the run's own index,
 * which `context/file-wrapper.ts` already projected as `Templates/<name>.md`. Asking the index the same way
 * `withPath` does for a note is what keeps one row answering one path to `tp.config.template_file`, to
 * `find_tfile` and to `include` — three readers that would otherwise disagree, and a template that is
 * addressed by a path `note.read` cannot find is a template that cannot be included.
 *
 * `name`, `basename` and `extension` are left out because `TFile` derives all three from the path, and a
 * second spelling of the same split is a second thing to keep in step.
 */
function virtualTemplate(
  template: { id: string; name: string; content: string } | null,
  index: TemplateRunContext['index'],
): Record<string, unknown> | null {
  if (!template) return null
  const found = index.find((entry) => entry.id === template.id)
  return {
    id: template.id,
    title: found?.title ?? template.name,
    path: found?.path ?? `${template.name}.md`,
    content: template.content,
    createdAt: found?.createdAt ?? 0,
    updatedAt: found?.updatedAt ?? 0,
  }
}

/** A logged value, said the way a console would say it: strings as typed, anything else as JSON. */
function describe(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'function') return '[function]'
  try {
    return JSON.stringify(value) ?? 'null'
  } catch {
    // A circular value (which a VM object can be) has no JSON form, and the log line still has to say
    // something about what the template passed in.
    return String(value)
  }
}

function unwrapEvaluated(context: QuickJSContext, result: ReturnType<QuickJSContext['evalCode']>): QuickJSHandle {
  if (result.error) {
    // The interpreter's own words go with the code, the same way `evaluate` above hands them over: a run that
    // never started because the prelude did not evaluate is the one failure a reader cannot debug from
    // `sandbox-unavailable` alone, and the prelude is where a mistake in this file lands.
    const dumped = context.dump(result.error) as { message?: unknown } | undefined
    result.error.dispose()
    throw new TemplaterBootstrapError('sandbox-unavailable', typeof dumped?.message === 'string' ? dumped.message : 'bootstrap')
  }
  return result.value
}

/**
 * A namespace that could not be built.
 *
 * Kept apart from a template failure on purpose: this is the app failing to provide the interpreter, and
 * the code it carries (`sandbox-unavailable`) is the one the reader should see for it.
 */
export class TemplaterBootstrapError extends Error {
  readonly code: string
  readonly detail: string

  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`)
    this.name = 'TemplaterBootstrapError'
    this.code = code
    this.detail = detail
  }
}
