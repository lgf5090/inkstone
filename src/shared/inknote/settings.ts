/** Validates the account's Inknote preferences; unknown or malformed fields fall back to defaults. */
import {
  DEFAULT_INKNOTE_SETTINGS,
  DEFAULT_PAPER,
  HIGHLIGHTER_COLORS,
  INKNOTE_ASSET_ID_RE,
  INKNOTE_LIMITS,
  PAPER_STYLES,
} from './constants'
import { normalizeInknoteColor, normalizePaperColor } from './color'
import type {
  InknoteFavorite,
  InknoteFontFamily,
  InknotePaper,
  InknotePaperStyle,
  InknotePenStyle,
  InknoteSettings,
  InknoteShapeTool,
  InknoteSpacing,
  InknoteTextPreset,
  InknoteTool,
} from './types'

type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null
}

function own(row: JsonRecord, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(row, key) ? row[key] : undefined
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function finite(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback
}

function text(value: unknown, max: number, fallback = ''): string {
  return typeof value === 'string' ? value.slice(0, max) : fallback
}

const TOOLS: readonly InknoteTool[] = ['ballpen', 'pen', 'highlighter', 'eraser', 'pixelEraser', 'lasso', 'text', 'shape']
const PEN_STYLES: readonly InknotePenStyle[] = ['normal', 'pencil', 'brush', 'dashed', 'dotted']
const SHAPES: readonly InknoteShapeTool[] = ['line', 'rect', 'ellipse', 'arrow']
const SPACINGS: readonly InknoteSpacing[] = ['tight', 'normal', 'wide']
const FONTS: readonly InknoteFontFamily[] = ['system', 'rounded', 'serif', 'mono']
const PAPER_IDS = PAPER_STYLES.map((entry) => entry.id) as readonly InknotePaperStyle[]

export function sanitizePaper(raw: unknown): InknotePaper {
  const row = record(raw)
  if (!row) return { ...DEFAULT_PAPER }
  return {
    style: oneOf(own(row, 'style'), PAPER_IDS, DEFAULT_PAPER.style),
    color: normalizePaperColor(own(row, 'color')) ?? DEFAULT_PAPER.color,
    spacing: oneOf(own(row, 'spacing'), SPACINGS, DEFAULT_PAPER.spacing),
  }
}

function sanitizeFavorite(raw: unknown): InknoteFavorite | null {
  const row = record(raw)
  if (!row) return null
  const color = normalizeInknoteColor(own(row, 'color'))
  if (!color) return null
  return {
    tool: oneOf(own(row, 'tool'), TOOLS, 'ballpen'),
    color,
    width: finite(own(row, 'width'), 5, 1, 30),
    style: oneOf(own(row, 'style'), PEN_STYLES, 'normal'),
    eraserSize: finite(own(row, 'eraserSize'), 24, 8, 80),
  }
}

function sanitizePreset(raw: unknown): InknoteTextPreset | null {
  const row = record(raw)
  if (!row) return null
  const name = text(own(row, 'name'), 40).trim()
  if (!name) return null
  return {
    name,
    fontSize: finite(own(row, 'fontSize'), 26, 12, 72),
    bold: bool(own(row, 'bold'), false),
    italic: bool(own(row, 'italic'), false),
    underline: bool(own(row, 'underline'), false),
  }
}

export function sanitizeInknoteSettings(raw: unknown): InknoteSettings {
  const row = record(raw) ?? {}
  const color = normalizeInknoteColor(own(row, 'color'))
  const penColor = normalizeInknoteColor(own(row, 'penColor'))
  const ballpenColor = normalizeInknoteColor(own(row, 'ballpenColor'))
  const hlColor = normalizeInknoteColor(own(row, 'hlColor'))
  const favorites = Array.isArray(own(row, 'favorites'))
    ? (own(row, 'favorites') as unknown[]).slice(0, INKNOTE_LIMITS.favoritesMax).flatMap((entry) => {
        const parsed = sanitizeFavorite(entry)
        return parsed ? [parsed] : []
      })
    : []
  const presets = Array.isArray(own(row, 'textPresets'))
    ? (own(row, 'textPresets') as unknown[]).slice(0, INKNOTE_LIMITS.textPresetsMax).flatMap((entry) => {
        const parsed = sanitizePreset(entry)
        return parsed ? [parsed] : []
      })
    : []
  const tabs = Array.isArray(own(row, 'openTabs'))
    ? [...new Set((own(row, 'openTabs') as unknown[]).filter((entry): entry is string => typeof entry === 'string' && INKNOTE_ASSET_ID_RE.test(entry)))].slice(0, INKNOTE_LIMITS.openTabsMax)
    : []
  const ttsRate = finite(own(row, 'ttsRate'), DEFAULT_INKNOTE_SETTINGS.ttsRate, 0.5, 2)
  return {
    version: 1,
    fingerDraw: bool(own(row, 'fingerDraw'), DEFAULT_INKNOTE_SETTINGS.fingerDraw),
    tool: oneOf(own(row, 'tool'), TOOLS, DEFAULT_INKNOTE_SETTINGS.tool),
    color: color ?? (oneOf(own(row, 'tool'), TOOLS, 'ballpen') === 'highlighter' ? HIGHLIGHTER_COLORS[0]! : DEFAULT_INKNOTE_SETTINGS.color),
    shape: oneOf(own(row, 'shape'), SHAPES, DEFAULT_INKNOTE_SETTINGS.shape),
    penColor: penColor ?? DEFAULT_INKNOTE_SETTINGS.penColor,
    ballpenColor: ballpenColor ?? DEFAULT_INKNOTE_SETTINGS.ballpenColor,
    hlColor: hlColor ?? DEFAULT_INKNOTE_SETTINGS.hlColor,
    penWidth: finite(own(row, 'penWidth'), DEFAULT_INKNOTE_SETTINGS.penWidth, 1, 30),
    ballpenWidth: finite(own(row, 'ballpenWidth'), DEFAULT_INKNOTE_SETTINGS.ballpenWidth, 1, 30),
    hlWidth: finite(own(row, 'hlWidth'), DEFAULT_INKNOTE_SETTINGS.hlWidth, 1, 30),
    penStyle: oneOf(own(row, 'penStyle'), PEN_STYLES, DEFAULT_INKNOTE_SETTINGS.penStyle),
    ballpenStyle: oneOf(own(row, 'ballpenStyle'), PEN_STYLES, DEFAULT_INKNOTE_SETTINGS.ballpenStyle),
    eraserSize: finite(own(row, 'eraserSize'), DEFAULT_INKNOTE_SETTINGS.eraserSize, 8, 80),
    eraserMode: oneOf(own(row, 'eraserMode'), ['stroke', 'pixel'] as const, DEFAULT_INKNOTE_SETTINGS.eraserMode),
    favorites,
    favoritesBar: bool(own(row, 'favoritesBar'), DEFAULT_INKNOTE_SETTINGS.favoritesBar),
    textSize: finite(own(row, 'textSize'), DEFAULT_INKNOTE_SETTINGS.textSize, 12, 72),
    fontFamily: oneOf(own(row, 'fontFamily'), FONTS, DEFAULT_INKNOTE_SETTINGS.fontFamily),
    textPresets: presets,
    defaultPaper: sanitizePaper(own(row, 'defaultPaper')),
    defaultPageSize: oneOf(own(row, 'defaultPageSize'), ['standard', 'wide'] as const, DEFAULT_INKNOTE_SETTINGS.defaultPageSize),
    autoPage: bool(own(row, 'autoPage'), DEFAULT_INKNOTE_SETTINGS.autoPage),
    twoFingerAction: oneOf(own(row, 'twoFingerAction'), ['undo', 'redo', 'off'] as const, DEFAULT_INKNOTE_SETTINGS.twoFingerAction),
    threeFingerAction: oneOf(own(row, 'threeFingerAction'), ['redo', 'off'] as const, DEFAULT_INKNOTE_SETTINGS.threeFingerAction),
    noteSort: oneOf(own(row, 'noteSort'), ['updated', 'created', 'title'] as const, DEFAULT_INKNOTE_SETTINGS.noteSort),
    toolbar: oneOf(own(row, 'toolbar'), ['top', 'left', 'bottom'] as const, DEFAULT_INKNOTE_SETTINGS.toolbar),
    markup: bool(own(row, 'markup'), DEFAULT_INKNOTE_SETTINGS.markup),
    openTabs: tabs,
    welcomeSeen: bool(own(row, 'welcomeSeen'), DEFAULT_INKNOTE_SETTINGS.welcomeSeen),
    autoBackup: bool(own(row, 'autoBackup'), DEFAULT_INKNOTE_SETTINGS.autoBackup),
    aiPrompt: text(own(row, 'aiPrompt'), INKNOTE_LIMITS.aiPromptMax),
    ttsRate,
  }
}
