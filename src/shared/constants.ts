import type {
  AccentName,
  CodeFormatKeywordCase,
  DraggerBlockStyle,
  DraggerColorMode,
  DraggerGutterSide,
  DraggerHandleIcon,
  DraggerHandleVisibility,
  DraggerMenuOrders,
  DraggerMenuRootItemId,
  DraggerSelectionStyle,
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
  SidebarTab,
  SkinTone,
  UserSettings,
  ViewKind,
} from './types'
import { COVER_POSITIONS, COVER_SHAPES } from './property-decorations'
import { DEFAULT_LINTER_SETTINGS, normalizeLinterSettings } from './linter'
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
  linter: {
    ...DEFAULT_LINTER_SETTINGS,
    ruleConfigs: {},
    commonStyles: { ...DEFAULT_LINTER_SETTINGS.commonStyles },
  },
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
    dragger: true,
    draggerHandles: 'hover',
    draggerHandleIcon: 'grip-dots',
    draggerHandleGlyph: '⠿',
    draggerHandleSize: 20,
    draggerHandleOffset: 0,
    draggerHandleSide: 'left',
    draggerHandleColorMode: 'theme',
    draggerHandleColor: '#8a8a8a',
    draggerIndicatorColorMode: 'theme',
    draggerIndicatorColor: '#7a7a7a',
    draggerMultiSelect: true,
    draggerMultiSelectMs: 700,
    draggerMobileArmMs: 200,
    draggerAutoScroll: true,
    draggerAutoScrollEdge: 60,
    draggerAutoScrollSpeed: 12,
    draggerHighlight: true,
    draggerSelectionStyle: 'subtle',
    draggerMobileTextDrag: true,
    draggerExitDragModeAfterDrop: true,
    draggerDragModeButton: true,
    draggerMoveKeys: true,
    draggerMenuOrders: {
      root: ['paragraph', 'heading', 'list', 'quote', 'callout', 'code-block', 'math-block', 'custom'],
      heading: ['heading-1', 'heading-2', 'heading-3', 'heading-4', 'heading-5', 'heading-6'],
      list: ['list-unordered', 'list-ordered', 'list-task'],
      callout: ['callout-note', 'callout-tip', 'callout-warning'],
      custom: [],
    },
    draggerBlockStyles: [],
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
    linkHoverLinks: true,
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
const DRAGGER_HANDLE_VISIBILITIES: DraggerHandleVisibility[] = ['hover', 'always', 'hidden']
const DRAGGER_HANDLE_ICONS: DraggerHandleIcon[] = ['dot', 'grip-dots', 'grip-lines', 'square', 'custom']
const DRAGGER_GUTTER_SIDES: DraggerGutterSide[] = ['left', 'right']
const DRAGGER_COLOR_MODES: DraggerColorMode[] = ['theme', 'custom']
const DRAGGER_SELECTION_STYLES: DraggerSelectionStyle[] = ['outline', 'subtle', 'filled']
export const DRAGGER_MENU_ROOT_IDS: DraggerMenuRootItemId[] = [
  'paragraph', 'heading', 'list', 'quote', 'callout', 'code-block', 'math-block', 'custom',
]
export const DRAGGER_HEADING_ITEM_IDS = ['heading-1', 'heading-2', 'heading-3', 'heading-4', 'heading-5', 'heading-6']
export const DRAGGER_LIST_ITEM_IDS = ['list-unordered', 'list-ordered', 'list-task']
export const DRAGGER_CALLOUT_ITEM_IDS = ['callout-note', 'callout-tip', 'callout-warning']
export const DRAGGER_HANDLE_SIZE_RANGE = [12, 28] as const
export const DRAGGER_HANDLE_OFFSET_RANGE = [-80, 80] as const
export const DRAGGER_MOBILE_ARM_RANGE = [50, 800] as const
export const DRAGGER_MULTI_SELECT_RANGE = [50, 2000] as const
export const DRAGGER_AUTO_SCROLL_EDGE_RANGE = [20, 200] as const
export const DRAGGER_AUTO_SCROLL_SPEED_RANGE = [4, 60] as const
export const DRAGGER_HANDLE_GLYPH_MAX = 4
export const DRAGGER_BLOCK_STYLES_MAX = 24
export const DRAGGER_STYLE_LABEL_MAX = 40
export const DRAGGER_STYLE_ICON_MAX = 8
export const DRAGGER_STYLE_TEMPLATE_MAX = 400
export const DRAGGER_STYLE_PREFIX_MAX = 8
export const DRAGGER_STYLE_VARIABLES_MAX = 8
export const DRAGGER_STYLE_NAME_MAX = 24
export const DRAGGER_STYLE_VALUE_MAX = 120
export const DRAGGER_CONTENT_TOKEN = '${content}'
const DRAGGER_STYLE_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/
const DRAGGER_VARIABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

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

  // the linter section is a nested record, so it is rebuilt from the reader's blob rather than
  // patched onto a default: an unknown rule or an oversized option has to be dropped, not stored
  base.linter = normalizeLinterSettings(src.linter)

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
  base.editor.dragger = booleanValue(editor.dragger, base.editor.dragger)
  base.editor.draggerHandles = enumValue(editor.draggerHandles, DRAGGER_HANDLE_VISIBILITIES, base.editor.draggerHandles)
  base.editor.draggerHandleIcon = enumValue(editor.draggerHandleIcon, DRAGGER_HANDLE_ICONS, base.editor.draggerHandleIcon)
  base.editor.draggerHandleGlyph = draggerGlyph(
    editor.draggerHandleGlyph,
    base.editor.draggerHandleGlyph,
    DRAGGER_HANDLE_GLYPH_MAX,
  )
  base.editor.draggerHandleSize = integerInRange(
    editor.draggerHandleSize,
    DRAGGER_HANDLE_SIZE_RANGE[0],
    DRAGGER_HANDLE_SIZE_RANGE[1],
    base.editor.draggerHandleSize,
  )
  base.editor.draggerHandleOffset = integerInRange(
    editor.draggerHandleOffset,
    DRAGGER_HANDLE_OFFSET_RANGE[0],
    DRAGGER_HANDLE_OFFSET_RANGE[1],
    base.editor.draggerHandleOffset,
  )
  base.editor.draggerHandleSide = enumValue(editor.draggerHandleSide, DRAGGER_GUTTER_SIDES, base.editor.draggerHandleSide)
  base.editor.draggerHandleColorMode = enumValue(
    editor.draggerHandleColorMode,
    DRAGGER_COLOR_MODES,
    base.editor.draggerHandleColorMode,
  )
  base.editor.draggerHandleColor = hexOrNull(editor.draggerHandleColor) ?? base.editor.draggerHandleColor
  base.editor.draggerIndicatorColorMode = enumValue(
    editor.draggerIndicatorColorMode,
    DRAGGER_COLOR_MODES,
    base.editor.draggerIndicatorColorMode,
  )
  base.editor.draggerIndicatorColor = hexOrNull(editor.draggerIndicatorColor) ?? base.editor.draggerIndicatorColor
  base.editor.draggerMultiSelect = booleanValue(editor.draggerMultiSelect, base.editor.draggerMultiSelect)
  base.editor.draggerMultiSelectMs = integerInRange(
    editor.draggerMultiSelectMs,
    DRAGGER_MULTI_SELECT_RANGE[0],
    DRAGGER_MULTI_SELECT_RANGE[1],
    base.editor.draggerMultiSelectMs,
  )
  base.editor.draggerMobileArmMs = integerInRange(
    editor.draggerMobileArmMs,
    DRAGGER_MOBILE_ARM_RANGE[0],
    DRAGGER_MOBILE_ARM_RANGE[1],
    base.editor.draggerMobileArmMs,
  )
  base.editor.draggerAutoScroll = booleanValue(editor.draggerAutoScroll, base.editor.draggerAutoScroll)
  base.editor.draggerAutoScrollEdge = integerInRange(
    editor.draggerAutoScrollEdge,
    DRAGGER_AUTO_SCROLL_EDGE_RANGE[0],
    DRAGGER_AUTO_SCROLL_EDGE_RANGE[1],
    base.editor.draggerAutoScrollEdge,
  )
  base.editor.draggerAutoScrollSpeed = integerInRange(
    editor.draggerAutoScrollSpeed,
    DRAGGER_AUTO_SCROLL_SPEED_RANGE[0],
    DRAGGER_AUTO_SCROLL_SPEED_RANGE[1],
    base.editor.draggerAutoScrollSpeed,
  )
  base.editor.draggerHighlight = booleanValue(editor.draggerHighlight, base.editor.draggerHighlight)
  base.editor.draggerSelectionStyle = enumValue(
    editor.draggerSelectionStyle,
    DRAGGER_SELECTION_STYLES,
    base.editor.draggerSelectionStyle,
  )
  base.editor.draggerMobileTextDrag = booleanValue(editor.draggerMobileTextDrag, base.editor.draggerMobileTextDrag)
  base.editor.draggerExitDragModeAfterDrop = booleanValue(
    editor.draggerExitDragModeAfterDrop,
    base.editor.draggerExitDragModeAfterDrop,
  )
  base.editor.draggerDragModeButton = booleanValue(editor.draggerDragModeButton, base.editor.draggerDragModeButton)
  base.editor.draggerMoveKeys = booleanValue(editor.draggerMoveKeys, base.editor.draggerMoveKeys)
  base.editor.draggerBlockStyles = draggerBlockStyles(editor.draggerBlockStyles)
  base.editor.draggerMenuOrders = draggerMenuOrders(
    editor.draggerMenuOrders,
    base.editor.draggerBlockStyles.map((style) => style.id),
  )

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
  base.preview.linkHoverLinks = booleanValue(preview.linkHoverLinks, base.preview.linkHoverLinks)
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

  return base
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


/**
 * A handle's glyph or a style's icon: invisible code points go, because the glyph is painted into a
 * fixed box where a control character would leave an empty handle the reader cannot find.
 */
function draggerGlyph(value: unknown, fallback: string, max: number): string {
  if (typeof value !== 'string') return fallback
  const kept = Array.from(value).filter((character) => !/[\p{Cc}\p{Cf}]/u.test(character)).slice(0, max).join('')
  return kept === '' ? fallback : kept
}

/**
 * A style's template keeps its line breaks — a multi-line block is the point of the field — but
 * nothing else invisible survives, so a stored template cannot smuggle a tab-run or a control byte
 * into a note.
 */
function draggerTemplate(value: unknown, max: number, keepLineBreaks: boolean): string {
  if (typeof value !== 'string') return ''
  return Array.from(value)
    .filter((character) => keepLineBreaks && (character === '\n' || character === '\t')
      || !/[\p{Cc}\p{Cf}]/u.test(character))
    .slice(0, max)
    .join('')
}

function draggerBlockStyles(value: unknown): DraggerBlockStyle[] {
  const styles = sanitizeBlockStyles(value)
  // A patch that left the editor alone is detected by comparing its keys by reference, so a stored
  // list that is already in the shape the sanitizer would write goes back out as the same array.
  return sameBlockStyles(value, styles) ? (value as DraggerBlockStyle[]) : styles
}

function sanitizeBlockStyles(value: unknown): DraggerBlockStyle[] {
  if (!Array.isArray(value)) return []
  const styles: DraggerBlockStyle[] = []
  const seen = new Set<string>()
  for (const entry of value.slice(0, DRAGGER_BLOCK_STYLES_MAX)) {
    // A non-record reads as an empty one, and an empty record fails the id and token checks below.
    const record = asRecord(entry)
    const id = typeof record.id === 'string' ? record.id : ''
    const template = draggerTemplate(record.template, DRAGGER_STYLE_TEMPLATE_MAX, true)
    if (!DRAGGER_STYLE_ID.test(id) || seen.has(id)) continue
    if (!template.includes(DRAGGER_CONTENT_TOKEN)) continue
    const label = draggerTemplate(record.label, DRAGGER_STYLE_LABEL_MAX, false).trim()
    if (label === '') continue
    const style: DraggerBlockStyle = { id, label, icon: draggerGlyph(record.icon, '', DRAGGER_STYLE_ICON_MAX), template }
    const linePrefix = draggerTemplate(record.linePrefix, DRAGGER_STYLE_PREFIX_MAX, false)
    if (linePrefix !== '') style.linePrefix = linePrefix
    const variables = draggerStyleVariables(record.variables)
    if (Object.keys(variables).length > 0) style.variables = variables
    seen.add(id)
    styles.push(style)
  }
  return styles
}

function draggerStyleVariables(value: unknown): Record<string, string> {
  const source = asRecord(value)
  const kept: Record<string, string> = {}
  for (const name of Object.keys(source).sort()) {
    if (Object.keys(kept).length >= DRAGGER_STYLE_VARIABLES_MAX) break
    if (name === 'content' || !DRAGGER_VARIABLE_NAME.test(name)) continue
    kept[name] = draggerTemplate(source[name], DRAGGER_STYLE_VALUE_MAX, true)
  }
  return kept
}

/**
 * One menu list: unknown, repeated, or non-string rows drop the whole list back to its default, so a
 * tampered order cannot hide a command the reader still expects. Missing rows are re-appended in
 * canonical order, which lets a new command join a list an older device already arranged.
 */
function draggerMenuOrder(value: unknown, expected: readonly string[], fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...expected]
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string' || !expected.includes(entry) || seen.has(entry)) return [...fallback]
    seen.add(entry)
  }
  return [...value as string[], ...expected.filter((id) => !seen.has(id))]
}

function draggerMenuOrders(value: unknown, styleIds: readonly string[]): DraggerMenuOrders {
  const source = asRecord(value)
  const next: DraggerMenuOrders = {
    root: draggerMenuOrder(source.root, DRAGGER_MENU_ROOT_IDS, DEFAULT_SETTINGS.editor.draggerMenuOrders.root) as DraggerMenuRootItemId[],
    heading: draggerMenuOrder(source.heading, DRAGGER_HEADING_ITEM_IDS, DEFAULT_SETTINGS.editor.draggerMenuOrders.heading),
    list: draggerMenuOrder(source.list, DRAGGER_LIST_ITEM_IDS, DEFAULT_SETTINGS.editor.draggerMenuOrders.list),
    callout: draggerMenuOrder(source.callout, DRAGGER_CALLOUT_ITEM_IDS, DEFAULT_SETTINGS.editor.draggerMenuOrders.callout),
    custom: draggerKnownStyleOrder(source.custom, styleIds),
  }
  return sameMenuOrders(value, next) ? (value as DraggerMenuOrders) : next
}

/** Every list in `value` spelled exactly as `next` spells it — same rows, same order. */
function sameMenuOrders(value: unknown, next: DraggerMenuOrders): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const source = value as Record<string, unknown>
  return (Object.keys(next) as (keyof DraggerMenuOrders)[]).every((key) => {
    const stored = source[key]
    return Array.isArray(stored) && stored.length === next[key].length
      && next[key].every((id, index) => stored[index] === id)
  })
}

/** Every style in `value` carrying the same fields, in the same order, as `next` writes them. */
function sameBlockStyles(value: unknown, next: DraggerBlockStyle[]): boolean {
  if (!Array.isArray(value) || value.length !== next.length) return false
  return next.every((style, index) => {
    const stored = asRecord(value[index])
    const keys = ['id', 'label', 'icon', 'template', 'linePrefix', 'variables'] as const
    return keys.every((key) => sameStyleField(stored[key], style[key]))
  })
}

function sameStyleField(stored: unknown, wanted: unknown): boolean {
  if (wanted === undefined) return stored === undefined || stored === null || stored === ''
  if (wanted && typeof wanted === 'object') {
    const source = asRecord(stored)
    const keys = Object.keys(wanted as Record<string, unknown>)
    return Object.keys(source).length === keys.length
      && keys.every((key) => source[key] === (wanted as Record<string, unknown>)[key])
  }
  return stored === wanted
}

function draggerKnownStyleOrder(value: unknown, styleIds: readonly string[]): string[] {
  const kept: string[] = []
  const seen = new Set<string>()
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== 'string' || !styleIds.includes(entry) || seen.has(entry)) continue
      seen.add(entry)
      kept.push(entry)
    }
  }
  // A style the order never heard of would be a menu row nobody can reach, so it joins the end: an
  // order can be re-arranged, a style the menu lost cannot be found again.
  return [...kept, ...styleIds.filter((id) => !seen.has(id))]
}

const SETTINGS_SECTIONS = ['appearance', 'editor', 'preview', 'properties', 'backup', 'sync', 'notes', 'search', 'linter'] as const

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
    editor: {
      ...DEFAULT_SETTINGS.editor,
      draggerMenuOrders: {
        root: [...DEFAULT_SETTINGS.editor.draggerMenuOrders.root],
        heading: [...DEFAULT_SETTINGS.editor.draggerMenuOrders.heading],
        list: [...DEFAULT_SETTINGS.editor.draggerMenuOrders.list],
        callout: [...DEFAULT_SETTINGS.editor.draggerMenuOrders.callout],
        custom: [...DEFAULT_SETTINGS.editor.draggerMenuOrders.custom],
      },
      draggerBlockStyles: [],
    },
    linter: {
      ...DEFAULT_LINTER_SETTINGS,
      ruleConfigs: {},
      customRegexes: [],
      foldersToIgnore: [],
      filesToIgnore: [],
      commonStyles: { ...DEFAULT_LINTER_SETTINGS.commonStyles },
    },
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
