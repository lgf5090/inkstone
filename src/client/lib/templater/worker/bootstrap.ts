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
  // ceiling across the nested runs is the page's to enforce (\`MAX_TEMPLATE_DEPTH\` in \`../limits.ts\`),
  // because the contract carries no field that could hand a nested run the depth it was started at.
  const renderDepth = () => includeDepth + createNewDepth

  // Asking the page to render one thing into text. This is the half the worker cannot do for itself: it holds
  // no parser and one interpreter per run, so a nested run is started on the page and answered finished.
  const renderIncluded = async (path, subpath) => {
    const answer = await callHost('note.renderInclude', [{
      path,
      subpath: wireSubpath(subpath),
      depth: renderDepth(),
    }])
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
      return await renderIncluded(found.path, found.subpath)
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

  // What one \`create_new\` template argument means: a path to render, or text to store as written.
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
      const content = source.path === undefined ? source.text : await renderIncluded(source.path, null)
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

  // A script name is whatever the template typed, so the module is a proxy rather than a table. Symbol keys
  // are the engine probing the object: turning \`then\` into a script call is how a template that awaits
  // \`tp.user\` itself would hang.
  const userNamespace = new Proxy({}, {
    get(_target, key) {
      if (typeof key === 'symbol') return undefined
      // A script named "then" is worth the false positive it causes; a namespace that answers "then" is
      // a thenable, and awaiting it — or any async path that passes tp.user through — calls into the
      // host and waits for a script the template never named.
      if (key === 'then' || key === 'catch' || key === 'finally') return undefined
      return (...args) => callHost('user.script', [key, args])
    },
    has() {
      return false
    },
    ownKeys() {
      return []
    },
  })

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

  // The two compatibility façades. Their members are the ported module work; the objects exist here so
  // those modules have somewhere to be installed and so \`tp.app === app\` and \`tp.obsidian === obsidian\`
  // hold, which is what the upstream documentation's own examples assume.
  //
  // Everything the app genuinely offers is on the table; anything else answers a call that throws, because
  // a template reading \`tp.obsidian.MarkdownView\` would otherwise get \`undefined\` and fail somewhere far
  // away from the reason. The name in the error is the member the template wrote.
  const obsidianMembers = { TFile, TFolder, normalizePath, parseLinktext, getAllTags, Notice: noticeUnsupported }

  const obsidian = new Proxy(obsidianMembers, {
    get(members, key) {
      if (Object.prototype.hasOwnProperty.call(members, key)) return members[key]
      // Same rule the user-script namespace follows: a symbol is the engine probing the object, and a
      // \`then\` that looks like a method turns \`await tp.obsidian\` into a call that never returns.
      if (typeof key === 'symbol') return undefined
      if (key === 'then' || key === 'catch' || key === 'finally') return undefined
      return function obsidianMember() {
        throw hostError('not-supported', 'tp.obsidian.' + String(key))
      }
    },
  })

  const app = { vault: {}, metadataCache: {}, workspace: {}, fileManager: {} }

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

  const internal = unwrapEvaluated(context.evalCode(PRELUDE, 'bootstrap.js'))
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

function unwrapEvaluated(result: ReturnType<QuickJSContext['evalCode']>): QuickJSHandle {
  if (result.error) {
    result.error.dispose()
    throw new TemplaterBootstrapError('sandbox-unavailable', 'bootstrap')
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
