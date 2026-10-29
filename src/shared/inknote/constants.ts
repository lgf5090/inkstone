/** Named content palettes, paper geometry and the capacity ceilings the API enforces. */
import type {
  InknotePaper,
  InknotePaperStyle,
  InknoteSettings,
  InknoteTemplate,
} from './types'

export const INKNOTE_PAGE_WIDTH = 816
export const INKNOTE_PAGE_HEIGHT = 1056
export const INKNOTE_WIDE_WIDTH = 1056
export const INKNOTE_WIDE_HEIGHT = 816

export const PAPER_STYLES: readonly { id: InknotePaperStyle; nameKey: string }[] = [
  { id: 'blank', nameKey: 'inknote.paper.blank' },
  { id: 'line', nameKey: 'inknote.paper.line' },
  { id: 'grid', nameKey: 'inknote.paper.grid' },
  { id: 'dot', nameKey: 'inknote.paper.dot' },
  { id: 'cornell', nameKey: 'inknote.paper.cornell' },
  { id: 'check', nameKey: 'inknote.paper.check' },
  { id: 'planner', nameKey: 'inknote.paper.planner' },
  { id: 'story', nameKey: 'inknote.paper.story' },
  { id: 'music', nameKey: 'inknote.paper.music' },
  { id: 'legal', nameKey: 'inknote.paper.legal' },
]

export interface InknotePaperSurface {
  id: string
  nameKey: string
  bg: string
  dark: boolean
  line: string
  grid: string
  dot: string
}

export const PAPER_COLORS: readonly InknotePaperSurface[] = [
  { id: 'white', nameKey: 'inknote.paper.white', bg: '#fffefb', dark: false, line: 'rgba(120,160,220,.35)', grid: 'rgba(120,160,220,.30)', dot: 'rgba(120,160,220,.45)' },
  { id: 'cream', nameKey: 'inknote.paper.cream', bg: '#fffcf2', dark: false, line: 'rgba(190,160,120,.38)', grid: 'rgba(190,160,120,.32)', dot: 'rgba(190,160,120,.45)' },
  { id: 'grey', nameKey: 'inknote.paper.grey', bg: '#f3f5f7', dark: false, line: 'rgba(110,130,160,.35)', grid: 'rgba(110,130,160,.30)', dot: 'rgba(110,130,160,.45)' },
  { id: 'black', nameKey: 'inknote.paper.black', bg: '#000000', dark: true, line: 'rgba(255,255,255,.14)', grid: 'rgba(255,255,255,.12)', dot: 'rgba(255,255,255,.22)' },
  { id: 'blue', nameKey: 'inknote.paper.pale_blue', bg: '#eef4ff', dark: false, line: 'rgba(90,120,200,.32)', grid: 'rgba(90,120,200,.28)', dot: 'rgba(90,120,200,.40)' },
  { id: 'green', nameKey: 'inknote.paper.pale_green', bg: '#f0fbf3', dark: false, line: 'rgba(80,160,110,.32)', grid: 'rgba(80,160,110,.28)', dot: 'rgba(80,160,110,.40)' },
]

export const PEN_COLORS = [
  '#1e293b', '#0f172a', '#475569', '#94a3b8', '#ffffff', '#dc2626', '#ea580c',
  '#d97706', '#16a34a', '#0891b2', '#2563eb', '#7c3aed', '#db2777',
] as const

export const HIGHLIGHTER_COLORS = [
  '#fde047', '#fef08a', '#fdba74', '#fca5a5', '#86efac', '#5eead4',
  '#7dd3fc', '#c4b5fd', '#f9a8d4', '#fda4af',
] as const

export const TAG_COLORS = ['#ef4444', '#f97316', '#facc15', '#22c55e', '#3b82f6', '#a855f7'] as const
export const NOTEBOOK_COVER_COLORS = ['#38bdf8', '#6366f1', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#fb7185', '#94a3b8'] as const
export const PRESENTATION_COLORS = ['#facc15', '#ef4444', '#22c55e', '#3b82f6', '#f8fafc'] as const

export const PAPER_SURFACE_BY_ID = new Map(PAPER_COLORS.map((entry) => [entry.id, entry]))

/** The line/grid spacing of a paper, in display pixels, before the tight/wide multiplier. */
export const PAPER_LINE_HEIGHT = 48
export const PAPER_GRID_SIZE = 38
export const SHAPE_SNAP_SIZE = 38

export const INKNOTE_LIMITS = {
  titleMaxLength: 512,
  nameMaxLength: 120,
  pageContentMaxBytes: 1_800_000,
  noteContentMaxBytes: 12_000_000,
  pagesPerNote: 500,
  notesPerUser: 10_000,
  subjectsPerUser: 200,
  notebooksPerUser: 1_000,
  templatesPerUser: 200,
  strokesPerPage: 20_000,
  pointsPerStroke: 20_000,
  pointsPerPage: 500_000,
  textsPerPage: 5_000,
  imagesPerPage: 500,
  textLength: 20_000,
  searchQueryMaxLength: 200,
  searchResultsMax: 100,
  assetMaxBytes: 25 * 1024 * 1024,
  importMaxBytes: 64 * 1024 * 1024,
  importMaxNotes: 500,
  snapshotMaxBytes: 16 * 1024 * 1024,
  snapshotRetention: 10,
  timelineMaxBytes: 8 * 1024 * 1024,
  recordingMaxMs: 4 * 60 * 60 * 1000,
  openTabsMax: 20,
  favoritesMax: 20,
  textPresetsMax: 20,
  aiPromptMax: 2_000,
} as const

export const INKNOTE_ASSET_URL_PREFIX = '/api/inknote/assets/'
export const INKNOTE_ASSET_ID_RE = /^[0-9a-hjkmnp-tv-z]{26}$/

export const DEFAULT_PAPER: InknotePaper = { style: 'line', color: 'white', spacing: 'normal' }

export const DEFAULT_INKNOTE_SETTINGS: InknoteSettings = {
  version: 1,
  fingerDraw: false,
  tool: 'ballpen',
  color: '#1e293b',
  shape: 'line',
  penColor: '#1e293b',
  ballpenColor: '#1e293b',
  hlColor: '#fde047',
  penWidth: 5,
  ballpenWidth: 5,
  hlWidth: 14,
  penStyle: 'normal',
  ballpenStyle: 'normal',
  eraserSize: 24,
  eraserMode: 'stroke',
  favorites: [],
  favoritesBar: true,
  textSize: 26,
  fontFamily: 'system',
  textPresets: [],
  defaultPaper: DEFAULT_PAPER,
  defaultPageSize: 'standard',
  autoPage: true,
  twoFingerAction: 'undo',
  threeFingerAction: 'redo',
  noteSort: 'updated',
  toolbar: 'top',
  markup: false,
  openTabs: [],
  welcomeSeen: false,
  autoBackup: true,
  aiPrompt: '',
  ttsRate: 1,
}

interface BuiltinCopy {
  nameKey: string
  titleKey: string
  subKey: string
  paper: InknotePaper
  titleSize: number
  subSize: number
}

export const BUILTIN_TEMPLATE_COPY: readonly (BuiltinCopy & { id: string })[] = [
  { id: 'tpl-lecture', nameKey: 'inknote.template.lecture', titleKey: 'inknote.template.lecture_title', subKey: 'inknote.template.lecture_sub', paper: { style: 'cornell', color: 'white', spacing: 'normal' }, titleSize: 32, subSize: 15 },
  { id: 'tpl-meeting', nameKey: 'inknote.template.meeting', titleKey: 'inknote.template.meeting_title', subKey: 'inknote.template.meeting_sub', paper: { style: 'line', color: 'white', spacing: 'normal' }, titleSize: 32, subSize: 15 },
  { id: 'tpl-todo', nameKey: 'inknote.template.todo', titleKey: 'inknote.template.todo_title', subKey: 'inknote.template.todo_sub', paper: { style: 'check', color: 'white', spacing: 'normal' }, titleSize: 30, subSize: 15 },
  { id: 'tpl-daily', nameKey: 'inknote.template.daily', titleKey: 'inknote.template.daily_title', subKey: 'inknote.template.daily_sub', paper: { style: 'planner', color: 'white', spacing: 'normal' }, titleSize: 30, subSize: 15 },
  { id: 'tpl-reading', nameKey: 'inknote.template.reading', titleKey: 'inknote.template.reading_title', subKey: 'inknote.template.reading_sub', paper: { style: 'cornell', color: 'cream', spacing: 'normal' }, titleSize: 30, subSize: 15 },
  { id: 'tpl-study', nameKey: 'inknote.template.study', titleKey: 'inknote.template.study_title', subKey: 'inknote.template.study_sub', paper: { style: 'planner', color: 'blue', spacing: 'normal' }, titleSize: 30, subSize: 15 },
  { id: 'tpl-errors', nameKey: 'inknote.template.errors', titleKey: 'inknote.template.errors_title', subKey: 'inknote.template.errors_sub', paper: { style: 'line', color: 'white', spacing: 'normal' }, titleSize: 30, subSize: 15 },
]

export function blankTemplate(id: string, copy: BuiltinCopy): InknoteTemplate {
  return {
    id,
    name: copy.nameKey,
    paper: { ...copy.paper },
    bgAssetId: null,
    bgUrl: null,
    texts: [],
    title: copy.titleKey,
    sub: copy.subKey,
    titleSize: copy.titleSize,
    subSize: copy.subSize,
    builtIn: true,
    createdAt: 0,
  }
}

export const BUILTIN_TEMPLATES: readonly InknoteTemplate[] = BUILTIN_TEMPLATE_COPY.map((copy) => blankTemplate(copy.id, copy))
