/**
 * Derived from Templater 2.26.0 (AGPL-3.0-only)
 * docs/documentation.toml and docs/src/internal-functions/{overview.md, internal-modules/app-module.md,
 * config-module.md, date-module.md, file-module.md, frontmatter-module.md, hooks-module.md,
 * obsidian-module.md, system-module.md, web-module.md}, docs/src/user-functions/{overview.md,
 * script-user-functions.md}, with Inkstone adaptations.
 *
 * Names, signatures, parameter names and examples come from `documentation.toml`; the module blurbs come
 * from the matching page under `docs/src/internal-functions`. Every sentence is reached through a
 * `MessageKey` rather than written here, because this app ships no hardcoded UI copy: the prose lives in
 * the two locale catalogs and this table is what keeps them honest.
 *
 * Where the copied text only holds true inside Obsidian it was rewritten instead of shipped — a vault
 * directory, the plugin ecosystem, Obsidian's own settings and `getLanguage()`, and the parts of the
 * `obsidian` API this build does not hand out. Each rewrite says what this app actually does; see the
 * header of `./registry.ts` for the rules this table obeys.
 */
import type { ReferenceDocEntry, ReferenceModuleDoc } from './registry'

/**
 * The twelve modules the engine publishes, in the order the panel lists them.
 *
 * `dynamic` is the honest flag: four of these have member sets that are decided by the reader's own notes
 * (`tp.user`, `tp.frontmatter`) or are façades whose unknown members answer a throwing placeholder rather
 * than `undefined` (`tp.app`, `tp.obsidian`). A list under one of those is a sample, not a boundary, and
 * the panel has to be able to say so.
 */
export const REFERENCE_MODULES: readonly ReferenceModuleDoc[] = [
  {
    module: 'file',
    descriptionKey: 'templater.ref.file.module',
    dynamic: false,
  },
  {
    module: 'date',
    descriptionKey: 'templater.ref.date.module',
    dynamic: false,
  },
  {
    module: 'moment',
    descriptionKey: 'templater.ref.moment.module',
    dynamic: false,
  },
  {
    module: 'system',
    descriptionKey: 'templater.ref.system.module',
    dynamic: false,
  },
  {
    module: 'web',
    descriptionKey: 'templater.ref.web.module',
    dynamic: false,
  },
  {
    module: 'frontmatter',
    descriptionKey: 'templater.ref.frontmatter.module',
    dynamic: true,
  },
  {
    module: 'config',
    descriptionKey: 'templater.ref.config.module',
    dynamic: false,
  },
  {
    module: 'hooks',
    descriptionKey: 'templater.ref.hooks.module',
    dynamic: false,
  },
  {
    module: 'user',
    descriptionKey: 'templater.ref.user.module',
    dynamic: true,
  },
  {
    module: 'base',
    descriptionKey: 'templater.ref.base.module',
    dynamic: false,
  },
  {
    module: 'obsidian',
    descriptionKey: 'templater.ref.obsidian.module',
    dynamic: true,
  },
  {
    module: 'app',
    descriptionKey: 'templater.ref.app.module',
    dynamic: true,
  },
]

/**
 * Every documented member: the 32 upstream variables and functions, the `moment` object and `tp.base` this
 * build publishes, the members of the `tp.obsidian` façade that really exist here, and one placeholder
 * entry each for the run-time namespaces the engine cannot enumerate.
 */
export const REFERENCE_ENTRIES: readonly ReferenceDocEntry[] = [
  {
    module: 'app',
    name: 'fileManager',
    signature: 'tp.app.fileManager',
    descriptionKey: 'templater.ref.app.file_manager.description',
    args: [],
    examples: ['<% typeof tp.app.fileManager.renameFile %>'],
  },
  {
    module: 'app',
    name: 'metadataCache',
    signature: 'tp.app.metadataCache',
    descriptionKey: 'templater.ref.app.metadata_cache.description',
    args: [],
    examples: ['<% typeof tp.app.metadataCache.getFileCache %>'],
  },
  {
    module: 'app',
    name: 'vault',
    signature: 'tp.app.vault',
    descriptionKey: 'templater.ref.app.vault.description',
    args: [],
    examples: ['<% typeof tp.app.vault.read %>'],
  },
  {
    module: 'app',
    name: 'workspace',
    signature: 'tp.app.workspace',
    descriptionKey: 'templater.ref.app.workspace.description',
    args: [],
    examples: ['<% typeof tp.app.workspace.activeEditor %>'],
  },
  {
    module: 'base',
    name: 'getFileLink',
    signature: 'tp.base.getFileLink(file_or_link: TFile | string)',
    descriptionKey: 'templater.ref.base.get_file_link.description',
    args: [
      { name: 'file_or_link', descriptionKey: 'templater.ref.base.get_file_link.arg.file_or_link' },
    ],
    returnsKey: 'templater.ref.base.get_file_link.returns',
    examples: [
      '<% tp.base.getFileLink(tp.config.target_file) %>',
      '<% tp.base.getFileLink("Reading/MyNote.md") %>',
    ],
  },
  {
    module: 'config',
    name: 'active_file',
    signature: 'tp.config.active_file',
    descriptionKey: 'templater.ref.config.active_file.description',
    args: [],
    examples: ['<% tp.config.active_file.path %>'],
  },
  {
    module: 'config',
    name: 'run_mode',
    signature: 'tp.config.run_mode',
    descriptionKey: 'templater.ref.config.run_mode.description',
    args: [],
    examples: ['<% tp.config.run_mode %>'],
  },
  {
    module: 'config',
    name: 'target_file',
    signature: 'tp.config.target_file',
    descriptionKey: 'templater.ref.config.target_file.description',
    args: [],
    examples: ['<% tp.config.target_file.basename %>'],
  },
  {
    module: 'config',
    name: 'template_file',
    signature: 'tp.config.template_file',
    descriptionKey: 'templater.ref.config.template_file.description',
    args: [],
    examples: ['<% tp.config.template_file.basename %>'],
  },
  {
    module: 'date',
    name: 'now',
    signature: 'tp.date.now(format: string = "YYYY-MM-DD", offset?: number | string, reference?: string, reference_format?: string)',
    descriptionKey: 'templater.ref.date.now.description',
    args: [
      { name: 'format', descriptionKey: 'templater.ref.date.now.arg.format' },
      { name: 'offset', descriptionKey: 'templater.ref.date.now.arg.offset' },
      { name: 'reference', descriptionKey: 'templater.ref.date.now.arg.reference' },
      { name: 'reference_format', descriptionKey: 'templater.ref.date.now.arg.reference_format' },
    ],
    returnsKey: 'templater.ref.date.now.returns',
    examples: [
      '<% tp.date.now() %>',
      '<% tp.date.now("Do MMMM YYYY") %>',
      '<% tp.date.now("YYYY-MM-DD", -7) %>',
      '<% tp.date.now("YYYY-MM-DD", 7) %>',
      '<% tp.date.now("YYYY-MM-DD", "P-1M") %>',
      '<% tp.date.now("YYYY-MM-DD", "P1Y") %>',
      '<% tp.date.now("YYYY-MM-DD", 1, tp.file.title, "YYYY-MM-DD") %>',
      '<% tp.date.now("YYYY-MM-DD", -1, tp.file.title, "YYYY-MM-DD") %>',
    ],
  },
  {
    module: 'date',
    name: 'tomorrow',
    signature: 'tp.date.tomorrow(format: string = "YYYY-MM-DD")',
    descriptionKey: 'templater.ref.date.tomorrow.description',
    args: [
      { name: 'format', descriptionKey: 'templater.ref.date.tomorrow.arg.format' },
    ],
    returnsKey: 'templater.ref.date.tomorrow.returns',
    examples: [
      '<% tp.date.tomorrow() %>',
      '<% tp.date.tomorrow("Do MMMM YYYY") %>',
    ],
  },
  {
    module: 'date',
    name: 'weekday',
    signature: 'tp.date.weekday(format: string = "YYYY-MM-DD", weekday: number, reference?: string, reference_format?: string)',
    descriptionKey: 'templater.ref.date.weekday.description',
    args: [
      { name: 'format', descriptionKey: 'templater.ref.date.weekday.arg.format' },
      { name: 'weekday', descriptionKey: 'templater.ref.date.weekday.arg.weekday' },
      { name: 'reference', descriptionKey: 'templater.ref.date.weekday.arg.reference' },
      { name: 'reference_format', descriptionKey: 'templater.ref.date.weekday.arg.reference_format' },
    ],
    returnsKey: 'templater.ref.date.weekday.returns',
    examples: [
      '<% tp.date.weekday("YYYY-MM-DD", 0) %>',
      '<% tp.date.weekday("YYYY-MM-DD", 7) %>',
      '<% tp.date.weekday("YYYY-MM-DD", 0, tp.file.title, "YYYY-MM-DD") %>',
      '<% tp.date.weekday("YYYY-MM-DD", -7, tp.file.title, "YYYY-MM-DD") %>',
    ],
  },
  {
    module: 'date',
    name: 'yesterday',
    signature: 'tp.date.yesterday(format: string = "YYYY-MM-DD")',
    descriptionKey: 'templater.ref.date.yesterday.description',
    args: [
      { name: 'format', descriptionKey: 'templater.ref.date.yesterday.arg.format' },
    ],
    returnsKey: 'templater.ref.date.yesterday.returns',
    examples: [
      '<% tp.date.yesterday() %>',
      '<% tp.date.yesterday("Do MMMM YYYY") %>',
    ],
  },
  {
    module: 'file',
    name: 'content',
    signature: 'tp.file.content',
    descriptionKey: 'templater.ref.file.content.description',
    args: [],
    examples: ['<% tp.file.content %>'],
  },
  {
    module: 'file',
    name: 'create_new',
    signature: 'tp.file.create_new(template: TFile | string, filename: string = "Untitled", open_new: boolean = false, folder?: TFolder | string)',
    descriptionKey: 'templater.ref.file.create_new.description',
    args: [
      { name: 'template', descriptionKey: 'templater.ref.file.create_new.arg.template' },
      { name: 'filename', descriptionKey: 'templater.ref.file.create_new.arg.filename' },
      { name: 'open_new', descriptionKey: 'templater.ref.file.create_new.arg.open_new' },
      { name: 'folder', descriptionKey: 'templater.ref.file.create_new.arg.folder' },
    ],
    returnsKey: 'templater.ref.file.create_new.returns',
    examples: [
      '<%* await tp.file.create_new("MyFileContent", "MyFilename") %>',
      '<%* await tp.file.create_new(tp.file.find_tfile("MyTemplate"), "MyFilename") %>',
      '<%* await tp.file.create_new("MyFileContent", "MyFilename", true) %>',
      '<%* await tp.file.create_new("MyFileContent", "MyFilename", false, tp.file.folder(true)) %>',
      '<%* await tp.file.create_new("MyFileContent", "MyFilename", false, "Path/To/MyFolder") %>',
      '<%* await tp.file.create_new("MyFileContent", "MyFilename", false, tp.config.target_file.parent) %>',
      '[[<% (await tp.file.create_new("MyFileContent", "MyFilename")).basename %>]]',
    ],
    requires: ['createNotes'],
  },
  {
    module: 'file',
    name: 'creation_date',
    signature: 'tp.file.creation_date(format: string = "YYYY-MM-DD HH:mm")',
    descriptionKey: 'templater.ref.file.creation_date.description',
    args: [
      { name: 'format', descriptionKey: 'templater.ref.file.creation_date.arg.format' },
    ],
    returnsKey: 'templater.ref.file.creation_date.returns',
    examples: [
      '<% tp.file.creation_date() %>',
      '<% tp.file.creation_date("dddd Do MMMM YYYY HH:mm") %>',
    ],
  },
  {
    module: 'file',
    name: 'cursor',
    signature: 'tp.file.cursor(order?: number)',
    descriptionKey: 'templater.ref.file.cursor.description',
    args: [
      { name: 'order', descriptionKey: 'templater.ref.file.cursor.arg.order' },
    ],
    returnsKey: 'templater.ref.file.cursor.returns',
    examples: [
      '<% tp.file.cursor() %>',
      '<% tp.file.cursor(1) %>Content<% tp.file.cursor(1) %>',
      '<% tp.file.cursor(1) %>Content<% tp.file.cursor(1.5) %>Content<% tp.file.cursor(2) %>',
    ],
  },
  {
    module: 'file',
    name: 'cursor_append',
    signature: 'tp.file.cursor_append(content: string)',
    descriptionKey: 'templater.ref.file.cursor_append.description',
    args: [
      { name: 'content', descriptionKey: 'templater.ref.file.cursor_append.arg.content' },
    ],
    returnsKey: 'templater.ref.file.cursor_append.returns',
    examples: ['<% tp.file.cursor_append("Some text") %>'],
    requires: ['writeActiveNote'],
  },
  {
    module: 'file',
    name: 'exists',
    signature: 'tp.file.exists(filepath: string)',
    descriptionKey: 'templater.ref.file.exists.description',
    args: [
      { name: 'filepath', descriptionKey: 'templater.ref.file.exists.arg.filepath' },
    ],
    returnsKey: 'templater.ref.file.exists.returns',
    examples: [
      '<% await tp.file.exists("MyFolder/MyFile.md") %>',
      '<% await tp.file.exists(tp.file.folder(true) + "/" + tp.file.title + ".md") %>',
    ],
    requires: ['readOtherNotes'],
  },
  {
    module: 'file',
    name: 'find_tfile',
    signature: 'tp.file.find_tfile(filename: string)',
    descriptionKey: 'templater.ref.file.find_tfile.description',
    args: [
      { name: 'filename', descriptionKey: 'templater.ref.file.find_tfile.arg.filename' },
    ],
    returnsKey: 'templater.ref.file.find_tfile.returns',
    examples: [
      '<% tp.file.find_tfile("MyFile").basename %>',
      '<% tp.file.find_tfile("Folder/MyFile.md").path %>',
    ],
  },
  {
    module: 'file',
    name: 'folder',
    signature: 'tp.file.folder(absolute: boolean = false)',
    descriptionKey: 'templater.ref.file.folder.description',
    args: [
      { name: 'absolute', descriptionKey: 'templater.ref.file.folder.arg.absolute' },
    ],
    returnsKey: 'templater.ref.file.folder.returns',
    examples: [
      '<% tp.file.folder() %>',
      '<% tp.file.folder(true) %>',
    ],
  },
  {
    module: 'file',
    name: 'include',
    signature: 'tp.file.include(include_link: string | TFile)',
    descriptionKey: 'templater.ref.file.include.description',
    args: [
      { name: 'include_link', descriptionKey: 'templater.ref.file.include.arg.include_link' },
    ],
    returnsKey: 'templater.ref.file.include.returns',
    examples: [
      '<% await tp.file.include("[[Template1]]") %>',
      '<% await tp.file.include(tp.file.find_tfile("MyFile")) %>',
      '<% await tp.file.include("[[MyFile#Section1]]") %>',
      '<% await tp.file.include("[[MyFile#^block1]]") %>',
    ],
    requires: ['readOtherNotes'],
  },
  {
    module: 'file',
    name: 'last_modified_date',
    signature: 'tp.file.last_modified_date(format: string = "YYYY-MM-DD HH:mm")',
    descriptionKey: 'templater.ref.file.last_modified_date.description',
    args: [
      { name: 'format', descriptionKey: 'templater.ref.file.last_modified_date.arg.format' },
    ],
    returnsKey: 'templater.ref.file.last_modified_date.returns',
    examples: [
      '<% tp.file.last_modified_date() %>',
      '<% tp.file.last_modified_date("dddd Do MMMM YYYY HH:mm") %>',
    ],
  },
  {
    module: 'file',
    name: 'move',
    signature: 'tp.file.move(new_path: string, file_to_move?: TFile)',
    descriptionKey: 'templater.ref.file.move.description',
    args: [
      { name: 'new_path', descriptionKey: 'templater.ref.file.move.arg.new_path' },
      { name: 'file_to_move', descriptionKey: 'templater.ref.file.move.arg.file_to_move' },
    ],
    returnsKey: 'templater.ref.file.move.returns',
    examples: [
      '<%* await tp.file.move("Notes/" + tp.file.title) %>',
      '<%* await tp.file.move("Notes/NewTitle") %>',
    ],
    requires: ['moveNotes'],
  },
  {
    module: 'file',
    name: 'path',
    signature: 'tp.file.path(relative: boolean = false)',
    descriptionKey: 'templater.ref.file.path.description',
    args: [
      { name: 'relative', descriptionKey: 'templater.ref.file.path.arg.relative' },
    ],
    returnsKey: 'templater.ref.file.path.returns',
    examples: [
      '<% tp.file.path() %>',
      '<% tp.file.path(true) %>',
    ],
  },
  {
    module: 'file',
    name: 'rename',
    signature: 'tp.file.rename(new_title: string)',
    descriptionKey: 'templater.ref.file.rename.description',
    args: [
      { name: 'new_title', descriptionKey: 'templater.ref.file.rename.arg.new_title' },
    ],
    returnsKey: 'templater.ref.file.rename.returns',
    examples: [
      '<%* await tp.file.rename("MyNewName") %>',
      '<%* await tp.file.rename(tp.file.title + "2") %>',
    ],
    requires: ['moveNotes'],
  },
  {
    module: 'file',
    name: 'selection',
    signature: 'tp.file.selection()',
    descriptionKey: 'templater.ref.file.selection.description',
    args: [],
    returnsKey: 'templater.ref.file.selection.returns',
    examples: ['<% tp.file.selection() %>'],
  },
  {
    module: 'file',
    name: 'tags',
    signature: 'tp.file.tags',
    descriptionKey: 'templater.ref.file.tags.description',
    args: [],
    examples: ['<% tp.file.tags %>'],
  },
  {
    module: 'file',
    name: 'title',
    signature: 'tp.file.title',
    descriptionKey: 'templater.ref.file.title.description',
    args: [],
    examples: [
      '<% tp.file.title %>',
      '<% tp.file.title.split(" ")[1] %>',
    ],
  },
  {
    module: 'frontmatter',
    name: 'key',
    signature: 'tp.frontmatter.<key>',
    descriptionKey: 'templater.ref.frontmatter.key.description',
    args: [],
    examples: [
      '<% tp.frontmatter.alias %>',
      '<% tp.frontmatter["note type"] %>',
      '<% tp.frontmatter.categories.map((prop) => "  - \\"" + prop + "\\"").join("\\n") %>',
    ],
    dynamic: true,
  },
  {
    module: 'hooks',
    name: 'on_all_templates_executed',
    signature: 'tp.hooks.on_all_templates_executed(callback_function: () => any)',
    descriptionKey: 'templater.ref.hooks.on_all_templates_executed.description',
    args: [
      { name: 'callback_function', descriptionKey: 'templater.ref.hooks.on_all_templates_executed.arg.callback_function' },
    ],
    returnsKey: 'templater.ref.hooks.on_all_templates_executed.returns',
    examples: [
      '<%*\ntp.hooks.on_all_templates_executed(() => {\n  console.log("the template is done writing");\n});\n%>',
      '<%*\ntp.hooks.on_all_templates_executed(async () => {\n  await tp.file.rename(tp.file.title + " (done)");\n});\n%>',
    ],
    requires: ['writeActiveNote'],
  },
  {
    module: 'moment',
    name: 'moment',
    signature: 'moment(input?: string | number, format?: string)',
    descriptionKey: 'templater.ref.moment.moment.description',
    args: [
      { name: 'input', descriptionKey: 'templater.ref.moment.moment.arg.input' },
      { name: 'format', descriptionKey: 'templater.ref.moment.moment.arg.format' },
    ],
    returnsKey: 'templater.ref.moment.moment.returns',
    examples: [
      '<% moment(tp.file.title, "YYYY-MM-DD").format("YYYY-MM-DD") %>',
      '<% moment(tp.file.title, "YYYY-MM-DD").startOf("month").format("YYYY-MM-DD") %>',
      '<% moment(tp.file.title, "YYYY-MM-DD").endOf("month").format("YYYY-MM-DD") %>',
    ],
  },
  {
    module: 'obsidian',
    name: 'Notice',
    signature: 'tp.obsidian.Notice(content: string)',
    descriptionKey: 'templater.ref.obsidian.notice.description',
    args: [
      { name: 'content', descriptionKey: 'templater.ref.obsidian.notice.arg.content' },
    ],
    returnsKey: 'templater.ref.obsidian.notice.returns',
    examples: ['<%* new tp.obsidian.Notice("done") %>'],
  },
  {
    module: 'obsidian',
    name: 'TFile',
    signature: 'tp.obsidian.TFile',
    descriptionKey: 'templater.ref.obsidian.t_file.description',
    args: [],
    examples: [
      '<% tp.file.find_tfile("MyFile") instanceof tp.obsidian.TFile %>',
      '<% tp.config.target_file.path + " (" + tp.config.target_file.extension + ")" %>',
    ],
  },
  {
    module: 'obsidian',
    name: 'TFolder',
    signature: 'tp.obsidian.TFolder',
    descriptionKey: 'templater.ref.obsidian.t_folder.description',
    args: [],
    examples: [
      '<% tp.config.target_file.parent instanceof tp.obsidian.TFolder %>',
      '<% tp.config.target_file.parent.children.map((child) => child.name).join(", ") %>',
    ],
  },
  {
    module: 'obsidian',
    name: 'getAllTags',
    signature: 'tp.obsidian.getAllTags(cache)',
    descriptionKey: 'templater.ref.obsidian.get_all_tags.description',
    args: [
      { name: 'cache', descriptionKey: 'templater.ref.obsidian.get_all_tags.arg.cache' },
    ],
    returnsKey: 'templater.ref.obsidian.get_all_tags.returns',
    examples: ['<% tp.obsidian.getAllTags(tp.config.target_file) %>'],
  },
  {
    module: 'obsidian',
    name: 'normalizePath',
    signature: 'tp.obsidian.normalizePath(path: string)',
    descriptionKey: 'templater.ref.obsidian.normalize_path.description',
    args: [
      { name: 'path', descriptionKey: 'templater.ref.obsidian.normalize_path.arg.path' },
    ],
    returnsKey: 'templater.ref.obsidian.normalize_path.returns',
    examples: ['<% tp.obsidian.normalizePath("Folder//My Note.md/") %>'],
  },
  {
    module: 'obsidian',
    name: 'parseLinktext',
    signature: 'tp.obsidian.parseLinktext(linktext: string)',
    descriptionKey: 'templater.ref.obsidian.parse_linktext.description',
    args: [
      { name: 'linktext', descriptionKey: 'templater.ref.obsidian.parse_linktext.arg.linktext' },
    ],
    returnsKey: 'templater.ref.obsidian.parse_linktext.returns',
    examples: [
      '<% tp.obsidian.parseLinktext("MyFile#Section1").path %>',
      '<%* const link = tp.obsidian.parseLinktext("MyFile#^block1");\ntR += link.path + "|" + link.subpath.type + "|" + link.subpath.target %>',
    ],
  },
  {
    module: 'system',
    name: 'clipboard',
    signature: 'tp.system.clipboard()',
    descriptionKey: 'templater.ref.system.clipboard.description',
    args: [],
    returnsKey: 'templater.ref.system.clipboard.returns',
    examples: ['<% tp.system.clipboard() %>'],
    requires: ['clipboard'],
  },
  {
    module: 'system',
    name: 'multi_suggester',
    signature: 'tp.system.multi_suggester(text_items: string[] | ((item: T) => string), items: T[], throw_on_cancel: boolean = false, title: string = "", limit?: number = undefined, default_values?: T[] = undefined)',
    descriptionKey: 'templater.ref.system.multi_suggester.description',
    args: [
      { name: 'text_items', descriptionKey: 'templater.ref.system.multi_suggester.arg.text_items' },
      { name: 'items', descriptionKey: 'templater.ref.system.multi_suggester.arg.items' },
      { name: 'throw_on_cancel', descriptionKey: 'templater.ref.system.multi_suggester.arg.throw_on_cancel' },
      { name: 'title', descriptionKey: 'templater.ref.system.multi_suggester.arg.title' },
      { name: 'limit', descriptionKey: 'templater.ref.system.multi_suggester.arg.limit' },
      { name: 'default_values', descriptionKey: 'templater.ref.system.multi_suggester.arg.default_values' },
    ],
    returnsKey: 'templater.ref.system.multi_suggester.returns',
    examples: [
      '<% await tp.system.multi_suggester(["Happy", "Sad", "Confused"], ["Happy", "Sad", "Confused"]) %>',
      '<% await tp.system.multi_suggester((item) => item, ["Happy", "Sad", "Confused"]) %>',
      '<% (await tp.system.multi_suggester((file) => file.basename, tp.config.target_file.parent.children)).map((file) => "[[" + file.basename + "]]") %>',
      '<% await tp.system.multi_suggester((tag) => tag, tp.file.tags.map((tag) => tag.slice(1))) %>',
      '<%*\nlet selectedValues = await tp.system.multi_suggester(["Happy", "Sad", "Confused"], ["Happy", "Sad", "Confused"]);\n%>\n# <% selectedValues %>\nselected values: <% selectedValues %>',
      '<%*\nlet selectedValues = await tp.system.multi_suggester(["Happy", "Sad", "Confused"], ["Happy", "Sad", "Confused"], false, "", undefined, ["Happy", "Confused"]);\n%>\n# <% selectedValues %>\nselected values: <% selectedValues %>',
    ],
    requires: ['prompt'],
  },
  {
    module: 'system',
    name: 'prompt',
    signature: 'tp.system.prompt(prompt_text?: string, default_value?: string, throw_on_cancel: boolean = false, multiline?: boolean = false, select_default_value?: boolean = false)',
    descriptionKey: 'templater.ref.system.prompt.description',
    args: [
      { name: 'prompt_text', descriptionKey: 'templater.ref.system.prompt.arg.prompt_text' },
      { name: 'default_value', descriptionKey: 'templater.ref.system.prompt.arg.default_value' },
      { name: 'throw_on_cancel', descriptionKey: 'templater.ref.system.prompt.arg.throw_on_cancel' },
      { name: 'multiline', descriptionKey: 'templater.ref.system.prompt.arg.multiline' },
      { name: 'select_default_value', descriptionKey: 'templater.ref.system.prompt.arg.select_default_value' },
    ],
    returnsKey: 'templater.ref.system.prompt.returns',
    examples: [
      '<% await tp.system.prompt("Please enter a value") %>',
      '<% await tp.system.prompt("What is your mood today?", "happy") %>',
      '<% await tp.system.prompt("What is your mood today?", null, false, true) %>',
      '<% await tp.system.prompt("What is your mood today?", "Input a mood...", false, false, true) %>',
      '<%*\nlet value = await tp.system.prompt("Please enter a value");\n%>\n# <% value %>\nselected value: <% value %>',
    ],
    requires: ['prompt'],
  },
  {
    module: 'system',
    name: 'suggester',
    signature: 'tp.system.suggester(text_items: string[] | ((item: T) => string), items: T[], throw_on_cancel: boolean = false, placeholder: string = "", limit?: number = undefined, default_value?: T = undefined)',
    descriptionKey: 'templater.ref.system.suggester.description',
    args: [
      { name: 'text_items', descriptionKey: 'templater.ref.system.suggester.arg.text_items' },
      { name: 'items', descriptionKey: 'templater.ref.system.suggester.arg.items' },
      { name: 'throw_on_cancel', descriptionKey: 'templater.ref.system.suggester.arg.throw_on_cancel' },
      { name: 'placeholder', descriptionKey: 'templater.ref.system.suggester.arg.placeholder' },
      { name: 'limit', descriptionKey: 'templater.ref.system.suggester.arg.limit' },
      { name: 'default_value', descriptionKey: 'templater.ref.system.suggester.arg.default_value' },
    ],
    returnsKey: 'templater.ref.system.suggester.returns',
    examples: [
      '<% await tp.system.suggester(["Happy", "Sad", "Confused"], ["Happy", "Sad", "Confused"]) %>',
      '<% await tp.system.suggester((item) => item, ["Happy", "Sad", "Confused"]) %>',
      '<% (await tp.system.suggester((file) => file.basename, tp.config.target_file.parent.children)).basename %>',
      '<% await tp.system.suggester((tag) => tag, tp.file.tags.map((tag) => tag.slice(1))) %>',
      '<%*\nlet selectedValue = await tp.system.suggester(["Happy", "Sad", "Confused"], ["Happy", "Sad", "Confused"]);\n%>\n# <% selectedValue %>\nselected value: <% selectedValue %>',
      '<%*\nlet selectedValue = await tp.system.suggester(["Happy", "Sad", "Confused"], ["Happy", "Sad", "Confused"], false, "", undefined, "Confused");\n%>\n# <% selectedValue %>\nselected value: <% selectedValue %>',
    ],
    requires: ['prompt'],
  },
  {
    module: 'user',
    name: 'script_name',
    signature: 'tp.user.<script_name>(...)',
    descriptionKey: 'templater.ref.user.script_name.description',
    args: [],
    returnsKey: 'templater.ref.user.script_name.returns',
    examples: [
      '<% tp.user.my_script("Hello World!") %>',
      '<% tp.user.my_script.note("Line 1\\nLine2") %>',
      '<% tp.user.my_script(tp) %>',
    ],
    dynamic: true,
    requires: ['userScripts'],
  },
  {
    module: 'web',
    name: 'daily_quote',
    signature: 'tp.web.daily_quote(language?: string)',
    descriptionKey: 'templater.ref.web.daily_quote.description',
    args: [
      { name: 'language', descriptionKey: 'templater.ref.web.daily_quote.arg.language' },
    ],
    returnsKey: 'templater.ref.web.daily_quote.returns',
    examples: [
      '<% await tp.web.daily_quote() %>',
      '<% await tp.web.daily_quote("es") %>',
    ],
    requires: ['web'],
  },
  {
    module: 'web',
    name: 'random_picture',
    signature: 'tp.web.random_picture(size: string, query?: string, include_size?: boolean)',
    descriptionKey: 'templater.ref.web.random_picture.description',
    args: [
      { name: 'size', descriptionKey: 'templater.ref.web.random_picture.arg.size' },
      { name: 'query', descriptionKey: 'templater.ref.web.random_picture.arg.query' },
      { name: 'include_size', descriptionKey: 'templater.ref.web.random_picture.arg.include_size' },
    ],
    returnsKey: 'templater.ref.web.random_picture.returns',
    examples: [
      '<% await tp.web.random_picture("200x200") %>',
      '<% await tp.web.random_picture("200x200", "landscape,water") %>',
      '<% await tp.web.random_picture("200x200", "landscape", true) %>',
    ],
    requires: ['web'],
  },
  {
    module: 'web',
    name: 'request',
    signature: 'tp.web.request(url: string, path?: string)',
    descriptionKey: 'templater.ref.web.request.description',
    args: [
      { name: 'url', descriptionKey: 'templater.ref.web.request.arg.url' },
      { name: 'path', descriptionKey: 'templater.ref.web.request.arg.path' },
    ],
    returnsKey: 'templater.ref.web.request.returns',
    examples: [
      '<% await tp.web.request("https://jsonplaceholder.typicode.com/todos/1") %>',
      '<% await tp.web.request("https://jsonplaceholder.typicode.com/todos", "0.title") %>',
    ],
    requires: ['web'],
  },
]
