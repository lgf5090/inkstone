/** The durable shapes every Inknote surface agrees on: pages, notes, assets, settings. */

export const INKNOTE_PAGE_FORMAT = 'inknote-page' as const
export const INKNOTE_PAGE_VERSION = 1 as const

export type InknoteTool =
  | 'ballpen'
  | 'pen'
  | 'highlighter'
  | 'eraser'
  | 'pixelEraser'
  | 'lasso'
  | 'text'
  | 'shape'

export type InknotePenStyle = 'normal' | 'pencil' | 'brush' | 'dashed' | 'dotted'
export type InknoteShapeTool = 'line' | 'rect' | 'ellipse' | 'arrow'
export type InknoteShapeKind = InknoteShapeTool | 'square' | 'circle' | 'polygon' | 'curve'
export type InknotePaperStyle =
  | 'blank'
  | 'line'
  | 'grid'
  | 'dot'
  | 'cornell'
  | 'check'
  | 'planner'
  | 'story'
  | 'music'
  | 'legal'
export type InknoteSpacing = 'tight' | 'normal' | 'wide'
export type InknotePageSize = 'standard' | 'wide'
export type InknoteTextAlign = 'left' | 'center' | 'right'
export type InknoteTextList = 'bullet' | 'number' | null
export type InknoteFontFamily = 'system' | 'rounded' | 'serif' | 'mono'

export interface InknotePoint {
  x: number
  y: number
  p: number
}

export interface InknoteStroke {
  id: string
  tool: 'pen' | 'ballpen' | 'highlighter'
  style: InknotePenStyle
  shape: InknoteShapeKind | null
  color: string
  width: number
  points: InknotePoint[]
}

export interface InknoteTextBox {
  id: string
  x: number
  y: number
  w: number
  h: number
  text: string
  fontSize: number
  color: string
  align: InknoteTextAlign
  bold: boolean
  italic: boolean
  underline: boolean
  hl: string | null
  lh: number
  list: InknoteTextList
}

export interface InknoteImage {
  id: string
  x: number
  y: number
  w: number
  h: number
  assetId: string
  url: string
  rot: 0 | 90 | 180 | 270
}

export interface InknotePageBackground {
  kind: 'image' | 'pdf'
  assetId: string
  url: string
  width: number
  height: number
  alpha: number
}

export interface InknotePageContent {
  format: typeof INKNOTE_PAGE_FORMAT
  version: typeof INKNOTE_PAGE_VERSION
  strokes: InknoteStroke[]
  texts: InknoteTextBox[]
  images: InknoteImage[]
  bg: InknotePageBackground | null
}

export interface InknotePaper {
  style: InknotePaperStyle
  color: string
  spacing: InknoteSpacing
}

export interface InknoteNoteMeta {
  id: string
  notebookId: string
  title: string
  pageCount: number
  contentBytes: number
  pageWidth: number
  pageHeight: number
  contentWidth: number
  contentHeight: number
  paper: InknotePaper
  colorTag: string | null
  pinned: boolean
  coverAssetId: string | null
  coverUrl: string | null
  rev: number
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export interface InknotePage {
  id: string
  position: number
  content: InknotePageContent
  rev: number
  updatedAt: number
}

export interface InknoteSubject {
  id: string
  name: string
  position: number
}

export interface InknoteNotebook {
  id: string
  subjectId: string
  name: string
  coverColor: string
  emoji: string
  position: number
}

export type InknoteAssetKind = 'image' | 'background' | 'cover' | 'audio' | 'pdf' | 'attachment' | 'template'

export interface InknoteAsset {
  id: string
  kind: InknoteAssetKind
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  url: string
  createdAt: number
}

export interface InknoteRecording {
  id: string
  noteId: string
  title: string
  durationMs: number
  audioAssetId: string
  audioUrl: string
  peaks: number[]
  createdAt: number
}

export interface InknoteRecordingEventStroke {
  t: number
  type: 'stroke'
  pageId: string
  data: InknoteStroke
}
export interface InknoteRecordingEventErase {
  t: number
  type: 'erase'
  pageId: string
  data: { ids: string[] }
}
export interface InknoteRecordingEventPage {
  t: number
  type: 'page'
  pageId: string
  data: { to: number }
}
export type InknoteRecordingEvent =
  | InknoteRecordingEventStroke
  | InknoteRecordingEventErase
  | InknoteRecordingEventPage

export interface InknoteTextPreset {
  name: string
  fontSize: number
  bold: boolean
  italic: boolean
  underline: boolean
}

export interface InknoteFavorite {
  tool: InknoteTool
  color: string
  width: number
  style: InknotePenStyle
  eraserSize: number
}

export interface InknoteTemplate {
  id: string
  name: string
  paper: InknotePaper
  bgAssetId: string | null
  bgUrl: string | null
  texts: InknoteTextBox[]
  title: string
  sub: string
  titleSize: number
  subSize: number
  builtIn: boolean
  createdAt: number
}

export interface InknoteSettings {
  version: 1
  fingerDraw: boolean
  tool: InknoteTool
  color: string
  shape: InknoteShapeTool
  penColor: string
  ballpenColor: string
  hlColor: string
  penWidth: number
  ballpenWidth: number
  hlWidth: number
  penStyle: InknotePenStyle
  ballpenStyle: InknotePenStyle
  eraserSize: number
  eraserMode: 'stroke' | 'pixel'
  favorites: InknoteFavorite[]
  favoritesBar: boolean
  textSize: number
  fontFamily: InknoteFontFamily
  textPresets: InknoteTextPreset[]
  defaultPaper: InknotePaper
  defaultPageSize: InknotePageSize
  autoPage: boolean
  twoFingerAction: 'undo' | 'redo' | 'off'
  threeFingerAction: 'redo' | 'off'
  noteSort: 'updated' | 'created' | 'title'
  toolbar: 'top' | 'left' | 'bottom'
  markup: boolean
  openTabs: string[]
  welcomeSeen: boolean
  autoBackup: boolean
  aiPrompt: string
  ttsRate: number
}

export interface InknoteLibrary {
  subjects: InknoteSubject[]
  notebooks: InknoteNotebook[]
  notes: InknoteNoteMeta[]
  settings: InknoteSettings
  templates: InknoteTemplate[]
}

export interface InknoteSearchResult {
  noteId: string
  title: string
  notebookId: string
  notebookName: string
  subjectName: string
  pageIndex: number
  snippet: string
  titleMatch: boolean
}

export interface InknoteUsage {
  notes: number
  pages: number
  assets: number
  assetsBytes: number
  snapshotsBytes: number
  quotaBytes: number
}

export interface InknoteSnapshotMeta {
  id: string
  label: string
  noteCount: number
  size: number
  createdAt: number
}
