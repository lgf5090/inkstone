// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { OFFICE_AI_OP_KINDS, OFFICE_AI_OP_SPEC, validateOfficeEditPlan } from '../src/shared/office/ai'

/**
 * The edit-plan vocabulary the assistant tool publishes.
 *
 * A model can only answer with an op this app accepts if the tool description spells the op out. These
 * tests keep that description honest: every kind the validator understands appears in it, and the
 * validator still refuses the cases a model is most likely to produce by accident.
 */

const FILE_ID = '01m7zbhpq544r0tw3dzjnhmsex'

const EXPECTED_KINDS = [
  'sheets.set-values', 'sheets.set-formula', 'sheets.set-number-format', 'sheets.set-style',
  'sheets.insert-rows', 'sheets.delete-rows', 'sheets.add-sheet', 'sheets.rename-sheet',
  'docs.append-paragraph', 'docs.insert-text', 'docs.replace-text', 'docs.insert-table',
  'slides.add-slide', 'slides.set-title', 'slides.add-text', 'slides.add-shape',
  'bases.add-table', 'bases.add-field', 'bases.add-record', 'bases.set-record',
  'boards.add-sticky', 'boards.add-shapes', 'boards.add-connector',
  'pdfs.add-text', 'pdfs.add-table', 'pdfs.add-page',
]

describe('the published op vocabulary', () => {
  it('lists every kind the validator understands, once each', () => {
    expect([...OFFICE_AI_OP_KINDS].sort()).toEqual([...EXPECTED_KINDS].sort())
    expect(new Set(OFFICE_AI_OP_KINDS).size).toBe(OFFICE_AI_OP_KINDS.length)
  })

  it('describes each kind with its fields, not just its name', () => {
    for (const kind of EXPECTED_KINDS) {
      const line = OFFICE_AI_OP_SPEC.split('\n').find((entry) => entry.startsWith(`${kind}{`))
      expect(line, `${kind} is missing from the spec`).toBeTruthy()
      expect(line).toContain('}')
    }
  })
})

describe('plan validation the model runs into', () => {
  it('accepts a sheet write and keeps the op', () => {
    const result = validateOfficeEditPlan({
      type: 'sheets',
      fileId: FILE_ID,
      summary: 'Write the total',
      ops: [{ kind: 'sheets.set-values', range: 'B2', values: [[99]] }],
    }, { type: 'sheets', fileId: FILE_ID })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.plan.ops[0]).toEqual({ kind: 'sheets.set-values', range: 'B2', values: [[99]] })
    }
  })

  it('refuses a plan whose ops come from another product', () => {
    const result = validateOfficeEditPlan({
      type: 'sheets',
      fileId: FILE_ID,
      summary: 'Mixed',
      ops: [{ kind: 'docs.append-paragraph', text: 'hello' }],
    })
    expect(result).toMatchObject({ ok: false, error: 'An edit plan mixes operations from another product.' })
  })

  it('refuses a malformed op instead of dropping it silently', () => {
    const result = validateOfficeEditPlan({
      type: 'sheets',
      fileId: FILE_ID,
      summary: 'No range',
      ops: [{ kind: 'sheets.set-values', values: [[1]] }],
    })
    expect(result).toMatchObject({ ok: false, error: 'An edit plan operation is malformed.' })
  })

  it('refuses an empty plan', () => {
    const result = validateOfficeEditPlan({ type: 'sheets', fileId: FILE_ID, summary: 'Nothing', ops: [] })
    expect(result.ok).toBe(false)
  })
})
