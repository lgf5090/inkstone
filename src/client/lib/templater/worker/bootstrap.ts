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
import { MAX_LOG_CHARS, MAX_LOG_LINES } from './limits'

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
    const nameOf = (path) => basenameOf(withoutExtension(path))
    const withExtension = wanted.endsWith('.md') ? wanted : wanted + '.md'
    const direct = index.notes.find((note) => note.path === wanted || note.path === withExtension)
    if (direct) return fileOf(direct)
    const byName = index.notes.find((note) => nameOf(note.path) === nameOf(wanted))
    if (byName) return fileOf(byName)
    const byTitle = index.notes.find((note) => note.title === nameOf(wanted))
    if (byTitle) return fileOf(byTitle)
    // A library template is addressable as a file too, which is how \`include\` and \`find_tfile\` reach a
    // template by the name the reader gave it. The records arrive from TypeScript already in file shape.
    const asTemplate = index.templates.find((template) => template.name === wanted || withoutExtension(template.name) === wanted)
    return asTemplate ? fileOf(asTemplate) : null
  }

  const findFolder = (title) => {
    const wanted = normalizePath(title)
    const entry = index.folders.find((folder) => folder.path === wanted || folder.name === wanted)
    return entry ? folderOf(entry) : null
  }

  const hooks = []

  const config = { run_mode: 0, target_file: null, active_file: null, template_file: null, static: true }

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

  const option = (options, key) => (options && typeof options === 'object' ? options[key] : undefined)

  const suggester = async (textItems, items, options, throwOnCancel) => {
    const list = Array.isArray(items) ? items : []
    const labels = list.map((item, position) => (typeof textItems === 'function'
      ? String(textItems(item))
      : String((textItems ?? [])[position] ?? item)))
    // The wire carries strings, so the page is sent the display text and the answer is mapped back by
    // position. Two items shown identically resolve to the first, which is what upstream's suggester does
    // with a duplicate row too.
    const answer = await settle(callHost('system.suggester', [{
      kind: 'suggest',
      title: String(option(options, 'placeholder') ?? labels[0] ?? ''),
      values: labels,
      limit: typeof option(options, 'limit') === 'number' ? option(options, 'limit') : undefined,
      placeholder: option(options, 'placeholder') === undefined ? undefined : String(option(options, 'placeholder')),
      throwOnCancel: throwOnCancel === true,
    }]), throwOnCancel === true, null)
    if (typeof answer !== 'string') return answer
    const position = labels.indexOf(answer)
    return position === -1 ? answer : list[position]
  }

  const multiSuggester = async (textItems, items, options, defaultPicks) => {
    const list = Array.isArray(items) ? items : []
    const labels = list.map((item, position) => (typeof textItems === 'function'
      ? String(textItems(item))
      : String((textItems ?? [])[position] ?? item)))
    const picks = Array.isArray(defaultPicks) ? defaultPicks.map(String) : undefined
    const answer = await settle(callHost('system.multiSuggester', [{
      kind: 'multi-suggest',
      title: String(option(options, 'placeholder') ?? labels[0] ?? ''),
      values: labels,
      limit: typeof option(options, 'limit') === 'number' ? option(options, 'limit') : undefined,
      placeholder: option(options, 'placeholder') === undefined ? undefined : String(option(options, 'placeholder')),
      defaultPicks: picks,
      throwOnCancel: false,
    }]), false, [])
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

  const target = () => config.target_file
  const titleOf = () => (target() ? target().basename : '')
  const dateOf = (key, format, fallback) => moment(target() ? target().stat[key] : fallback, 'YYYYMMDDHHMMSS').format(format ?? 'YYYY-MM-DD HH:mm')

  const fileModule = {
    title: '',
    content: '',
    tags: () => (target() ? target().tags.slice() : []),
    cursor: cursorMarker,
    creation_date: (format) => dateOf('ctime', format, Date.now()),
    last_modified_date: (format) => dateOf('mtime', format, Date.now()),
    name: () => titleOf(),
    basename: () => titleOf(),
    folder: (absolute) => {
      const parent = target() ? target().parent : null
      if (!parent) return ''
      return absolute === true ? parent.path : parent.name
    },
    find_tfile: findByTitle,
    find_tfolder: findFolder,
  }

  const tp = {
    file: fileModule,
    // \`date\` and \`frontmatter\` are created and deliberately left empty: their bodies are the ported
    // module work, which installs onto these very objects through the handles this expression returns. A
    // template calling \`tp.date.now()\` before that layer exists gets a TypeError naming the missing
    // function, which is a report rather than a silently wrong date.
    date: {},
    frontmatter: {},
    system: {
      prompt: (text, defaultValue, throwOnCancel, multiLine, selectDefaultValue) => settle(callHost('system.prompt', [{
        kind: 'text',
        title: text === undefined ? '' : String(text),
        values: [],
        defaultValue: defaultValue === undefined ? undefined : String(defaultValue),
        multiLine: multiLine === true,
        selectDefaultValue: selectDefaultValue === true,
        throwOnCancel: throwOnCancel === true,
      }]), throwOnCancel === true, null),
      suggester,
      multi_suggester: multiSuggester,
      // Upstream's own spelling is \`multi_suggester\`; the camelCase name is what the frozen host method
      // list calls, and templates written against either should reach the same dialog.
      multiSuggester,
      clipboard: () => callHost('system.clipboard', []),
      now: () => moment().format('HH:mm:ss'),
    },
    web: {
      url_request: (url) => callHost('web.request', [{ url: String(url ?? '') }]),
      url_read: (url) => callHost('web.request', [{ url: String(url ?? '') }]),
      request: (request) => callHost('web.request', [request ?? {}]),
      daily_quote: () => callHost('web.dailyQuote', []),
      random_picture: (weight, height, query) => callHost('web.randomPicture', [
        typeof weight === 'number' ? weight : null,
        typeof height === 'number' ? height : null,
        query === undefined ? null : String(query),
      ]),
    },
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
  const obsidian = { TFile, TFolder, normalizePath, parseLinktext, Notice: noticeUnsupported }
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
    index.notes = Array.isArray(data.notes) ? data.notes : []
    index.folders = Array.isArray(data.folders) ? data.folders : []
    index.templates = Array.isArray(data.templates) ? data.templates : []
    index.target = data.target ?? null
    index.active = data.active ?? null
    index.template = data.template ?? null
    config.run_mode = typeof data.runMode === 'number' ? data.runMode : 0
    config.static = data.dynamic !== true
    config.target_file = hydrate(index.target)
    config.active_file = hydrate(index.active)
    config.template_file = hydrate(index.template)
    fileModule.title = titleOf()
    fileModule.content = typeof data.targetContent === 'string' ? data.targetContent : ''
    return true
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
        templates: snapshot.libraryTemplates.map(virtualTemplate),
        target: withPath(snapshot.target, snapshot.index),
        active: withPath(snapshot.active, snapshot.index),
        template: virtualTemplate(snapshot.template),
        runMode: runModeNumber(snapshot.mode),
        dynamic: snapshot.mode === 'dynamic-processor',
        targetContent: snapshot.target?.content ?? '',
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
 * Inkstone keeps them as rows. The translation happens here, once, so the classes inside the interpreter
 * only ever see one shape. The name is not a vault path and is not dressed up as one: it is the template's
 * own name with the extension the library stores it under.
 */
function virtualTemplate(template: { id: string; name: string; content: string } | null): Record<string, unknown> | null {
  if (!template) return null
  const dot = template.name.lastIndexOf('.')
  const named = dot > 0
  // A library row's name is the file name when it already has an extension, and gets `.md` when it does
  // not, so `tp.config.template_file.name` reads like the `<name>.md` the ported documentation shows.
  const file = named ? template.name : `${template.name}.md`
  return {
    id: template.id,
    title: named ? template.name.slice(0, dot) : template.name,
    path: file,
    name: file,
    basename: named ? template.name.slice(0, dot) : template.name,
    extension: named ? template.name.slice(dot + 1) : 'md',
    content: template.content,
    createdAt: 0,
    updatedAt: 0,
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
