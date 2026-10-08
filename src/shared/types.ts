


import type { CoverPosition, CoverShape } from './property-decorations'

export type UserRole = 'owner' | 'member'

export interface PublicUser {
  id: string
  login: string
  name: string
  avatarUrl: string
  role: UserRole
  createdAt: number

  username: string
}

export interface SiteInfo {
  name: string

  initialized: boolean

  registrationOpen: boolean

  r2Enabled: boolean

  kvEnabled: boolean

  attachmentStorage: 'r2' | 'kv' | null

  realtimeEnabled: boolean
  version?: string
}

export interface SessionInfo {
  user: PublicUser | null
  site: SiteInfo
  settings: UserSettings | null
}

export interface TotpLoginChallenge {
  twoFactorRequired: true
  challengeToken: string
  expiresAt: number
}

export type PasswordLoginResult = SessionInfo | TotpLoginChallenge

export type TotpLoginResult = SessionInfo & {
  recoveryCodeUsed: boolean
  recoveryCodesRemaining: number | null
}

export interface TotpStatus {
  available: boolean
  enabled: boolean
  enabledAt: number | null
  recoveryCodesRemaining: number
}

export interface TotpSetupInfo {
  setupToken: string
  secret: string
  uri: string
  expiresAt: number
}

export interface TotpRecoveryCodesResult {
  recoveryCodes: string[]
  recoveryCodesRemaining: number
  generatedAt: number
}

export type UpdateCheckStatus = 'ok' | 'unavailable'

export interface UpdateCheckResponse {
  currentVersion: string
  latestVersion: string | null
  updateUrl: string | null
  checkedAt: number | null
  status: UpdateCheckStatus
}


export type ThemePref = 'light' | 'dark' | 'system'
export type AppLocale = 'zh-CN' | 'en-US'
export type AccentName = 'cinnabar' | 'indigo' | 'celadon' | 'amber' | 'terracotta' | 'wisteria' | 'graphite'
export type BackgroundName = 'paper' | 'white'
export type UiDensity = 'comfortable' | 'compact'
export type ProseFont = 'sans' | 'serif'
export type ProseWidth = 'narrow' | 'normal' | 'wide' | 'full'
export type EditorLayout = 'live' | 'split' | 'preview'
export type BackupSchedule = 'off' | 'hourly' | 'sixHourly' | 'daily' | 'weekly' | 'monthly' | 'yearly'

import type { LinterSettings } from './linter'

export interface AppearanceSettings {
  language: AppLocale
  theme: ThemePref
  accent: AccentName
  background: BackgroundName
  density: UiDensity
  proseFont: ProseFont
  proseSize: number
  proseWidth: ProseWidth
  proseLineHeight: number
}

export interface EditorSettings {
  fontSize: number
  fontFamily: 'mono' | 'sans'
  lineNumbers: boolean
  typewriter: boolean
  focusMode: boolean
  spellcheck: boolean
  showToolbar: boolean
  livePreview: boolean
  tabSize: number
  autoSaveDelay: number
  codeFormatKeywordCase: CodeFormatKeywordCase
  emojiToolbarButton: boolean
  emojiInsertFormat: EmojiInsertFormat
  emojiSkinTone: SkinTone
  linkEditor: boolean
  linkEditorTrigger: LinkEditorTrigger
  linkEditorModifier: LinkEditorModifier
  linkEditorSuggest: boolean
  linkEditorValidate: boolean
  linkEditorSyncAlias: boolean
  linkEditorAliasMode: LinkEditorAliasMode
  linkEditorAliasSeparator: string
  linkEditorKeepsText: boolean
  linkEditorEmbedToggle: boolean
  linkEditorPadNew: boolean
  linkEditorQuickSelect: boolean
  pasteLink: boolean
  pasteLinkReverse: boolean
  pasteLinkNothing: PasteLinkNothing
  pasteLinkImageEmbed: boolean
  pasteLinkBareAddress: boolean
  pasteLinkInternalNote: boolean
  pasteLinkRetarget: boolean
  outliner: boolean
  outlinerEnter: boolean
  outlinerShiftEnter: boolean
  outlinerTab: boolean
  outlinerCursor: OutlinerCursorStick
  outlinerSelectAll: boolean
  outlinerMoveKeys: boolean
  outlinerFoldKeys: boolean
  outlinerGuides: boolean
  outlinerGuideClick: OutlinerGuideClick
  outlinerDrag: boolean
  dragger: boolean
  draggerHandles: DraggerHandleVisibility
  draggerHandleIcon: DraggerHandleIcon
  draggerHandleGlyph: string
  draggerHandleSize: number
  draggerHandleOffset: number
  draggerHandleSide: DraggerGutterSide
  draggerHandleColorMode: DraggerColorMode
  draggerHandleColor: string
  draggerIndicatorColorMode: DraggerColorMode
  draggerIndicatorColor: string
  draggerMultiSelect: boolean
  draggerMultiSelectMs: number
  draggerMobileArmMs: number
  draggerAutoScroll: boolean
  draggerAutoScrollEdge: number
  draggerAutoScrollSpeed: number
  draggerHighlight: boolean
  draggerSelectionStyle: DraggerSelectionStyle
  draggerMobileTextDrag: boolean
  draggerExitDragModeAfterDrop: boolean
  draggerDragModeButton: boolean
  draggerMoveKeys: boolean
  draggerMenuOrders: DraggerMenuOrders
  draggerBlockStyles: DraggerBlockStyle[]
}

/** When the block handle shows itself: on the hovered block, on every block, or never. */
export type DraggerHandleVisibility = 'hover' | 'always' | 'hidden'

/** The handle's drawn shape. `custom` renders `draggerHandleGlyph` instead of a built-in. */
export type DraggerHandleIcon = 'dot' | 'grip-dots' | 'grip-lines' | 'square' | 'custom'

/** Which side of the text the handle sits on. */
export type DraggerGutterSide = 'left' | 'right'

/** Theme follows the account's accent; custom uses the stored hex color. */
export type DraggerColorMode = 'theme' | 'custom'

/** How the block being dragged, and a list drop area, are painted. */
export type DraggerSelectionStyle = 'outline' | 'subtle' | 'filled'

/** One entry of the handle's popup menu, in the order the reader wants them. */
export type DraggerMenuRootItemId =
  | 'paragraph'
  | 'heading'
  | 'list'
  | 'quote'
  | 'callout'
  | 'code-block'
  | 'math-block'
  | 'custom'

/** The four submenus' rows: heading levels, list marker kinds, callout flavors, saved styles. */
export type DraggerMenuGroupId = 'heading' | 'list' | 'callout' | 'custom'

export interface DraggerMenuOrders {
  root: DraggerMenuRootItemId[]
  heading: string[]
  list: string[]
  callout: string[]
  custom: string[]
}

/**
 * A block style the reader defined: the markdown the menu writes, and the copy the menu shows.
 *
 * `template` holds the block's text as `${content}` and may name other tokens that `variables`
 * fills in; `linePrefix` is put in front of every line of the content, which is what makes a
 * callout's `> ` run down the block instead of only its first line.
 */
export interface DraggerBlockStyle {
  id: string
  label: string
  /** A glyph the menu shows before the label — emoji or short text, never markup. */
  icon: string
  template: string
  linePrefix?: string
  variables?: Record<string, string>
}

/** What a paste does when the author selected nothing: the plain paste, the word under the caret, an
 * empty `[](url)` with the caret waiting inside the brackets, or the bare `<url>` autolink. */
export type PasteLinkNothing = 'plain' | 'word' | 'inline' | 'bare'

export type OutlinerCursorStick = 'never' | 'bullet' | 'bullet-and-checkbox'

export type OutlinerGuideClick = 'none' | 'fold'

/** Which gesture opens the inline link editor over a link. */
export type LinkEditorTrigger = 'click' | 'double-click'

/** The key that has to be held for that gesture to open the editor. */
export type LinkEditorModifier = 'none' | 'ctrl' | 'alt' | 'shift'

/** How a picked heading names itself in the display-text field. */
export type LinkEditorAliasMode = 'heading' | 'note-then-heading' | 'heading-then-note'

export type CodeFormatKeywordCase = 'upper' | 'lower' | 'keep'

/** 0 draws the glyph as the set ships it; 1-5 are the Fitzpatrick modifiers, light to dark. */
export type SkinTone = 0 | 1 | 2 | 3 | 4 | 5

/** What picking an emoji writes: the glyph itself, or the `:code:` that stands for it. */
export type EmojiInsertFormat = 'native' | 'shortcode'

export type PinnedWindowSizeName = 'small' | 'medium' | 'large' | 'custom'
export type OutlineModeName = 'sidebar' | 'floating-always' | 'floating-hover' | 'floating-circle'
export type OutlineAutoExpandName = 'off' | 'ancestors'
export type OutlineTextDirectionName = 'system' | 'text'

export interface PreviewSettings {
  layout: EditorLayout
  syncScroll: boolean
  showToc: boolean
  outlineMode: OutlineModeName
  outlineDefaultLevel: number
  outlineShowProgress: boolean
  outlineAutoExpand: OutlineAutoExpandName
  outlineTooltipSide: 'left' | 'right'
  outlineTruncateLength: number
  outlineMarkdownLabels: boolean
  outlineHoverPeek: boolean
  outlineTextDirection: OutlineTextDirectionName
  outlineShowReadingTime: boolean
  outlineReadingSpeed: number
  outlineDragEdits: boolean
  outlineKeepSearch: boolean
  outlineLocateByCursor: boolean
  /** Right-click (or a long press) opens the note's own menu instead of the browser's. */
  contextMenu: boolean
  /** The clipboard and history strip above the menu's rows. */
  contextMenuToolbar: boolean
  /** The filter box that narrows the menu to what the query matches. */
  contextMenuSearch: boolean
  math: boolean
  mermaid: boolean
  chart: boolean
  emojiShortcodes: boolean
  codeBlockCollapse: boolean
  codeBlockCollapseLines: number
  codeFormatButton: boolean
  tableBubbleMenu: boolean
  /** The settings bar and drag handles on a `::: media` layout block. */
  mediaToolbar: boolean
  /** Pictures dropped or pasted together are bundled into one layout block. */
  mediaAutoBundle: boolean
  /** A bundled block starts floated, so the note's text runs beside it. */
  mediaAutoBundleWrap: boolean
  linkHover: boolean
  linkHoverDelayMs: number
  linkPreviewLength: number
  pinnedWindowSize: PinnedWindowSizeName
  pinnedWindowWidth: number
  pinnedWindowHeight: number
  /** Whether a show opens with the slide list already beside it. The room still
   * decides the ceiling: a phone never gets one it has no space for. */
  presentationSlideList: boolean
  /** Whether a chart plays its entrance on the projector, or arrives drawn. */
  presentationChartAnimation: boolean
  /** Whether the controls and the list fade out while the presenter is idle. */
  presentationAutoHideChrome: boolean
}

export interface PropertyColorChoice {
  pill?: string | null
  text?: string | null
}

export interface PropertyProgressChoice {
  max?: number | null
  maxProperty?: string | null
  variant?: 'bar' | 'circle'
}

export interface PropertyFormatChoice {
  template?: string | null
  markdown?: boolean
}

export type PropertyQuickSearchKey = 'off' | 'ctrl' | 'alt' | 'meta'

export interface PropertySettings {
  enabled: boolean
  showBanner: boolean
  showCover: boolean
  showIcon: boolean
  bannerProperty: string
  iconProperty: string
  coverProperties: string[]
  coverShapeProperty: string
  coverPositionProperty: string
  bannerPositionProperty: string
  coverShape: CoverShape
  coverPosition: CoverPosition
  coverWidth: number
  coverWidth2: number
  coverWidth3: number
  coverMaxHeight: number
  bannerHeight: number
  bannerFade: boolean
  bannerPosition: number
  iconSize: number
  iconInline: boolean
  coloredValues: boolean
  hideHeader: boolean
  hideAddButton: boolean
  hideWholeBlockWhenEmpty: boolean
  revealHidden: boolean
  hidden: string[]
  hiddenWhenEmpty: string[]
  hideAllEmpty: boolean
  colors: Record<string, Record<string, PropertyColorChoice>>
  useCustomDateFormats: boolean
  dateFormat: string
  dateTimeFormat: string
  relativeDateColors: boolean
  datePastColor: string | null
  datePresentColor: string | null
  dateFutureColor: string | null
  progress: Record<string, PropertyProgressChoice>
  formats: Record<string, PropertyFormatChoice>
  selectOptions: Record<string, string[]>
  quickSearchKey: PropertyQuickSearchKey
}

export interface BackupSettings {
  schedule: BackupSchedule
  retentionCount: number
}
export interface SyncSettings {
  realtime: boolean
  pollIntervalMs: number
}

export interface NotesSettings {
  todoTag: string
  /**
   * Inserted at the top of every new note. Empty or whitespace-only yields a
   * blank note. Capped by `NEW_NOTE_TEMPLATE_MAX_LENGTH`, which is also the
   * limit the server applies when persisting settings.
   */
  newNoteTemplate: string
  /** Rewrite the front matter `title` property whenever the note title changes. */
  syncTitleToFrontMatter: boolean
  /** Adopt a changed front matter `title` property as the note title. */
  syncFrontMatterTitle: boolean
}

export interface NoteTemplateCategory {
  id: string
  name: string
  /** True for categories shipped with the app; they cannot be renamed or deleted. */
  builtin: boolean
  position: number
  createdAt: number
  /** Appearance is optional because stored libraries predate it; absent means "derive it". */
  icon?: string | null
  color?: string | null
}

export interface NoteTemplate {
  id: string
  categoryId: string | null
  name: string
  description: string
  content: string
  /** True for templates shipped with the app; they can be edited but not deleted. */
  builtin: boolean
  isPinned: boolean
  isStarred: boolean
  /** Free-form labels shown in the gallery and used as a filter. */
  tags: string[]
  /** Manual sort position within the category; falls back to recency when absent. */
  position?: number
  createdAt: number
  updatedAt: number
}

export interface CommunityTemplate {
  id: string
  authorId: string
  authorName: string
  name: string
  description: string
  content: string
  tags: string[]
  category: string
  /** How many other accounts added this template to their own library. */
  uses: number
  createdAt: number
}

export interface CommunityTemplateInput {
  id?: string
  name: string
  description: string
  content: string
  tags: string[]
  category: string
}

/**
 * How far the local index bends to meet a mistyped word: `0` exact, `1` up to one edit on a long
 * word, `2` up to two.
 */
export type OmnisearchFuzziness = '0' | '1' | '2'

/** The window inside which a recently edited note is lifted in the ranking. */
export type OmnisearchRecencyCutoff = 'disabled' | 'day' | 'week' | 'month'

export interface SearchWeightProperty {
  /** A front matter property whose values should lift the notes that carry them. */
  name: string
  weight: number
}

export interface SearchSettings {
  /** Turning the local index off leaves the note list's server search untouched. */
  enabled: boolean
  /** Keep the built index between sessions instead of rebuilding it on every start. */
  useCache: boolean
  ribbonButton: boolean
  showExcerpt: boolean
  /** Strip Markdown markup from the excerpt instead of showing the source. */
  plainExcerpt: boolean
  renderLineReturnInExcerpts: boolean
  showCreateButton: boolean
  showPreviousQueryResults: boolean
  /** How many embedded documents a result may pull in; `0` hides them. */
  maxEmbeds: number
  maxResults: number
  fuzziness: OmnisearchFuzziness
  /** Prefix only from three characters, which trades recall for speed on a big vault. */
  simpleSearch: boolean
  ignoreDiacritics: boolean
  splitCamelCase: boolean
  /** Index adjacent Han pairs, so a two-character word is found as a word. */
  cjkBigrams: boolean
  pinyinSearch: boolean
  recencyBoost: OmnisearchRecencyCutoff
  weightTitle: number
  weightFolder: number
  weightH1: number
  weightH2: number
  weightH3: number
  weightTags: number
  weightCustomProperties: SearchWeightProperty[]
  /** Folder paths whose notes stay searchable but rank lower. */
  downrankedFolders: string[]
  /** Archived notes are usually noise: hide them instead of only ranking them lower. */
  hideArchived: boolean
  /** A front matter key, `#heading`, or empty for the note title. */
  displayTitleProperty: string
  maxIndexedNotes: number
  maxContentChars: number
  /** Ceiling on the note bodies kept on this device for excerpts. */
  indexStorageMb: number
}

export interface UserSettings {
  appearance: AppearanceSettings
  /** The markdown linter: which rules are on, what each one wants, and what to leave alone. */
  linter: LinterSettings
  editor: EditorSettings
  preview: PreviewSettings
  properties: PropertySettings
  backup: BackupSettings
  sync: SyncSettings
  notes: NotesSettings
  search: SearchSettings
  dataview: DataviewSettings
}

/** How a duration renders in a result cell. */
export type DurationFormatName = 'long' | 'short' | 'tiny'

/**
 * A saved query the Dataview panel can re-run. `id` is stable so a reordering write does not look
 * like a delete plus an insert to the account snapshot.
 */
export interface SavedDataviewQuery {
  id: string
  name: string
  query: string
}

export interface DataviewSettings {
  /** Turning the query blocks off leaves the source text in place, as with the other render switches. */
  enabled: boolean
  /** `= 2 + 2` and `= this.file.name` lines answer inline instead of showing their source. */
  inlineQueries: boolean
  /** `[key:: value]` renders as a labelled value; the note keeps the brackets either way. */
  inlineFields: boolean
  /** ```dataviewjs``` blocks run their own code, inside the same worker sandbox as runnable examples. */
  jsBlocks: boolean
  /** What an unset property shows as, so a blank cell is not mistaken for a broken query. */
  renderNullAs: string
  /** The token pattern for a date without a time, and for one with. */
  dateFormat: string
  datetimeFormat: string
  durationFormat: DurationFormatName
  /** Rows a single block may draw; a query that matches more says so rather than freezing the page. */
  maxRows: number
  /** Bodies one query may read, which is what keeps the throttled note endpoint ahead of a runaway list. */
  bodyLimit: number
  /** Archived notes are outside every other list, so they are outside a query too unless asked. */
  includeArchived: boolean
  /** Whether a failed block prints the error text or only says the query did not run. */
  showErrorDetails: boolean
  /** Re-run a block while the reader types, rather than only when the note is saved. */
  liveRefresh: boolean
  /** Ticking a task in a result writes the tick back into its note. */
  taskCompletionTracking: boolean
  /** Record that tick as `✅ 2026-10-08` rather than as an inline field. */
  taskCompletionUseEmojiShorthand: boolean
  /** The inline field the completion date is written to when it is not the emoji. */
  taskCompletionText: string
  /** Pattern for that date. */
  taskCompletionDateFormat: string
  /** A parent task's tick carries down to the tasks indented under it. */
  recursiveSubTaskCompletion: boolean
  /** The header a `TABLE`'s first column gets when the rows are notes rather than groups. */
  tableIdColumnName: string
  /** Header for a grouped table's key column when the query gave the group no name of its own. */
  tableGroupColumnName: string
  /** How many levels deep a value's own arrays and objects are expanded before they become `…`. */
  maxRecursiveRenderDepth: number
  /** Print how many rows a block matched under its answer. */
  showResultCount: boolean
  /** Say so when a block matched nothing, rather than leaving a gap that reads as a broken page. */
  warnOnEmptyResult: boolean
  /** `$= …` lines run JavaScript against the same sandbox a ```dataviewjs``` block uses. */
  inlineJsQueries: boolean
  /** The prefix that makes an inline line a JavaScript query. Empty means inline JS is off. */
  inlineJsQueryPrefix: string
  /** Evaluate `= …` lines inside fenced code too, which rewrites the author's own example. */
  inlineQueriesInCodeblocks: boolean
  /** The `[key:: value]` chips also appear inside a live-preview block, not only in prose. */
  prettyInlineFieldsLivePreview: boolean
  /** `dv.markdownTable` may put HTML in a cell; off keeps every exported cell plain text. */
  allowHtmlInExports: boolean
  savedQueries: SavedDataviewQuery[]
}


export interface DateRangeFilter {
  start: string
  end: string
}

export interface NoteSummary {
  id: string
  title: string
  excerpt: string
  folderId: string | null
  tags: string[]
  isPinned: boolean
  isStarred: boolean
  isArchived: boolean
  wordCount: number
  charCount: number
  rev: number
  position: number
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export interface Note extends NoteSummary {
  content: string
}

export interface Folder {
  id: string
  parentId: string | null
  name: string
  icon: string | null
  color: string | null
  position: number
  createdAt: number
  updatedAt: number

  noteCount?: number
}

export interface Tag {
  id: string
  name: string
  color: string | null
  isPinned?: boolean
  count: number
  createdAt: number
}

export interface NoteVersionMeta {
  id: string
  noteId: string
  title: string
  size: number
  createdAt: number
}

export interface NoteVersion extends NoteVersionMeta {
  content: string
}

export interface Backlink {
  id: string
  title: string
  context: string
}

export interface Attachment {
  id: string
  noteId: string | null
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  url: string
  createdAt: number
}

export interface AttachmentWithUsage extends Attachment {
  references: number
}


export type ViewKind =
  | 'all'
  | 'recent'
  | 'starred'
  | 'unfiled'
  | 'untagged'
  | 'archived'
  | 'trash'
  | 'folder'
  | 'tag'

/** Which panel the sidebar's tab strip is showing. One panel owns the full height. */
export type SidebarTab = 'library' | 'tags' | 'recent' | 'graph' | 'backlinks' | 'outlinks' | 'history'

export type SortKey = 'updated' | 'created' | 'title'
export type SortOrder = 'asc' | 'desc'

export interface ListNotesQuery {
  view?: ViewKind
  folderId?: string
  tag?: string
  sort?: SortKey
  order?: SortOrder
  limit?: number
  cursor?: string
}

export interface ListNotesResponse {
  notes: NoteSummary[]
  nextCursor: string | null
  /** Only computed on the first page of a listing; later keyset pages return null. */
  total: number | null
}

export interface CreateNoteBody {
  id?: string
  title?: string
  content?: string
  folderId?: string | null
  isStarred?: boolean
}

export interface PatchNoteBody {
  rev: number
  title?: string
  content?: string
  folderId?: string | null
  isPinned?: boolean
  isStarred?: boolean
  isArchived?: boolean

  quiet?: boolean
  preserveVersion?: boolean
}

export interface ConflictPayload {
  code: 'conflict'
  message: string
  server: Note
}


export type SearchMode = 'fts' | 'like'

export interface SearchHit {
  note: NoteSummary
  snippet: string
  score: number
}

/** One note as the client-side index wants it: the body plus enough metadata to build a document. */
export interface SearchDocumentItem {
  id: string
  title: string
  updatedAt: number
  archived: boolean
  starred: boolean
  folderId: string | null
  content: string
  /** The character count of the whole body, so a truncated one can be reported. */
  chars: number
}

export interface SearchDocumentsResponse {
  items: SearchDocumentItem[]
  /** Requested ids that are gone, archived by the caller's own rules, or over the page budget. */
  missing: string[]
}

export interface SearchResponse {
  results: SearchHit[]
  mode: SearchMode
  took: number
  query: {
    text: string
    tags: string[]
    excludedTags: string[]
    folder: string | null
    starred: boolean | null
    archived: boolean | null
  }
}

export interface GraphNode {
  id: string
  title: string
  /** `tag` nodes are synthesized from note tags, `unresolved` from links to missing notes. */
  kind: 'note' | 'unresolved' | 'tag'
  degree: number
  inDegree: number
  outDegree: number
  folderId: string | null
  folderName: string | null
  folderColor: string | null
  tags: Array<{ name: string; color: string | null }>
}

export interface GraphEdge {
  source: string
  target: string
}

export interface GraphResponse {
  nodes: GraphNode[]
  edges: GraphEdge[]
  meta: {
    mode: 'global' | 'local'
    centerId: string | null
    depth: number
    totalNodes: number
    totalEdges: number
    truncated: boolean
    limit: number
  }
}

export interface GraphQuery {
  mode?: 'global' | 'local'
  center?: string
  depth?: number
  q?: string
  folderId?: string
  tag?: string
  /** Tags to filter by. Overrides `tag`; sent comma-separated. */
  tags?: string[]
  /** How multiple tags combine: `any` (default) for union, `all` for intersection. */
  tagsMatch?: 'any' | 'all'
  includeOrphans?: boolean
  includeUnresolved?: boolean
  /** Draw each tag as its own node, linking the notes that carry it. Sent as `1`. */
  showTagNodes?: boolean
  /** Notes the reader took out of the graph. Sent comma-separated, like `tags`. */
  excluded?: string[]
  /** Which side of a link a local graph walks. Only meaningful with `mode: 'local'`. */
  direction?: 'both' | 'incoming' | 'outgoing'
  limit?: number
}


export interface SyncDeletion {
  entity: 'note' | 'folder' | 'tag'
  id: string
}

export interface SyncResponse {
  cursor: number
  full: boolean

  hasMore: boolean

  nextKey: string | null

  facetsFull: boolean

  settingsChanged: boolean
  profileChanged?: boolean
  siteChanged?: boolean
  notes: NoteSummary[]
  folders: Folder[]
  tags: Tag[]
  deletions: SyncDeletion[]
  serverTime: number
}

export type RealtimeMessage =
  | { type: 'changed'; cursor: number; origin: string | null }
  | { type: 'ping' }
  | { type: 'pong'; serverTime: number }


export type BackupTargetType = 'webdav' | 's3'
export type BackupMode = 'archive' | 'mirror'

export interface S3Config {
  endpoint: string
  region: string
  bucket: string
  prefix: string
  pathStyle: boolean
  mode: BackupMode
}

export interface WebdavConfig {
  url: string
  username: string
  prefix: string
  mode: BackupMode
}

export type BackupTargetConfig = S3Config | WebdavConfig

export interface BackupTarget {
  id: string
  type: BackupTargetType
  name: string
  enabled: boolean
  config: BackupTargetConfig
  hasSecret: boolean
  lastRunAt: number | null
  lastStatus: 'success' | 'failed' | null
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export interface BackupTargetInput {
  type: BackupTargetType
  name: string
  enabled?: boolean
  config: Partial<S3Config> & Partial<WebdavConfig>

  secret?: {
    password?: string
    accessKeyId?: string
    secretAccessKey?: string
  }
}

export type BackupTargetPatchInput = Partial<BackupTargetInput> & {
  expectedUpdatedAt?: number
}

export interface BackupTargetResult {
  targetId: string
  targetName: string
  targetType: BackupTargetType
  ok: boolean
  warning?: string
  files: number
  bytes: number
  ms: number
  error: string | null
}

export interface BackupRun {
  id: string
  trigger: 'manual' | 'cron'
  status: 'running' | 'success' | 'partial' | 'failed'
  startedAt: number
  finishedAt: number | null
  noteCount: number
  fileCount: number
  bytes: number
  results: BackupTargetResult[]
}

export interface TestConnectionResult {
  ok: boolean
  message: string
  detail?: string
  latencyMs?: number
}


export interface ShareInfo {
  slug: string
  noteId: string
  url: string
  hasPassword: boolean
  expiresAt: number | null
  views: number
  createdAt: number
}

export interface ShareListItem extends ShareInfo {
  noteTitle: string
  deletedAt: number | null
}

export interface PublicNote {
  title: string
  content: string
  updatedAt: number
  createdAt: number
  author: { name: string; avatarUrl: string }
  site: { name: string }
  share: { slug: string }
}


export interface ExportBundle {

  format: string
  version: 1
  exportedAt: number
  user: { login: string; name: string }
  folders: Folder[]
  tags: Tag[]
  quickadd?: unknown
  notes: Note[]

  attachments: ExportAttachment[]
}

export interface ExportAttachment {
  id: string
  noteId: string | null
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  createdAt: number
  path: string
  sha256: string
}

export interface ImportResult {
  createdNotes: number
  updatedNotes: number
  skippedNotes: number
  createdFolders: number
  createdAttachments: number
  skippedAttachments: number
  warnings: string[]
}


export interface McpPreferences {
  writeEnabled: boolean
  trashEnabled: boolean
  updatedAt: number
}

export interface McpGrant {
  id: string
  clientId: string
  clientName: string
  clientUri: string | null
  scopes: string[]
  createdAt: number
  expiresAt: number | null
}

export interface McpApiKey {
  id: string
  name: string
  scopes: string[]
  createdAt: number
  lastUsedAt: number | null
}

export interface McpAiSearchStatus {
  available: boolean
  enabled: boolean
  model: string
  indexedCount: number
  pendingCount: number
  reason: 'no_ai_binding' | null
}

export interface McpSettingsInfo {
  enabled: boolean
  canManageGlobal: boolean
  endpoint: string
  oauth: true
  preferences: McpPreferences
  apiKeys: McpApiKey[]
  aiSearch: McpAiSearchStatus
  grants: McpGrant[]
  privacy: {
    publicEndpoint: false
    perUserIndex: true
    externalClientReceivesSelectedContent: true
  }
}


export interface ApiErrorBody {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export type ApiErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'bad_request'
  | 'payload_too_large'
  | 'storage_unavailable'
  | 'internal'
  | 'invalid_username'
  | 'invalid_profile_name'
  | 'invalid_avatar'
  | 'weak_password'
  | 'username_taken'
  | 'invalid_credentials'
  | 'invalid_two_factor_code'
  | 'wrong_password'
  | 'too_many_attempts'
  | 'registration_closed'
  | 'setup_token_required'
  | 'note_quota_exceeded'
  | 'organizer_quota_exceeded'
  | 'server_misconfigured'
  | 'two_factor_already_enabled'
  | 'two_factor_challenge_expired'
  | 'two_factor_not_enabled'
  | 'two_factor_setup_expired'
  | 'two_factor_unavailable'
