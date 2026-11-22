// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  isOfficeAssetId,
  isOfficeAssetMime,
  isOfficeFileType,
  normalizeOfficeTitle,
  officeAssetExtension,
  officeFileKey,
  officeImageKey,
  officeSnapshotKey,
} from '../src/shared/office/constants'
import {
  validateOfficeEditPlan,
  isOfficeClientEffect,
  extractOfficeText,
} from '../src/shared/office/ai'
import {
  detectOfficeSnapshotType,
  findInlineOfficeImages,
  replaceInlineOfficeImages,
  sha256Hex,
} from '../src/shared/office/snapshot'

const FILE_ID = '0123456789abcdefghjkmnpqrs'
const PNG = 'data:image/png;base64,iVBORw0KGgo='

describe('office shared contracts', () => {
  it('builds only the office-prefixed storage keys', () => {
    expect(officeSnapshotKey('u1', FILE_ID, 3)).toBe(`office/txt/u1/${FILE_ID}/3.json`)
    expect(officeImageKey('u1', 'a'.repeat(64), 'png')).toBe(`office/images/u1/${'a'.repeat(64)}.png`)
    expect(officeFileKey('u1', 'b'.repeat(64), 'pdf')).toBe(`office/files/u1/${'b'.repeat(64)}.pdf`)
  })

  it('recognizes only the six file types and the allowed asset mimes', () => {
    expect(isOfficeFileType('sheets')).toBe(true)
    expect(isOfficeFileType('sheet')).toBe(false)
    expect(isOfficeAssetMime('image/png')).toBe(true)
    expect(isOfficeAssetMime('image/svg+xml')).toBe(false)
    expect(officeAssetExtension('application/pdf')).toBe('pdf')
    expect(officeAssetExtension('text/html')).toBeNull()
    expect(isOfficeAssetId('a'.repeat(64))).toBe(true)
    expect(isOfficeAssetId('A'.repeat(64))).toBe(false)
  })

  it('normalizes a title and refuses control characters', () => {
    expect(normalizeOfficeTitle('  Q4   plan  ')).toBe('Q4 plan')
    expect(normalizeOfficeTitle('   ')).toBeNull()
    expect(normalizeOfficeTitle('bad\u0000name')).toBeNull()
  })

  it('hashes the same text deterministically', async () => {
    expect(await sha256Hex('hello')).toHaveLength(64)
    expect(await sha256Hex('hello')).toBe(await sha256Hex('hello'))
  })

  it('detects the six snapshot shapes where they are distinguishable', () => {
    expect(detectOfficeSnapshotType({ sheetOrder: [], sheets: {}, styles: {} })).toBe('sheets')
    expect(detectOfficeSnapshotType({ body: {} })).toBe('docs')
    expect(detectOfficeSnapshotType({ pages: [], pageSize: {} })).toBe('slides')
    expect(detectOfficeSnapshotType({ tables: {}, tableOrder: [] })).toBe('bases')
    expect(detectOfficeSnapshotType({ pages: {}, pageOrder: [] })).toBe('boards')
    expect(detectOfficeSnapshotType({ pages: [] })).toBe('pdfs')
  })

  it('finds and replaces inline images without mutating the snapshot', () => {
    const snapshot = { a: PNG, b: [{ c: `x${PNG}` }], d: 'plain' }
    const found = findInlineOfficeImages(snapshot)
    expect(found).toHaveLength(1)
    expect(found[0]!.mime).toBe('image/png')
    const out = replaceInlineOfficeImages(snapshot, new Map([[PNG, '/api/office/assets/x']]))
    expect(out).toEqual({ a: '/api/office/assets/x', b: [{ c: `x${PNG}` }], d: 'plain' })
    expect(snapshot.a).toBe(PNG)
  })

  it('validates a product-matched edit plan and refuses mixed products', () => {
    const plan = {
      type: 'sheets',
      fileId: FILE_ID,
      summary: 'Fill a header',
      ops: [{ kind: 'sheets.set-values', range: 'A1:B1', values: [['Name', 'Amount']] }],
    }
    const ok = validateOfficeEditPlan(plan)
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.plan.ops).toHaveLength(1)

    expect(validateOfficeEditPlan({ ...plan, ops: [{ kind: 'docs.append-paragraph', text: 'x' }] }).ok).toBe(false)
    expect(validateOfficeEditPlan({ ...plan, fileId: 'short' }).ok).toBe(false)
    expect(validateOfficeEditPlan({ ...plan, ops: [] }).ok).toBe(false)
  })

  it('validates client effects and rejects a plan for another file', () => {
    const plan = {
      type: 'docs',
      fileId: FILE_ID,
      summary: 'Add a paragraph',
      ops: [{ kind: 'docs.append-paragraph', text: 'Hello' }],
    }
    expect(isOfficeClientEffect({ kind: 'office.open', fileId: FILE_ID, fileType: 'docs' })).toBe(true)
    expect(isOfficeClientEffect({ kind: 'office.refresh' })).toBe(true)
    expect(isOfficeClientEffect({ kind: 'office.apply-plan', fileId: FILE_ID, fileType: 'docs', plan })).toBe(true)
    expect(isOfficeClientEffect({
      kind: 'office.apply-plan',
      fileId: '0123456789abcdefghjkmnpqrt',
      fileType: 'docs',
      plan,
    })).toBe(false)
  })

  it('extracts bounded text and never returns inline image payloads', () => {
    const sheets = {
      sheets: { s1: { cellData: { 0: { 0: { v: 'hello' }, 1: { v: PNG } } } } },
    }
    const out = extractOfficeText('sheets', sheets, 200)
    expect(out.text).toContain('hello')
    expect(out.text).not.toContain('data:image')
    const small = extractOfficeText('sheets', sheets, 3)
    expect(small.truncated).toBe(true)
    expect(small.text).toHaveLength(3)
  })
})