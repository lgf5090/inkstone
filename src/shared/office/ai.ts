import { isOfficeFileType, OFFICE_LIMITS, type OfficeFileType } from './constants'
import type { OfficeSnapshot } from './model'

const OFFICE_ID_RE = /^[0-9a-hjkmnp-tv-z]{26}$/
const MAX_OPS = 200
const MAX_TEXT = 2_000
const MAX_CELLS = 10_000
const MAX_SUMMARY = 500

export type OfficeAiOp =
  | { kind: 'sheets.set-values'; sheet?: string; range: string; values: Array<Array<string | number | boolean | null>> }
  | { kind: 'sheets.set-formula'; sheet?: string; range: string; formula: string }
  | { kind: 'sheets.set-number-format'; sheet?: string; range: string; pattern: string }
  | { kind: 'sheets.set-style'; sheet?: string; range: string; bold?: boolean; italic?: boolean; background?: string; color?: string }
  | { kind: 'sheets.insert-rows'; sheet?: string; index: number; count: number }
  | { kind: 'sheets.delete-rows'; sheet?: string; index: number; count: number }
  | { kind: 'sheets.add-sheet'; name: string }
  | { kind: 'sheets.rename-sheet'; sheet: string; name: string }
  | { kind: 'docs.append-paragraph'; text: string }
  | { kind: 'docs.insert-text'; offset: number; text: string }
  | { kind: 'docs.replace-text'; search: string; replacement: string }
  | { kind: 'docs.insert-table'; rows: number; columns: number; values?: string[][] }
  | { kind: 'slides.add-slide'; name?: string }
  | { kind: 'slides.set-title'; slideIndex: number; text: string }
  | { kind: 'slides.add-text'; slideIndex: number; text: string; left?: number; top?: number; width?: number; height?: number; fontSize?: number }
  | { kind: 'slides.add-shape'; slideIndex: number; shape: 'rect' | 'ellipse' | 'roundRect' | 'diamond'; text?: string; left?: number; top?: number; width?: number; height?: number }
  | { kind: 'bases.add-table'; name: string; primaryField?: string }
  | { kind: 'bases.add-field'; table: string; name: string; fieldType: string }
  | { kind: 'bases.add-record'; table: string; values: Record<string, string | number | boolean | null> }
  | { kind: 'bases.set-record'; table: string; recordId: string; field: string; value: string | number | boolean | null }
  | { kind: 'boards.add-sticky'; text: string; left: number; top: number; width?: number; height?: number }
  | { kind: 'boards.add-shapes'; shapes: Array<{ shapeType: string; left: number; top: number; width?: number; height?: number; text?: string }> }
  | { kind: 'boards.add-connector'; from: { x: number; y: number }; to: { x: number; y: number }; label?: string }
  | { kind: 'pdfs.add-text'; pageIndex: number; text: string; x?: number; y?: number; width?: number; height?: number; fontSize?: number }
  | { kind: 'pdfs.add-table'; pageIndex: number; rows: number; columns: number; values?: string[][] }
  | { kind: 'pdfs.add-page'; index?: number }

/**
 * The op vocabulary in the words a model needs.
 *
 * A language model can only produce a plan this app accepts if the tool tells it what an op looks
 * like: the union above is a TypeScript type, invisible at the tool boundary. Every kind is listed
 * here with its fields, per product, and `OFFICE_AI_OP_KINDS` is the list a test compares the spec
 * against — a kind added to the union without a line here fails that test rather than the model.
 */
export const OFFICE_AI_OP_SPEC: string = [
  'sheets.set-values{range,values:[[cell,...],...],sheet?}',
  'sheets.set-formula{range,formula,sheet?}',
  'sheets.set-number-format{range,pattern,sheet?}',
  'sheets.set-style{range,bold?,italic?,background?,color?,sheet?}',
  'sheets.insert-rows{index,count,sheet?}',
  'sheets.delete-rows{index,count,sheet?}',
  'sheets.add-sheet{name}',
  'sheets.rename-sheet{sheet,name}',
  'docs.append-paragraph{text}',
  'docs.insert-text{offset,text}',
  'docs.replace-text{search,replacement}',
  'docs.insert-table{rows,columns,values?}',
  'slides.add-slide{name?}',
  'slides.set-title{slideIndex,text}',
  'slides.add-text{slideIndex,text,left?,top?,width?,height?,fontSize?}',
  'slides.add-shape{slideIndex,shape:rect|ellipse|roundRect|diamond,text?,left?,top?,width?,height?}',
  'bases.add-table{name,primaryField?}',
  'bases.add-field{table,name,fieldType}',
  'bases.add-record{table,values:{field:value}}',
  'bases.set-record{table,recordId,field,value}',
  'boards.add-sticky{text,left,top,width?,height?}',
  'boards.add-shapes{shapes:[{shapeType,left,top,width?,height?,text?}]}',
  'boards.add-connector{from:{x,y},to:{x,y},label?}',
  'pdfs.add-text{pageIndex,text,x?,y?,width?,height?,fontSize?}',
  'pdfs.add-table{pageIndex,rows,columns,values?}',
  'pdfs.add-page{index?}',
].join('\n')

/** The kinds the spec promises, for the drift test. */
export const OFFICE_AI_OP_KINDS: readonly string[] = OFFICE_AI_OP_SPEC
  .split('\n')
  .map((line) => line.slice(0, line.indexOf('{')))

export interface OfficeEditPlan {
  type: OfficeFileType
  fileId: string
  summary: string
  ops: OfficeAiOp[]
}

export type OfficePlanValidation =
  | { ok: true; plan: OfficeEditPlan }
  | { ok: false; error: string }

export type OfficeClientEffect =
  | { kind: 'office.open'; fileId: string; fileType: OfficeFileType }
  | { kind: 'office.refresh'; fileId?: string }
  | { kind: 'office.apply-plan'; fileId: string; fileType: OfficeFileType; plan: OfficeEditPlan }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed && trimmed.length <= max ? trimmed : null
}

function finite(value: unknown, min = -1_000_000, max = 1_000_000): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null
}

function integer(value: unknown, min = 0, max = 1_000_000): number | null {
  const number = finite(value, min, max)
  return number !== null && Number.isInteger(number) ? number : null
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function cellValue(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

function cellMatrix(value: unknown): Array<Array<string | number | boolean | null>> | null {
  if (!Array.isArray(value) || !value.length) return null
  let cells = 0
  const rows: Array<Array<string | number | boolean | null>> = []
  for (const row of value) {
    if (!Array.isArray(row) || !row.length) return null
    cells += row.length
    if (cells > MAX_CELLS) return null
    const parsed: Array<string | number | boolean | null> = []
    for (const cell of row) {
      const normalized = cellValue(cell)
      if (normalized === undefined) return null
      parsed.push(normalized)
    }
    rows.push(parsed)
  }
  return rows
}

function stringMatrix(value: unknown): string[][] | null {
  const matrix = cellMatrix(value)
  if (!matrix) return null
  return matrix.map((row) => row.map((cell) => String(cell ?? '')))
}

function recordValue(value: unknown): Record<string, string | number | boolean | null> | null {
  if (!isRecord(value)) return null
  const out: Record<string, string | number | boolean | null> = {}
  for (const [key, raw] of Object.entries(value)) {
    const parsed = cellValue(raw)
    if (!key.trim() || parsed === undefined) return null
    out[key.slice(0, 200)] = parsed
  }
  return out
}

function opOf(value: unknown): OfficeAiOp | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null
  const sheet = typeof value.sheet === 'string' ? value.sheet.slice(0, 200) : undefined
  switch (value.kind) {
    case 'sheets.set-values': {
      const range = text(value.range, 200)
      const values = cellMatrix(value.values)
      return range && values ? { kind: value.kind, ...(sheet ? { sheet } : {}), range, values } : null
    }
    case 'sheets.set-formula': {
      const range = text(value.range, 200)
      const formula = text(value.formula, 4_000)
      return range && formula ? { kind: value.kind, ...(sheet ? { sheet } : {}), range, formula } : null
    }
    case 'sheets.set-number-format': {
      const range = text(value.range, 200)
      const pattern = text(value.pattern, 200)
      return range && pattern ? { kind: value.kind, ...(sheet ? { sheet } : {}), range, pattern } : null
    }
    case 'sheets.set-style': {
      const range = text(value.range, 200)
      if (!range) return null
      const bold = bool(value.bold)
      const italic = bool(value.italic)
      const background = text(value.background, 40)
      const color = text(value.color, 40)
      return {
        kind: value.kind,
        ...(sheet ? { sheet } : {}),
        range,
        ...(bold !== undefined ? { bold } : {}),
        ...(italic !== undefined ? { italic } : {}),
        ...(background ? { background } : {}),
        ...(color ? { color } : {}),
      }
    }
    case 'sheets.insert-rows':
    case 'sheets.delete-rows': {
      const index = integer(value.index)
      const count = integer(value.count, 1, 5_000)
      return index !== null && count !== null ? { kind: value.kind, ...(sheet ? { sheet } : {}), index, count } : null
    }
    case 'sheets.add-sheet': {
      const name = text(value.name, 120)
      return name ? { kind: value.kind, name } : null
    }
    case 'sheets.rename-sheet': {
      const target = text(value.sheet, 200)
      const name = text(value.name, 120)
      return target && name ? { kind: value.kind, sheet: target, name } : null
    }
    case 'docs.append-paragraph': {
      const body = text(value.text, 20_000)
      return body ? { kind: value.kind, text: body } : null
    }
    case 'docs.insert-text': {
      const offset = integer(value.offset)
      const body = text(value.text, 20_000)
      return offset !== null && body ? { kind: value.kind, offset, text: body } : null
    }
    case 'docs.replace-text': {
      const search = text(value.search, 4_000)
      const replacement = typeof value.replacement === 'string' ? value.replacement.slice(0, 20_000) : null
      return search && replacement !== null ? { kind: value.kind, search, replacement } : null
    }
    case 'docs.insert-table': {
      const rows = integer(value.rows, 1, 100)
      const columns = integer(value.columns, 1, 30)
      const values = value.values === undefined ? undefined : stringMatrix(value.values)
      if (rows === null || columns === null || (value.values !== undefined && !values)) return null
      return { kind: value.kind, rows, columns, ...(values ? { values } : {}) }
    }
    case 'slides.add-slide': {
      const name = text(value.name, 120)
      return { kind: value.kind, ...(name ? { name } : {}) }
    }
    case 'slides.set-title': {
      const slideIndex = integer(value.slideIndex)
      const body = text(value.text, 4_000)
      return slideIndex !== null && body ? { kind: value.kind, slideIndex, text: body } : null
    }
    case 'slides.add-text': {
      const slideIndex = integer(value.slideIndex)
      const body = text(value.text, 20_000)
      if (slideIndex === null || !body) return null
      const left = finite(value.left), top = finite(value.top)
      const width = finite(value.width, 1), height = finite(value.height, 1)
      const fontSize = finite(value.fontSize, 1, 400)
      return {
        kind: value.kind,
        slideIndex,
        text: body,
        ...(left !== null ? { left } : {}),
        ...(top !== null ? { top } : {}),
        ...(width !== null ? { width } : {}),
        ...(height !== null ? { height } : {}),
        ...(fontSize !== null ? { fontSize } : {}),
      }
    }
    case 'slides.add-shape': {
      const slideIndex = integer(value.slideIndex)
      const shape = value.shape
      if (slideIndex === null || !['rect', 'ellipse', 'roundRect', 'diamond'].includes(String(shape))) return null
      const body = text(value.text, 2_000)
      const left = finite(value.left), top = finite(value.top)
      const width = finite(value.width, 1), height = finite(value.height, 1)
      return {
        kind: value.kind,
        slideIndex,
        shape: shape as 'rect' | 'ellipse' | 'roundRect' | 'diamond',
        ...(body ? { text: body } : {}),
        ...(left !== null ? { left } : {}),
        ...(top !== null ? { top } : {}),
        ...(width !== null ? { width } : {}),
        ...(height !== null ? { height } : {}),
      }
    }
    case 'bases.add-table': {
      const name = text(value.name, 120)
      const primaryField = text(value.primaryField, 120)
      return name ? { kind: value.kind, name, ...(primaryField ? { primaryField } : {}) } : null
    }
    case 'bases.add-field': {
      const table = text(value.table, 200)
      const name = text(value.name, 120)
      const fieldType = text(value.fieldType, 60)
      return table && name && fieldType ? { kind: value.kind, table, name, fieldType } : null
    }
    case 'bases.add-record': {
      const table = text(value.table, 200)
      const values = recordValue(value.values)
      return table && values ? { kind: value.kind, table, values } : null
    }
    case 'bases.set-record': {
      const table = text(value.table, 200)
      const recordId = text(value.recordId, 200)
      const field = text(value.field, 120)
      const parsed = cellValue(value.value)
      return table && recordId && field && parsed !== undefined
        ? { kind: value.kind, table, recordId, field, value: parsed }
        : null
    }
    case 'boards.add-sticky': {
      const body = text(value.text, 4_000)
      const left = finite(value.left), top = finite(value.top)
      if (!body || left === null || top === null) return null
      const width = finite(value.width, 1), height = finite(value.height, 1)
      return { kind: value.kind, text: body, left, top, ...(width !== null ? { width } : {}), ...(height !== null ? { height } : {}) }
    }
    case 'boards.add-shapes': {
      if (!Array.isArray(value.shapes) || !value.shapes.length || value.shapes.length > 100) return null
      const shapes: Array<{ shapeType: string; left: number; top: number; width?: number; height?: number; text?: string }> = []
      for (const shape of value.shapes) {
        if (!isRecord(shape)) return null
        const shapeType = text(shape.shapeType, 60)
        const left = finite(shape.left), top = finite(shape.top)
        if (!shapeType || left === null || top === null) return null
        const width = finite(shape.width, 1), height = finite(shape.height, 1)
        const body = text(shape.text, 2_000)
        shapes.push({
          shapeType,
          left,
          top,
          ...(width !== null ? { width } : {}),
          ...(height !== null ? { height } : {}),
          ...(body ? { text: body } : {}),
        })
      }
      return { kind: value.kind, shapes }
    }
    case 'boards.add-connector': {
      const from = isRecord(value.from) ? { x: finite(value.from.x), y: finite(value.from.y) } : null
      const to = isRecord(value.to) ? { x: finite(value.to.x), y: finite(value.to.y) } : null
      if (!from || !to || from.x === null || from.y === null || to.x === null || to.y === null) return null
      const label = text(value.label, 500)
      return { kind: value.kind, from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y }, ...(label ? { label } : {}) }
    }
    case 'pdfs.add-text': {
      const pageIndex = integer(value.pageIndex)
      const body = text(value.text, 20_000)
      if (pageIndex === null || !body) return null
      const x = finite(value.x), y = finite(value.y)
      const width = finite(value.width, 1), height = finite(value.height, 1)
      const fontSize = finite(value.fontSize, 1, 400)
      return {
        kind: value.kind,
        pageIndex,
        text: body,
        ...(x !== null ? { x } : {}),
        ...(y !== null ? { y } : {}),
        ...(width !== null ? { width } : {}),
        ...(height !== null ? { height } : {}),
        ...(fontSize !== null ? { fontSize } : {}),
      }
    }
    case 'pdfs.add-table': {
      const pageIndex = integer(value.pageIndex)
      const rows = integer(value.rows, 1, 100)
      const columns = integer(value.columns, 1, 30)
      const values = value.values === undefined ? undefined : stringMatrix(value.values)
      if (pageIndex === null || rows === null || columns === null || (value.values !== undefined && !values)) return null
      return { kind: value.kind, pageIndex, rows, columns, ...(values ? { values } : {}) }
    }
    case 'pdfs.add-page': {
      const index = value.index === undefined ? undefined : integer(value.index)
      return { kind: value.kind, ...(index !== null && index !== undefined ? { index } : {}) }
    }
    default:
      return null
  }
}

function prefixOf(op: OfficeAiOp): string {
  return op.kind.split('.')[0]!
}

export function validateOfficeEditPlan(value: unknown, expected?: { type?: OfficeFileType; fileId?: string }): OfficePlanValidation {
  if (!isRecord(value)) return { ok: false, error: 'The edit plan must be an object.' }
  if (!isOfficeFileType(value.type)) return { ok: false, error: 'The edit plan has no valid file type.' }
  if (expected?.type && value.type !== expected.type) return { ok: false, error: 'The edit plan targets another product.' }
  if (typeof value.fileId !== 'string' || !OFFICE_ID_RE.test(value.fileId)) {
    return { ok: false, error: 'The edit plan has no valid file id.' }
  }
  if (expected?.fileId && value.fileId !== expected.fileId) return { ok: false, error: 'The edit plan targets another file.' }
  const summary = text(value.summary, MAX_SUMMARY)
  if (!summary) return { ok: false, error: 'The edit plan needs a short summary.' }
  if (!Array.isArray(value.ops) || !value.ops.length || value.ops.length > MAX_OPS) {
    return { ok: false, error: `An edit plan needs 1-${MAX_OPS} operations.` }
  }
  const ops: OfficeAiOp[] = []
  for (const raw of value.ops) {
    const op = opOf(raw)
    if (!op) return { ok: false, error: 'An edit plan operation is malformed.' }
    if (prefixOf(op) !== value.type) return { ok: false, error: 'An edit plan mixes operations from another product.' }
    ops.push(op)
  }
  const plan: OfficeEditPlan = { type: value.type, fileId: value.fileId, summary, ops }
  if (JSON.stringify(plan).length > OFFICE_LIMITS.aiPlanBytes) return { ok: false, error: 'The edit plan is too large.' }
  return { ok: true, plan }
}

export function isOfficeClientEffect(value: unknown): value is OfficeClientEffect {
  if (!isRecord(value)) return false
  if (value.kind === 'office.open') {
    return typeof value.fileId === 'string' && OFFICE_ID_RE.test(value.fileId) && isOfficeFileType(value.fileType)
  }
  if (value.kind === 'office.refresh') {
    return value.fileId === undefined || (typeof value.fileId === 'string' && OFFICE_ID_RE.test(value.fileId))
  }
  if (value.kind === 'office.apply-plan') {
    if (typeof value.fileId !== 'string' || !OFFICE_ID_RE.test(value.fileId) || !isOfficeFileType(value.fileType)) return false
    return validateOfficeEditPlan(value.plan, { type: value.fileType, fileId: value.fileId }).ok
  }
  return false
}

export function clipOfficeClientEffect(effect: OfficeClientEffect): OfficeClientEffect {
  if (effect.kind !== 'office.apply-plan') return effect
  return { ...effect, plan: { ...effect.plan, summary: effect.plan.summary.slice(0, MAX_SUMMARY), ops: effect.plan.ops.slice(0, MAX_OPS) } }
}

function collectText(value: unknown, out: string[], depth: number): void {
  if (depth > 24 || out.join('').length >= OFFICE_LIMITS.aiReadChars) return
  if (typeof value === 'string') {
    const textValue = value.trim()
    if (textValue && !textValue.startsWith('data:image/')) out.push(textValue)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, out, depth + 1)
    return
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) collectText(item, out, depth + 1)
  }
}

/** A bounded plain-text view of a snapshot for the assistant. It never returns binary assets. */
export function extractOfficeText(type: OfficeFileType, snapshot: OfficeSnapshot, maxChars = OFFICE_LIMITS.aiReadChars): { text: string; truncated: boolean } {
  const parts: string[] = []
  if (type === 'sheets') {
    const sheets = isRecord(snapshot.sheets) ? snapshot.sheets : {}
    for (const [sheetId, sheet] of Object.entries(sheets)) {
      if (!isRecord(sheet)) continue
      parts.push(`[sheet ${sheetId}]`)
      collectText(sheet.cellData ?? sheet, parts, 0)
    }
  } else if (type === 'docs') {
    const body = isRecord(snapshot.body) ? snapshot.body : {}
    if (typeof body.dataStream === 'string') parts.push(body.dataStream)
    else collectText(snapshot.body ?? snapshot, parts, 0)
  } else {
    collectText(snapshot, parts, 0)
  }
  const joined = parts.join('\n').replace(/\n{3,}/g, '\n\n')
  const truncated = joined.length > maxChars
  return { text: truncated ? joined.slice(0, maxChars) : joined, truncated }
}