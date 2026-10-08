import type {
  AccentName,
  CodeFormatKeywordCase,
  DurationFormatName,
  EmojiInsertFormat,
  LinkEditorAliasMode,
  LinkEditorModifier,
  LinkEditorTrigger,
  PasteLinkNothing,
  OutlinerCursorStick,
  OutlinerGuideClick,
  PropertyColorChoice,
  PropertyFormatChoice,
  PropertyProgressChoice,
  SavedDataviewQuery,
  SidebarTab,
  SkinTone,
  UserSettings,
  ViewKind,
} from './types'
import { COVER_POSITIONS, COVER_SHAPES } from './property-decorations'
import { DEFAULT_READING_SPEED_WPM } from './markdown-utils'
import { version as packageVersion } from '../../package.json'

export const APP_VERSION = packageVersion
export const GITHUB_REPOSITORY_URL = 'https://github.com/shuaiplus/inkstone'
export const GITHUB_PACKAGE_URL =
  'https://raw.githubusercontent.com/shuaiplus/inkstone/refs/heads/main/package.json'
export const CLIENT_HEADER = 'X-Inkstone-Client'
export const SESSION_COOKIE = '__Host-inkstone_session'
export const LEGACY_SESSION_COOKIE = 'inkstone_session'

export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000
export const SESSION_RENEW_BEFORE_MS = SESSION_TTL_MS / 2
export const SESSION_ABSOLUTE_MAX_MS = 180 * 24 * 60 * 60 * 1000


export const LIMITS = {
  passwordMaxLength: 128,
  sharePasscodeMinLength: 8,
  titleMaxLength: 512,
  // D1 limits an entire row to 2,000,000 bytes; reserve room for note metadata.
  contentMaxBytes: 1_900_000,
  folderNameMaxLength: 120,
  tagNameMaxLength: 60,
  /** Upper bound on simultaneously selected tag filters; the sidebar warns past it. */
  tagFilterMax: 12,
  organizerIconMaxLength: 8,
  tagsMaxPerUser: 5_000,
  foldersMaxPerUser: 2_000,
  folderDepthMax: 12,
  attachmentMaxBytes: 25 * 1024 * 1024,
  attachmentQuotaBytes: 1024 * 1024 * 1024,
  attachmentUploadsPerHour: 100,
  importFilesMax: 500,
  importUploadMaxBytes: 64 * 1024 * 1024,
  importBundleMaxBytes: 32 * 1024 * 1024,
  importArchiveEntriesMax: 2500,
  importArchiveExpandedMaxBytes: 80 * 1024 * 1024,
  versionsPerNote: 50,
  notesMaxPerUser: 20_000,
  /**
   * A shared template is a snippet, not a document. Kept under the route's JSON
   * body ceiling so an oversized post is refused with a specific message rather
   * than by the transport limit.
   */
  communityTemplateContentMaxLength: 6 * 1024,
  communityTemplatesMaxPerUser: 100,
  communityTemplatesPerHour: 10,
  communityTemplateUsesPerHour: 120,
  communityTemplatesPageSizeMax: 200,
  backupRunsKept: 50,
  backupTargetsMax: 12,
  changeLogKept: 5000,
  syncBatchSize: 500,
  searchLimit: 50,
  mentionLimit: 50,
  mentionMinChars: 2,
  graphNodeLimitMin: 50,
  graphNodeLimitMax: 600,
  graphNodeLimitDefault: 350,
  graphDepthMin: 1,
  graphDepthMax: 3,
  graphDepthDefault: 1,
  graphTagsMax: 20,
  graphExcludedMax: 200,
  graphColorGroupMax: 5,

  ftsContentChars: 200_000,
  /** What one note contributes to the client-side search index, in characters. */
  omnisearchDocumentChars: 100_000,
} as const

export const ACCENTS: { name: AccentName; swatch: string; foreground: string }[] = [
  { name: 'cinnabar', swatch: 'oklch(58% 0.15 31)', foreground: 'white' },
  { name: 'indigo', swatch: 'oklch(62% 0.16 252)', foreground: 'white' },
  { name: 'celadon', swatch: 'oklch(66% 0.13 150)', foreground: 'oklch(16% 0.008 265)' },
  { name: 'amber', swatch: 'oklch(76% 0.15 95)', foreground: 'oklch(16% 0.008 265)' },
  { name: 'terracotta', swatch: 'oklch(68% 0.1 205)', foreground: 'oklch(16% 0.008 265)' },
  { name: 'wisteria', swatch: 'oklch(62% 0.16 300)', foreground: 'white' },
  { name: 'graphite', swatch: 'oklch(55% 0.035 250)', foreground: 'white' },
]

export const PROSE_WIDTH_CH: Record<string, string> = {
  narrow: '58ch',
  normal: '72ch',
  wide: '88ch',
  full: '100%',
}

export const VIEW_KINDS: ViewKind[] = ['all', 'recent', 'starred', 'unfiled', 'untagged', 'archived', 'trash', 'folder', 'tag']

export const SIDEBAR_TABS: SidebarTab[] = ['library', 'tags', 'recent', 'graph', 'backlinks', 'outlinks', 'history']

/**
 * The template inserted at the top of a new note. Keep the placeholders ASCII:
 * they are filled in at creation time with the note title and the current
 * date and time. The first line must be `---`, since a leading blank line would
 * stop the front matter from parsing at all.
 */
export const DEFAULT_NEW_NOTE_TEMPLATE = `---
title: {{title}}
createdAt: {{createdAt}}
tags: []
aliases:
  - ''
---

`

/**
 * Ceiling the server applies to the stored template. The settings editor caps
 * input at the same number so what a reader sees in the preview is what the
 * account keeps.
 */
export const NEW_NOTE_TEMPLATE_MAX_LENGTH = 4096

export const DEFAULT_SETTINGS: UserSettings = {
  appearance: {
    language: 'zh-CN',
    theme: 'system',
    accent: 'cinnabar',
    background: 'paper',
    density: 'comfortable',
    proseFont: 'sans',
    proseSize: 16,
    proseWidth: 'normal',
    proseLineHeight: 1.65,
  },
  editor: {
    fontSize: 15,
    fontFamily: 'mono',
    lineNumbers: false,
    typewriter: false,
    focusMode: false,
    spellcheck: false,
    showToolbar: true,
    livePreview: true,
    tabSize: 2,
    autoSaveDelay: 500,
    codeFormatKeywordCase: 'upper',
    emojiToolbarButton: true,
    emojiInsertFormat: 'native',
    emojiSkinTone: 0,
    linkEditor: true,
    linkEditorTrigger: 'click',
    linkEditorModifier: 'none',
    linkEditorSuggest: true,
    linkEditorValidate: true,
    linkEditorSyncAlias: true,
    linkEditorAliasMode: 'heading',
    linkEditorAliasSeparator: ' › ',
    linkEditorKeepsText: true,
    linkEditorEmbedToggle: true,
    linkEditorPadNew: true,
    linkEditorQuickSelect: false,
    pasteLink: true,
    pasteLinkReverse: true,
    pasteLinkNothing: 'plain',
    pasteLinkImageEmbed: true,
    pasteLinkBareAddress: true,
    pasteLinkInternalNote: true,
    pasteLinkRetarget: true,
    outliner: true,
    outlinerEnter: true,
    outlinerShiftEnter: true,
    outlinerTab: true,
    outlinerCursor: 'bullet-and-checkbox',
    outlinerSelectAll: true,
    outlinerMoveKeys: true,
    outlinerFoldKeys: true,
    outlinerGuides: true,
    outlinerGuideClick: 'fold',
    outlinerDrag: true,
  },
  preview: {
    layout: 'live',
    syncScroll: true,
    showToc: true,
    outlineMode: 'sidebar',
    outlineDefaultLevel: 6,
    outlineShowProgress: true,
    outlineAutoExpand: 'off',
    outlineTooltipSide: 'left',
    outlineTruncateLength: 0,
    outlineMarkdownLabels: false,
    outlineHoverPeek: false,
    outlineTextDirection: 'system',
    outlineShowReadingTime: true,
    outlineReadingSpeed: DEFAULT_READING_SPEED_WPM,
    outlineDragEdits: false,
    outlineKeepSearch: false,
    outlineLocateByCursor: false,
    contextMenu: true,
    contextMenuToolbar: true,
    contextMenuSearch: true,
    math: true,
    mermaid: true,
    chart: true,
    emojiShortcodes: true,
    codeBlockCollapse: true,
    codeBlockCollapseLines: 24,
    codeFormatButton: true,
    tableBubbleMenu: true,
    mediaToolbar: true,
    mediaAutoBundle: false,
    mediaAutoBundleWrap: false,
    linkHover: true,
    linkHoverDelayMs: 320,
    linkPreviewLength: 4000,
    pinnedWindowSize: 'medium',
    pinnedWindowWidth: 460,
    pinnedWindowHeight: 520,
    presentationSlideList: true,
    presentationChartAnimation: true,
    presentationAutoHideChrome: true,
  },
  properties: {
    enabled: true,
    showBanner: true,
    showCover: true,
    showIcon: true,
    bannerProperty: 'banner',
    iconProperty: 'icon',
    coverProperties: ['cover'],
    coverShapeProperty: 'cover_shape',
    coverPositionProperty: 'cover_position',
    bannerPositionProperty: 'banner_position',
    coverShape: 'initial',
    coverPosition: 'left',
    coverWidth: 200,
    coverWidth2: 250,
    coverWidth3: 300,
    coverMaxHeight: 500,
    bannerHeight: 150,
    bannerFade: true,
    bannerPosition: 50,
    iconSize: 70,
    iconInline: false,
    coloredValues: true,
    hideHeader: false,
    hideAddButton: false,
    hideWholeBlockWhenEmpty: false,
    revealHidden: false,
    hidden: [],
    hiddenWhenEmpty: [],
    hideAllEmpty: false,
    colors: {},
    useCustomDateFormats: false,
    dateFormat: '',
    dateTimeFormat: '',
    relativeDateColors: false,
    datePastColor: null,
    datePresentColor: null,
    dateFutureColor: null,
    progress: {},
    formats: {},
    selectOptions: {},
    quickSearchKey: 'ctrl',
  },
  backup: {
    schedule: 'sixHourly',
    retentionCount: 0,
  },
  sync: {
    realtime: true,
    pollIntervalMs: 15_000,
  },
  notes: {
    todoTag: '',
    newNoteTemplate: DEFAULT_NEW_NOTE_TEMPLATE,
    syncTitleToFrontMatter: true,
    syncFrontMatterTitle: true,
  },
  search: {
    enabled: true,
    useCache: true,
    ribbonButton: true,
    showExcerpt: true,
    plainExcerpt: true,
    renderLineReturnInExcerpts: true,
    showCreateButton: false,
    showPreviousQueryResults: true,
    maxEmbeds: 5,
    maxResults: 50,
    fuzziness: '1',
    simpleSearch: false,
    ignoreDiacritics: true,
    splitCamelCase: false,
    cjkBigrams: true,
    pinyinSearch: true,
    recencyBoost: 'disabled',
    weightTitle: 10,
    weightFolder: 7,
    weightH1: 6,
    weightH2: 5,
    weightH3: 4,
    weightTags: 2,
    weightCustomProperties: [],
    downrankedFolders: [],
    hideArchived: false,
    displayTitleProperty: '',
    maxIndexedNotes: 3000,
    maxContentChars: 100000,
    indexStorageMb: 64,
  },
  dataview: {
    enabled: true,
    inlineQueries: true,
    inlineFields: true,
    jsBlocks: true,
    renderNullAs: '',
    dateFormat: 'yyyy-MM-dd',
    datetimeFormat: 'yyyy-MM-dd HH:mm',
    durationFormat: 'long',
    maxRows: 200,
    bodyLimit: 500,
    includeArchived: false,
    showErrorDetails: true,
    liveRefresh: true,
    taskCompletionTracking: false,
    taskCompletionUseEmojiShorthand: false,
    taskCompletionText: 'completion',
    taskCompletionDateFormat: 'yyyy-MM-dd',
    recursiveSubTaskCompletion: false,
    tableIdColumnName: 'File',
    tableGroupColumnName: 'Group',
    maxRecursiveRenderDepth: 4,
    showResultCount: false,
    warnOnEmptyResult: true,
    inlineJsQueries: false,
    inlineJsQueryPrefix: '$=',
    inlineQueriesInCodeblocks: false,
    prettyInlineFieldsLivePreview: true,
    allowHtmlInExports: false,
    savedQueries: [],
  },
}

export const TODO_TAG_LIST_MAX = 8

export const PROPERTY_NAME_MAX = 60
export const PROPERTY_LIST_MAX = 80
export const PROPERTY_COVER_NAMES_MAX = 8
export const PROPERTY_COLOR_RULES_MAX = 60
export const PROPERTY_COLOR_VALUES_MAX = 40
export const PROPERTY_COLOR_TEXT_MAX = 120
export const PROPERTY_FORMAT_RULES_MAX = 60
export const PROPERTY_TEMPLATE_MAX = 512
export const PROPERTY_PROGRESS_RULES_MAX = 60
export const PROPERTY_SELECT_RULES_MAX = 60
export const PROPERTY_SELECT_OPTIONS_MAX = 24
export const PROPERTY_DATE_PATTERN_MAX = 120
export const PROPERTY_COVER_WIDTH_RANGE = [60, 900] as const
export const PROPERTY_BANNER_HEIGHT_RANGE = [40, 600] as const
export const PROPERTY_ICON_SIZE_RANGE = [16, 240] as const

const QUICK_SEARCH_KEYS = ['off', 'ctrl', 'alt', 'meta'] as const

const HEX_COLOR = /^#[0-9a-f]{6}$/i

const PROPERTY_BUDGET_TOTAL = 8192

interface SizeBudget {
  remaining: number
}

function charge(budget: SizeBudget, size: number): boolean {
  if (budget.remaining < size)
    return false
  budget.remaining -= size
  return true
}

function propertyColorValue(value: unknown): string | null | undefined {
  if (value === undefined)
    return undefined
  if (value === null)
    return null
  if (typeof value !== 'string')
    return undefined
  const text = value.trim()
  if (text === 'default' || text === 'none' || text === 'accent')
    return text
  return HEX_COLOR.test(text) ? text.toLocaleLowerCase() : undefined
}

function propertyNameList(value: unknown, max: number, budget?: SizeBudget): string[] {
  if (!Array.isArray(value))
    return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string')
      continue
    const name = item.trim().slice(0, PROPERTY_NAME_MAX)
    const key = name.toLocaleLowerCase()
    if (!name || seen.has(key))
      continue
    if (budget && !charge(budget, name.length + 3))
      break
    seen.add(key)
    out.push(name)
    if (out.length === max)
      break
  }
  return out
}

function propertyTextKey(value: unknown, max: number): string {
  if (typeof value !== 'string')
    return ''
  const text = value.trim()
  return text.length > max ? '' : text
}

function colorMap(value: unknown, budget: SizeBudget): Record<string, Record<string, PropertyColorChoice>> {
  const out: Record<string, Record<string, PropertyColorChoice>> = {}
  for (const [rawName, rawRules] of Object.entries(asRecord(value))) {
    if (Object.keys(out).length === PROPERTY_COLOR_RULES_MAX)
      break
    const name = propertyTextKey(rawName, PROPERTY_NAME_MAX).toLocaleLowerCase()
    if (!name)
      continue
    if (!charge(budget, name.length + 8))
      break
    const rules: Record<string, PropertyColorChoice> = {}
    for (const [rawValue, rawChoice] of Object.entries(asRecord(rawRules))) {
      if (Object.keys(rules).length === PROPERTY_COLOR_VALUES_MAX)
        break
      const key = propertyTextKey(rawValue, PROPERTY_COLOR_TEXT_MAX)
      if (!key)
        continue
      const choice = asRecord(rawChoice)
      const pill = propertyColorValue(choice.pill)
      const text = propertyColorValue(choice.text)
      if (pill === undefined && text === undefined)
        continue
      const entry: PropertyColorChoice = {}
      if (pill !== undefined)
        entry.pill = pill
      if (text !== undefined)
        entry.text = text
      if (!charge(budget, key.length + 40))
        break
      rules[key] = entry
    }
    if (Object.keys(rules).length)
      out[name] = rules
  }
  return out
}

function progressMap(value: unknown, budget: SizeBudget): Record<string, PropertyProgressChoice> {
  const out: Record<string, PropertyProgressChoice> = {}
  for (const [rawName, rawRule] of Object.entries(asRecord(value))) {
    if (Object.keys(out).length === PROPERTY_PROGRESS_RULES_MAX)
      break
    const name = propertyTextKey(rawName, PROPERTY_NAME_MAX).toLocaleLowerCase()
    if (!name)
      continue
    const rule = asRecord(rawRule)
    const entry: PropertyProgressChoice = {}
    const max = typeof rule.max === 'number' && Number.isFinite(rule.max) && rule.max !== 0
      ? Math.min(1_000_000, Math.max(-1_000_000, rule.max))
      : undefined
    const maxProperty = typeof rule.maxProperty === 'string' ? propertyTextKey(rule.maxProperty, PROPERTY_NAME_MAX) : undefined
    if (max !== undefined)
      entry.max = max
    if (maxProperty)
      entry.maxProperty = maxProperty
    if (rule.variant === 'circle')
      entry.variant = 'circle'
    if (entry.max === undefined && !entry.maxProperty)
      entry.max = 100
    if (!charge(budget, name.length + (entry.maxProperty?.length ?? 0) + 34))
      break
    out[name] = entry
  }
  return out
}

function formatMap(value: unknown, budget: SizeBudget): Record<string, PropertyFormatChoice> {
  const out: Record<string, PropertyFormatChoice> = {}
  for (const [rawName, rawRule] of Object.entries(asRecord(value))) {
    if (Object.keys(out).length === PROPERTY_FORMAT_RULES_MAX)
      break
    const name = propertyTextKey(rawName, PROPERTY_NAME_MAX).toLocaleLowerCase()
    if (!name)
      continue
    const rule = asRecord(rawRule)
    const entry: PropertyFormatChoice = {}
    if (typeof rule.template === 'string') {
      const template = rule.template.slice(0, PROPERTY_TEMPLATE_MAX)
      if (template.trim())
        entry.template = template
    }
    if (rule.markdown === true)
      entry.markdown = true
    if (entry.template === undefined && !entry.markdown)
      continue
    if (!charge(budget, name.length + (entry.template?.length ?? 0) + 30))
      break
    out[name] = entry
  }
  return out
}

function optionsMap(value: unknown, budget: SizeBudget): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [rawName, rawOptions] of Object.entries(asRecord(value))) {
    if (Object.keys(out).length === PROPERTY_SELECT_RULES_MAX)
      break
    const name = propertyTextKey(rawName, PROPERTY_NAME_MAX).toLocaleLowerCase()
    if (!name)
      continue
    const options = propertyNameList(rawOptions, PROPERTY_SELECT_OPTIONS_MAX, budget)
      .map(item => item.slice(0, PROPERTY_COLOR_TEXT_MAX))
    if (options.length)
      out[name] = options
  }
  return out
}

function hexOrNull(value: unknown): string | null {
  return typeof value === 'string' && HEX_COLOR.test(value.trim()) ? value.trim().toLocaleLowerCase() : null
}

function trimmedText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

export const PINNED_WINDOW_PRESETS: Record<'small' | 'medium' | 'large', { width: number, height: number }> = {
  small: { width: 340, height: 380 },
  medium: { width: 460, height: 520 },
  large: { width: 620, height: 680 },
}
export const PINNED_WINDOW_WIDTH_RANGE = [260, 1200] as const
export const PINNED_WINDOW_HEIGHT_RANGE = [140, 2000] as const
export const LINK_HOVER_DELAY_RANGE = [150, 1000] as const
export const LINK_EDITOR_ALIAS_SEPARATOR_MAX = 12
export const LINK_PREVIEW_LENGTH_RANGE = [300, 8000] as const

export const BACKUP_INTERVALS: Record<string, number> = {
  off: 0,
  hourly: 60 * 60 * 1000,
  sixHourly: 6 * 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
}

const THEMES = ['light', 'dark', 'system'] as const
const LANGUAGES = ['zh-CN', 'en-US'] as const
const ACCENT_NAMES = ACCENTS.map((accent) => accent.name)
const BACKGROUND_NAMES = ['paper', 'white'] as const
const DENSITIES = ['comfortable', 'compact'] as const
const PROSE_FONTS = ['sans', 'serif'] as const
const PROSE_WIDTHS = ['narrow', 'normal', 'wide', 'full'] as const
const EDITOR_FONTS = ['mono', 'sans'] as const
const EDITOR_LAYOUTS = ['live', 'split', 'preview'] as const
const PINNED_WINDOW_SIZES = ['small', 'medium', 'large', 'custom'] as const
const OUTLINE_MODES = ['sidebar', 'floating-always', 'floating-hover', 'floating-circle'] as const
const OUTLINE_AUTO_EXPANDS = ['off', 'ancestors'] as const
const OUTLINE_TEXT_DIRECTIONS = ['system', 'text'] as const
const OUTLINE_TOOLTIP_SIDES = ['left', 'right'] as const
const CODE_FORMAT_KEYWORD_CASES: CodeFormatKeywordCase[] = ['upper', 'lower', 'keep']
const EMOJI_INSERT_FORMATS: EmojiInsertFormat[] = ['native', 'shortcode']
const LINK_EDITOR_TRIGGERS: LinkEditorTrigger[] = ['click', 'double-click']
const LINK_EDITOR_MODIFIERS: LinkEditorModifier[] = ['none', 'ctrl', 'alt', 'shift']
const LINK_EDITOR_ALIAS_MODES: LinkEditorAliasMode[] = ['heading', 'note-then-heading', 'heading-then-note']
const PASTE_LINK_NOTTHINGS: PasteLinkNothing[] = ['plain', 'word', 'inline', 'bare']
const OUTLINER_CURSOR_STICKS: OutlinerCursorStick[] = ['never', 'bullet', 'bullet-and-checkbox']
const OUTLINER_GUIDE_CLICKS: OutlinerGuideClick[] = ['none', 'fold']
export const EMOJI_SKIN_TONE_MAX = 5
const BACKUP_SCHEDULES = ['off', 'hourly', 'sixHourly', 'daily', 'weekly', 'monthly', 'yearly'] as const

const OMNISEARCH_FUZZINESS = ['0', '1', '2'] as const
const OMNISEARCH_RECENCY = ['disabled', 'day', 'week', 'month'] as const

export const SEARCH_WEIGHT_RANGE = [1, 10] as const
export const SEARCH_PROPERTY_WEIGHT_RANGE = [0.1, 5] as const
export const SEARCH_CUSTOM_PROPERTIES_MAX = 12
export const SEARCH_DOWNRANKED_FOLDERS_MAX = 40
export const SEARCH_DISPLAY_TITLE_MAX = 60


export function mergeSettings(partial: unknown): UserSettings {
  const base = cloneDefaultSettings()
  const src = asRecord(partial)
  const appearance = asRecord(src.appearance)
  const editor = asRecord(src.editor)
  const preview = asRecord(src.preview)
  const properties = asRecord(src.properties)
  const backup = asRecord(src.backup)
  const sync = asRecord(src.sync)
  const notes = asRecord(src.notes)
  const search = asRecord(src.search)
  const dataview = asRecord(src.dataview)

  base.notes.todoTag = normalizeTodoTags(notes.todoTag)
  base.notes.newNoteTemplate = typeof notes.newNoteTemplate === 'string'
    ? notes.newNoteTemplate.slice(0, NEW_NOTE_TEMPLATE_MAX_LENGTH)
    : base.notes.newNoteTemplate
  base.notes.syncTitleToFrontMatter = booleanValue(notes.syncTitleToFrontMatter, base.notes.syncTitleToFrontMatter)
  base.notes.syncFrontMatterTitle = booleanValue(notes.syncFrontMatterTitle, base.notes.syncFrontMatterTitle)

  base.appearance.theme = enumValue(appearance.theme, THEMES, base.appearance.theme)
  base.appearance.language = enumValue(
    appearance.language,
    LANGUAGES,
    base.appearance.language,
  )
  base.appearance.accent = enumValue(appearance.accent, ACCENT_NAMES, base.appearance.accent)
  base.appearance.background = enumValue(
    appearance.background,
    BACKGROUND_NAMES,
    base.appearance.background,
  )
  base.appearance.density = enumValue(
    appearance.density,
    DENSITIES,
    base.appearance.density,
  )
  base.appearance.proseFont = enumValue(
    appearance.proseFont,
    PROSE_FONTS,
    base.appearance.proseFont,
  )
  base.appearance.proseSize = integerInRange(
    appearance.proseSize,
    13,
    22,
    base.appearance.proseSize,
  )
  base.appearance.proseWidth = enumValue(
    appearance.proseWidth,
    PROSE_WIDTHS,
    base.appearance.proseWidth,
  )
  base.appearance.proseLineHeight = numberInRange(
    appearance.proseLineHeight,
    1.4,
    2.2,
    base.appearance.proseLineHeight,
  )

  base.editor.fontSize = integerInRange(editor.fontSize, 12, 22, base.editor.fontSize)
  base.editor.fontFamily = enumValue(editor.fontFamily, EDITOR_FONTS, base.editor.fontFamily)
  base.editor.lineNumbers = booleanValue(editor.lineNumbers, base.editor.lineNumbers)
  base.editor.typewriter = booleanValue(editor.typewriter, base.editor.typewriter)
  base.editor.focusMode = booleanValue(editor.focusMode, base.editor.focusMode)
  base.editor.spellcheck = booleanValue(editor.spellcheck, base.editor.spellcheck)
  base.editor.showToolbar = booleanValue(editor.showToolbar, base.editor.showToolbar)
  base.editor.livePreview = booleanValue(editor.livePreview, base.editor.livePreview)
  base.editor.tabSize = editor.tabSize === 4 ? 4 : editor.tabSize === 2 ? 2 : base.editor.tabSize
  base.editor.autoSaveDelay = integerInRange(
    editor.autoSaveDelay,
    200,
    3000,
    base.editor.autoSaveDelay,
  )
  base.editor.codeFormatKeywordCase = enumValue(
    editor.codeFormatKeywordCase,
    CODE_FORMAT_KEYWORD_CASES,
    base.editor.codeFormatKeywordCase,
  )
  base.editor.emojiToolbarButton = booleanValue(editor.emojiToolbarButton, base.editor.emojiToolbarButton)
  base.editor.emojiInsertFormat = enumValue(
    editor.emojiInsertFormat,
    EMOJI_INSERT_FORMATS,
    base.editor.emojiInsertFormat,
  )
  base.editor.emojiSkinTone = integerInRange(
    editor.emojiSkinTone,
    0,
    EMOJI_SKIN_TONE_MAX,
    base.editor.emojiSkinTone,
  ) as SkinTone
  base.editor.linkEditor = booleanValue(editor.linkEditor, base.editor.linkEditor)
  base.editor.linkEditorTrigger = enumValue(
    editor.linkEditorTrigger,
    LINK_EDITOR_TRIGGERS,
    base.editor.linkEditorTrigger,
  )
  base.editor.linkEditorModifier = enumValue(
    editor.linkEditorModifier,
    LINK_EDITOR_MODIFIERS,
    base.editor.linkEditorModifier,
  )
  base.editor.linkEditorSuggest = booleanValue(editor.linkEditorSuggest, base.editor.linkEditorSuggest)
  base.editor.linkEditorValidate = booleanValue(editor.linkEditorValidate, base.editor.linkEditorValidate)
  base.editor.linkEditorSyncAlias = booleanValue(editor.linkEditorSyncAlias, base.editor.linkEditorSyncAlias)
  base.editor.linkEditorAliasMode = enumValue(
    editor.linkEditorAliasMode,
    LINK_EDITOR_ALIAS_MODES,
    base.editor.linkEditorAliasMode,
  )
  base.editor.linkEditorAliasSeparator = typeof editor.linkEditorAliasSeparator === 'string'
    ? editor.linkEditorAliasSeparator.slice(0, LINK_EDITOR_ALIAS_SEPARATOR_MAX)
    : base.editor.linkEditorAliasSeparator
  base.editor.linkEditorKeepsText = booleanValue(editor.linkEditorKeepsText, base.editor.linkEditorKeepsText)
  base.editor.linkEditorEmbedToggle = booleanValue(editor.linkEditorEmbedToggle, base.editor.linkEditorEmbedToggle)
  base.editor.linkEditorPadNew = booleanValue(editor.linkEditorPadNew, base.editor.linkEditorPadNew)
  base.editor.linkEditorQuickSelect = booleanValue(editor.linkEditorQuickSelect, base.editor.linkEditorQuickSelect)
  base.editor.pasteLink = booleanValue(editor.pasteLink, base.editor.pasteLink)
  base.editor.pasteLinkReverse = booleanValue(editor.pasteLinkReverse, base.editor.pasteLinkReverse)
  base.editor.pasteLinkNothing = enumValue(
    editor.pasteLinkNothing,
    PASTE_LINK_NOTTHINGS,
    base.editor.pasteLinkNothing,
  )
  base.editor.pasteLinkImageEmbed = booleanValue(editor.pasteLinkImageEmbed, base.editor.pasteLinkImageEmbed)
  base.editor.pasteLinkBareAddress = booleanValue(editor.pasteLinkBareAddress, base.editor.pasteLinkBareAddress)
  base.editor.pasteLinkInternalNote = booleanValue(editor.pasteLinkInternalNote, base.editor.pasteLinkInternalNote)
  base.editor.pasteLinkRetarget = booleanValue(editor.pasteLinkRetarget, base.editor.pasteLinkRetarget)
  base.editor.outliner = booleanValue(editor.outliner, base.editor.outliner)
  base.editor.outlinerEnter = booleanValue(editor.outlinerEnter, base.editor.outlinerEnter)
  base.editor.outlinerShiftEnter = booleanValue(editor.outlinerShiftEnter, base.editor.outlinerShiftEnter)
  base.editor.outlinerTab = booleanValue(editor.outlinerTab, base.editor.outlinerTab)
  base.editor.outlinerCursor = enumValue(editor.outlinerCursor, OUTLINER_CURSOR_STICKS, base.editor.outlinerCursor)
  base.editor.outlinerSelectAll = booleanValue(editor.outlinerSelectAll, base.editor.outlinerSelectAll)
  base.editor.outlinerMoveKeys = booleanValue(editor.outlinerMoveKeys, base.editor.outlinerMoveKeys)
  base.editor.outlinerFoldKeys = booleanValue(editor.outlinerFoldKeys, base.editor.outlinerFoldKeys)
  base.editor.outlinerGuides = booleanValue(editor.outlinerGuides, base.editor.outlinerGuides)
  base.editor.outlinerGuideClick = enumValue(editor.outlinerGuideClick, OUTLINER_GUIDE_CLICKS, base.editor.outlinerGuideClick)
  base.editor.outlinerDrag = booleanValue(editor.outlinerDrag, base.editor.outlinerDrag)

  base.preview.layout = enumValue(preview.layout, EDITOR_LAYOUTS, base.preview.layout)
  base.preview.syncScroll = booleanValue(preview.syncScroll, base.preview.syncScroll)
  base.preview.showToc = booleanValue(preview.showToc, base.preview.showToc)
  base.preview.outlineMode = enumValue(preview.outlineMode, OUTLINE_MODES, base.preview.outlineMode)
  base.preview.outlineDefaultLevel = integerInRange(preview.outlineDefaultLevel, 1, 6, base.preview.outlineDefaultLevel)
  base.preview.outlineShowProgress = booleanValue(preview.outlineShowProgress, base.preview.outlineShowProgress)
  base.preview.outlineKeepSearch = booleanValue(preview.outlineKeepSearch, base.preview.outlineKeepSearch)
  base.preview.outlineDragEdits = booleanValue(preview.outlineDragEdits, base.preview.outlineDragEdits)
  base.preview.outlineAutoExpand = enumValue(preview.outlineAutoExpand, OUTLINE_AUTO_EXPANDS, base.preview.outlineAutoExpand)
  base.preview.outlineTooltipSide = enumValue(preview.outlineTooltipSide, OUTLINE_TOOLTIP_SIDES, base.preview.outlineTooltipSide)
  base.preview.outlineTruncateLength = integerInRange(preview.outlineTruncateLength, 0, 120, base.preview.outlineTruncateLength)
  base.preview.outlineMarkdownLabels = booleanValue(preview.outlineMarkdownLabels, base.preview.outlineMarkdownLabels)
  base.preview.outlineHoverPeek = booleanValue(preview.outlineHoverPeek, base.preview.outlineHoverPeek)
  base.preview.outlineTextDirection = enumValue(preview.outlineTextDirection, OUTLINE_TEXT_DIRECTIONS, base.preview.outlineTextDirection)
  base.preview.outlineShowReadingTime = booleanValue(preview.outlineShowReadingTime, base.preview.outlineShowReadingTime)
  base.preview.outlineReadingSpeed = integerInRange(preview.outlineReadingSpeed, 50, 1000, base.preview.outlineReadingSpeed)
  base.preview.outlineLocateByCursor = booleanValue(preview.outlineLocateByCursor, base.preview.outlineLocateByCursor)
  base.preview.contextMenu = booleanValue(preview.contextMenu, base.preview.contextMenu)
  base.preview.contextMenuToolbar = booleanValue(preview.contextMenuToolbar, base.preview.contextMenuToolbar)
  base.preview.contextMenuSearch = booleanValue(preview.contextMenuSearch, base.preview.contextMenuSearch)
  base.preview.math = booleanValue(preview.math, base.preview.math)
  base.preview.mermaid = booleanValue(preview.mermaid, base.preview.mermaid)
  base.preview.chart = booleanValue(preview.chart, base.preview.chart)
  base.preview.emojiShortcodes = booleanValue(preview.emojiShortcodes, base.preview.emojiShortcodes)
  base.preview.codeBlockCollapse = booleanValue(preview.codeBlockCollapse, base.preview.codeBlockCollapse)
  base.preview.codeBlockCollapseLines = integerInRange(
    preview.codeBlockCollapseLines,
    8,
    100,
    base.preview.codeBlockCollapseLines,
  )
  base.preview.codeFormatButton = booleanValue(preview.codeFormatButton, base.preview.codeFormatButton)
  base.preview.tableBubbleMenu = booleanValue(preview.tableBubbleMenu, base.preview.tableBubbleMenu)
  base.preview.mediaToolbar = booleanValue(preview.mediaToolbar, base.preview.mediaToolbar)
  base.preview.mediaAutoBundle = booleanValue(preview.mediaAutoBundle, base.preview.mediaAutoBundle)
  base.preview.mediaAutoBundleWrap = booleanValue(preview.mediaAutoBundleWrap, base.preview.mediaAutoBundleWrap)
  base.preview.linkHover = booleanValue(preview.linkHover, base.preview.linkHover)
  base.preview.linkHoverDelayMs = integerInRange(
    preview.linkHoverDelayMs,
    LINK_HOVER_DELAY_RANGE[0],
    LINK_HOVER_DELAY_RANGE[1],
    base.preview.linkHoverDelayMs,
  )
  base.preview.linkPreviewLength = integerInRange(
    preview.linkPreviewLength,
    LINK_PREVIEW_LENGTH_RANGE[0],
    LINK_PREVIEW_LENGTH_RANGE[1],
    base.preview.linkPreviewLength,
  )
  base.preview.pinnedWindowSize = enumValue(preview.pinnedWindowSize, PINNED_WINDOW_SIZES, base.preview.pinnedWindowSize)
  base.preview.pinnedWindowWidth = integerInRange(
    preview.pinnedWindowWidth,
    PINNED_WINDOW_WIDTH_RANGE[0],
    PINNED_WINDOW_WIDTH_RANGE[1],
    base.preview.pinnedWindowWidth,
  )
  base.preview.presentationSlideList = booleanValue(preview.presentationSlideList, base.preview.presentationSlideList)
  base.preview.presentationChartAnimation = booleanValue(preview.presentationChartAnimation, base.preview.presentationChartAnimation)
  base.preview.presentationAutoHideChrome = booleanValue(preview.presentationAutoHideChrome, base.preview.presentationAutoHideChrome)
  base.preview.pinnedWindowHeight = integerInRange(
    preview.pinnedWindowHeight,
    PINNED_WINDOW_HEIGHT_RANGE[0],
    PINNED_WINDOW_HEIGHT_RANGE[1],
    base.preview.pinnedWindowHeight,
  )

  base.properties.enabled = booleanValue(properties.enabled, base.properties.enabled)
  base.properties.showBanner = booleanValue(properties.showBanner, base.properties.showBanner)
  base.properties.showCover = booleanValue(properties.showCover, base.properties.showCover)
  base.properties.showIcon = booleanValue(properties.showIcon, base.properties.showIcon)
  base.properties.bannerProperty = trimmedText(properties.bannerProperty, PROPERTY_NAME_MAX) || base.properties.bannerProperty
  base.properties.iconProperty = trimmedText(properties.iconProperty, PROPERTY_NAME_MAX) || base.properties.iconProperty
  base.properties.coverShapeProperty = trimmedText(properties.coverShapeProperty, PROPERTY_NAME_MAX) || base.properties.coverShapeProperty
  base.properties.coverPositionProperty = trimmedText(properties.coverPositionProperty, PROPERTY_NAME_MAX) || base.properties.coverPositionProperty
  base.properties.bannerPositionProperty = trimmedText(properties.bannerPositionProperty, PROPERTY_NAME_MAX) || base.properties.bannerPositionProperty
  base.properties.coverProperties = Array.isArray(properties.coverProperties)
    ? propertyNameList(properties.coverProperties, PROPERTY_COVER_NAMES_MAX)
    : base.properties.coverProperties
  const propertyBudget: SizeBudget = { remaining: PROPERTY_BUDGET_TOTAL }
  base.properties.coverShape = enumValue(properties.coverShape, COVER_SHAPES, base.properties.coverShape)
  base.properties.coverPosition = enumValue(properties.coverPosition, COVER_POSITIONS, base.properties.coverPosition)
  base.properties.coverWidth = integerInRange(properties.coverWidth, PROPERTY_COVER_WIDTH_RANGE[0], PROPERTY_COVER_WIDTH_RANGE[1], base.properties.coverWidth)
  base.properties.coverWidth2 = integerInRange(properties.coverWidth2, PROPERTY_COVER_WIDTH_RANGE[0], PROPERTY_COVER_WIDTH_RANGE[1], base.properties.coverWidth2)
  base.properties.coverWidth3 = integerInRange(properties.coverWidth3, PROPERTY_COVER_WIDTH_RANGE[0], PROPERTY_COVER_WIDTH_RANGE[1], base.properties.coverWidth3)
  base.properties.coverMaxHeight = integerInRange(properties.coverMaxHeight, PROPERTY_COVER_WIDTH_RANGE[0], 1600, base.properties.coverMaxHeight)
  base.properties.bannerHeight = integerInRange(properties.bannerHeight, PROPERTY_BANNER_HEIGHT_RANGE[0], PROPERTY_BANNER_HEIGHT_RANGE[1], base.properties.bannerHeight)
  base.properties.bannerFade = booleanValue(properties.bannerFade, base.properties.bannerFade)
  base.properties.bannerPosition = integerInRange(properties.bannerPosition, 0, 100, base.properties.bannerPosition)
  base.properties.iconSize = integerInRange(properties.iconSize, PROPERTY_ICON_SIZE_RANGE[0], PROPERTY_ICON_SIZE_RANGE[1], base.properties.iconSize)
  base.properties.iconInline = booleanValue(properties.iconInline, base.properties.iconInline)
  base.properties.coloredValues = booleanValue(properties.coloredValues, base.properties.coloredValues)
  base.properties.hideHeader = booleanValue(properties.hideHeader, base.properties.hideHeader)
  base.properties.hideAddButton = booleanValue(properties.hideAddButton, base.properties.hideAddButton)
  base.properties.hideWholeBlockWhenEmpty = booleanValue(properties.hideWholeBlockWhenEmpty, base.properties.hideWholeBlockWhenEmpty)
  base.properties.revealHidden = booleanValue(properties.revealHidden, base.properties.revealHidden)
  base.properties.hideAllEmpty = booleanValue(properties.hideAllEmpty, base.properties.hideAllEmpty)
  base.properties.hidden = Array.isArray(properties.hidden)
    ? propertyNameList(properties.hidden, PROPERTY_LIST_MAX, propertyBudget)
    : base.properties.hidden
  base.properties.hiddenWhenEmpty = Array.isArray(properties.hiddenWhenEmpty)
    ? propertyNameList(properties.hiddenWhenEmpty, PROPERTY_LIST_MAX, propertyBudget)
    : base.properties.hiddenWhenEmpty
  base.properties.colors = colorMap(properties.colors, propertyBudget)
  base.properties.useCustomDateFormats = booleanValue(properties.useCustomDateFormats, base.properties.useCustomDateFormats)
  base.properties.dateFormat = trimmedText(properties.dateFormat, PROPERTY_DATE_PATTERN_MAX)
  base.properties.dateTimeFormat = trimmedText(properties.dateTimeFormat, PROPERTY_DATE_PATTERN_MAX)
  base.properties.relativeDateColors = booleanValue(properties.relativeDateColors, base.properties.relativeDateColors)
  base.properties.datePastColor = hexOrNull(properties.datePastColor)
  base.properties.datePresentColor = hexOrNull(properties.datePresentColor)
  base.properties.dateFutureColor = hexOrNull(properties.dateFutureColor)
  base.properties.progress = progressMap(properties.progress, propertyBudget)
  base.properties.formats = formatMap(properties.formats, propertyBudget)
  base.properties.selectOptions = optionsMap(properties.selectOptions, propertyBudget)
  base.properties.quickSearchKey = enumValue(properties.quickSearchKey, QUICK_SEARCH_KEYS, base.properties.quickSearchKey)

  base.backup.schedule = enumValue(
    backup.schedule,
    BACKUP_SCHEDULES,
    base.backup.schedule,
  )
  base.backup.retentionCount = integerInRange(backup.retentionCount, 0, 1000, base.backup.retentionCount)

  base.sync.realtime = booleanValue(sync.realtime, base.sync.realtime)
  base.sync.pollIntervalMs = integerInRange(
    sync.pollIntervalMs,
    5000,
    120_000,
    base.sync.pollIntervalMs,
  )

  base.search.enabled = booleanValue(search.enabled, base.search.enabled)
  base.search.useCache = booleanValue(search.useCache, base.search.useCache)
  base.search.ribbonButton = booleanValue(search.ribbonButton, base.search.ribbonButton)
  base.search.showExcerpt = booleanValue(search.showExcerpt, base.search.showExcerpt)
  base.search.plainExcerpt = booleanValue(search.plainExcerpt, base.search.plainExcerpt)
  base.search.renderLineReturnInExcerpts = booleanValue(
    search.renderLineReturnInExcerpts,
    base.search.renderLineReturnInExcerpts,
  )
  base.search.showCreateButton = booleanValue(search.showCreateButton, base.search.showCreateButton)
  base.search.showPreviousQueryResults = booleanValue(
    search.showPreviousQueryResults,
    base.search.showPreviousQueryResults,
  )
  base.search.maxEmbeds = integerInRange(search.maxEmbeds, 0, 10, base.search.maxEmbeds)
  base.search.maxResults = integerInRange(search.maxResults, 10, 100, base.search.maxResults)
  base.search.fuzziness = enumValue(search.fuzziness, OMNISEARCH_FUZZINESS, base.search.fuzziness)
  base.search.simpleSearch = booleanValue(search.simpleSearch, base.search.simpleSearch)
  base.search.ignoreDiacritics = booleanValue(search.ignoreDiacritics, base.search.ignoreDiacritics)
  base.search.splitCamelCase = booleanValue(search.splitCamelCase, base.search.splitCamelCase)
  base.search.cjkBigrams = booleanValue(search.cjkBigrams, base.search.cjkBigrams)
  base.search.pinyinSearch = booleanValue(search.pinyinSearch, base.search.pinyinSearch)
  base.search.recencyBoost = enumValue(search.recencyBoost, OMNISEARCH_RECENCY, base.search.recencyBoost)
  base.search.weightTitle = halfStepInRange(search.weightTitle, SEARCH_WEIGHT_RANGE, base.search.weightTitle)
  base.search.weightFolder = halfStepInRange(search.weightFolder, SEARCH_WEIGHT_RANGE, base.search.weightFolder)
  base.search.weightH1 = halfStepInRange(search.weightH1, SEARCH_WEIGHT_RANGE, base.search.weightH1)
  base.search.weightH2 = halfStepInRange(search.weightH2, SEARCH_WEIGHT_RANGE, base.search.weightH2)
  base.search.weightH3 = halfStepInRange(search.weightH3, SEARCH_WEIGHT_RANGE, base.search.weightH3)
  base.search.weightTags = halfStepInRange(search.weightTags, SEARCH_WEIGHT_RANGE, base.search.weightTags)
  base.search.weightCustomProperties = Array.isArray(search.weightCustomProperties)
    ? search.weightCustomProperties
      .map((item) => {
        const record = asRecord(item)
        return {
          name: trimmedText(record.name, PROPERTY_NAME_MAX),
          weight: numberInRange(record.weight, SEARCH_PROPERTY_WEIGHT_RANGE[0], SEARCH_PROPERTY_WEIGHT_RANGE[1], 1),
        }
      })
      .filter((item) => item.name)
      .slice(0, SEARCH_CUSTOM_PROPERTIES_MAX)
    : base.search.weightCustomProperties
  base.search.downrankedFolders = Array.isArray(search.downrankedFolders)
    ? uniqueFolderPaths(search.downrankedFolders, SEARCH_DOWNRANKED_FOLDERS_MAX)
    : base.search.downrankedFolders
  base.search.hideArchived = booleanValue(search.hideArchived, base.search.hideArchived)
  base.search.displayTitleProperty = trimmedText(search.displayTitleProperty, SEARCH_DISPLAY_TITLE_MAX)
  base.search.maxIndexedNotes = integerInRange(search.maxIndexedNotes, 200, 20000, base.search.maxIndexedNotes)
  base.search.maxContentChars = integerInRange(search.maxContentChars, 2000, 200000, base.search.maxContentChars)
  base.search.indexStorageMb = integerInRange(search.indexStorageMb, 8, 512, base.search.indexStorageMb)
  base.dataview.enabled = booleanValue(dataview.enabled, base.dataview.enabled)
  base.dataview.inlineQueries = booleanValue(dataview.inlineQueries, base.dataview.inlineQueries)
  base.dataview.inlineFields = booleanValue(dataview.inlineFields, base.dataview.inlineFields)
  base.dataview.jsBlocks = booleanValue(dataview.jsBlocks, base.dataview.jsBlocks)
  base.dataview.includeArchived = booleanValue(dataview.includeArchived, base.dataview.includeArchived)
  base.dataview.showErrorDetails = booleanValue(dataview.showErrorDetails, base.dataview.showErrorDetails)
  base.dataview.liveRefresh = booleanValue(dataview.liveRefresh, base.dataview.liveRefresh)
  base.dataview.renderNullAs = trimmedText(dataview.renderNullAs, 24)
  base.dataview.dateFormat = trimmedText(dataview.dateFormat, 40) || DEFAULT_SETTINGS.dataview.dateFormat
  base.dataview.datetimeFormat = trimmedText(dataview.datetimeFormat, 40) || DEFAULT_SETTINGS.dataview.datetimeFormat
  base.dataview.durationFormat = enumValue(dataview.durationFormat, DURATION_FORMATS, base.dataview.durationFormat)
  base.dataview.maxRows = integerInRange(dataview.maxRows, 10, 2000, base.dataview.maxRows)
  base.dataview.bodyLimit = integerInRange(dataview.bodyLimit, 20, 5000, base.dataview.bodyLimit)
  base.dataview.tableIdColumnName = trimmedText(dataview.tableIdColumnName, 40) || DEFAULT_SETTINGS.dataview.tableIdColumnName
  base.dataview.tableGroupColumnName = trimmedText(dataview.tableGroupColumnName, 40) || DEFAULT_SETTINGS.dataview.tableGroupColumnName
  base.dataview.maxRecursiveRenderDepth = integerInRange(dataview.maxRecursiveRenderDepth, 1, 12, base.dataview.maxRecursiveRenderDepth)
  base.dataview.showResultCount = booleanValue(dataview.showResultCount, base.dataview.showResultCount)
  base.dataview.warnOnEmptyResult = booleanValue(dataview.warnOnEmptyResult, base.dataview.warnOnEmptyResult)
  base.dataview.inlineJsQueries = booleanValue(dataview.inlineJsQueries, base.dataview.inlineJsQueries)
  // A stored settings blob written before this setting existed has no key at all, which must mean the
  // default prefix rather than "off"; an explicit empty string is the reader turning it off. A prefix
  // starting with `=` would turn every inline query into code, so that shape falls back too.
  const inlineJsPrefix = dataview.inlineJsQueryPrefix === undefined
    ? DEFAULT_SETTINGS.dataview.inlineJsQueryPrefix
    : trimmedText(dataview.inlineJsQueryPrefix, 8)
  base.dataview.inlineJsQueryPrefix = inlineJsPrefix.startsWith('=') ? DEFAULT_SETTINGS.dataview.inlineJsQueryPrefix : inlineJsPrefix
  base.dataview.inlineQueriesInCodeblocks = booleanValue(dataview.inlineQueriesInCodeblocks, base.dataview.inlineQueriesInCodeblocks)
  base.dataview.prettyInlineFieldsLivePreview = booleanValue(dataview.prettyInlineFieldsLivePreview, base.dataview.prettyInlineFieldsLivePreview)
  base.dataview.allowHtmlInExports = booleanValue(dataview.allowHtmlInExports, base.dataview.allowHtmlInExports)
  base.dataview.savedQueries = savedDataviewQueries(dataview.savedQueries)
  base.dataview.taskCompletionTracking = booleanValue(dataview.taskCompletionTracking, base.dataview.taskCompletionTracking)
  base.dataview.taskCompletionUseEmojiShorthand = booleanValue(dataview.taskCompletionUseEmojiShorthand, base.dataview.taskCompletionUseEmojiShorthand)
  base.dataview.recursiveSubTaskCompletion = booleanValue(dataview.recursiveSubTaskCompletion, base.dataview.recursiveSubTaskCompletion)
  base.dataview.taskCompletionText = trimmedText(dataview.taskCompletionText, 40) || DEFAULT_SETTINGS.dataview.taskCompletionText
  base.dataview.taskCompletionDateFormat = trimmedText(dataview.taskCompletionDateFormat, 40) || DEFAULT_SETTINGS.dataview.taskCompletionDateFormat

  return base
}


const DURATION_FORMATS: DurationFormatName[] = ['long', 'short', 'tiny']

/**
 * A saved query is a name and its text with a stable id, so reordering the list reads as an edit
 * rather than a delete plus an insert to the account snapshot. Both strings are capped because the
 * whole list travels inside the settings document.
 */
function savedDataviewQueries(value: unknown): SavedDataviewQuery[] {
  if (!Array.isArray(value)) return []
  const out: SavedDataviewQuery[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const record = asRecord(item)
    const name = trimmedText(record.name, 60)
    const query = typeof record.query === 'string' ? record.query.slice(0, 4000) : ''
    if (!name || !query) continue
    // The id is a local identifier, not a database row: a saved query that lost its id would be a
    // different entry to the account snapshot, so a shape-matching one is kept and a stray is dropped.
    const id = /^[a-z0-9][a-z0-9-]{3,63}$/i.test(String(record.id ?? '')) ? String(record.id).toLowerCase() : ''
    const key = id || `${name}\u0000${query}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ id: key, name, query })
    if (out.length >= 40) break
  }
  return out
}

function halfStepInRange(value: unknown, range: readonly [number, number], fallback: number): number {
  const clamped = numberInRange(value, range[0], range[1], fallback)
  return Math.round(clamped * 2) / 2
}

function uniqueFolderPaths(value: readonly unknown[], max: number): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const path = typeof item === 'string' ? item.trim().replace(/^\/+|\/+$/g, '').slice(0, 120) : ''
    // The server compares folder names with COLLATE NOCASE, so two spellings of one folder would
    // otherwise occupy two slots that downrank exactly the same notes.
    const key = path.toLowerCase()
    if (!path || seen.has(key)) continue
    seen.add(key)
    out.push(path)
    if (out.length >= max) break
  }
  return out
}


const SETTINGS_SECTIONS = ['appearance', 'editor', 'preview', 'properties', 'backup', 'sync', 'notes', 'search', 'dataview'] as const

export function normalizeTodoTags(value: unknown): string {
  if (typeof value !== 'string')
    return ''
  const seen = new Set<string>()
  for (const part of value.split(',')) {
    const tag = part.trim().replace(/^#/, '').slice(0, LIMITS.tagNameMaxLength)
    if (tag)
      seen.add(tag)
    if (seen.size === TODO_TAG_LIST_MAX)
      break
  }
  return [...seen].join(',')
}

function sameFlatRecord(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

export function mergeSettingsPatch(current: unknown, patch: unknown): UserSettings {
  const previous = asRecord(current)
  const incoming = asRecord(patch)
  const combined: Record<string, unknown> = { ...previous }
  for (const section of SETTINGS_SECTIONS) {
    const delta = asRecord(incoming[section])
    combined[section] = Object.keys(delta).length
      ? { ...asRecord(previous[section]), ...delta }
      : previous[section]
  }
  const next: Record<string, unknown> = { ...mergeSettings(combined) }
  for (const section of SETTINGS_SECTIONS) {
    const before = asRecord(previous[section])
    if (Object.keys(before).length && sameFlatRecord(asRecord(next[section]), before))
      next[section] = before
  }
  return next as unknown as UserSettings
}

function cloneDefaultSettings(): UserSettings {
  return {
    appearance: { ...DEFAULT_SETTINGS.appearance },
    editor: { ...DEFAULT_SETTINGS.editor },
    preview: { ...DEFAULT_SETTINGS.preview },
    properties: {
      ...DEFAULT_SETTINGS.properties,
      coverProperties: [...DEFAULT_SETTINGS.properties.coverProperties],
      hidden: [...DEFAULT_SETTINGS.properties.hidden],
      hiddenWhenEmpty: [...DEFAULT_SETTINGS.properties.hiddenWhenEmpty],
      colors: {},
      progress: {},
      formats: {},
      selectOptions: {},
    },
    backup: { ...DEFAULT_SETTINGS.backup },
    sync: { ...DEFAULT_SETTINGS.sync },
    notes: { ...DEFAULT_SETTINGS.notes },
    search: {
      ...DEFAULT_SETTINGS.search,
      weightCustomProperties: [],
      downrankedFolders: [],
    },
    dataview: {
      ...DEFAULT_SETTINGS.dataview,
      savedQueries: [],
    },
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : fallback
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function numberInRange(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
}

function integerInRange(value: unknown, min: number, max: number, fallback: number): number {
  return Math.round(numberInRange(value, min, max, fallback))
}
