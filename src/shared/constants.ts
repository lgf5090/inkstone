import type { AccentName, CodeFormatKeywordCase, EmojiInsertFormat, LinkEditorAliasMode, LinkEditorModifier, LinkEditorTrigger, SkinTone, UserSettings, ViewKind } from './types'
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
}

export const TODO_TAG_LIST_MAX = 8

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
export const EMOJI_SKIN_TONE_MAX = 5
const BACKUP_SCHEDULES = ['off', 'hourly', 'sixHourly', 'daily', 'weekly', 'monthly', 'yearly'] as const


export function mergeSettings(partial: unknown): UserSettings {
  const base = cloneDefaultSettings()
  const src = asRecord(partial)
  const appearance = asRecord(src.appearance)
  const editor = asRecord(src.editor)
  const preview = asRecord(src.preview)
  const backup = asRecord(src.backup)
  const sync = asRecord(src.sync)
  const notes = asRecord(src.notes)

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

  return base
}


const SETTINGS_SECTIONS = ['appearance', 'editor', 'preview', 'backup', 'sync', 'notes'] as const

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
    backup: { ...DEFAULT_SETTINGS.backup },
    sync: { ...DEFAULT_SETTINGS.sync },
    notes: { ...DEFAULT_SETTINGS.notes },
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
