import { describe, expect, it } from 'vitest'
import { evaluateProjectFormula, evaluateProjectFormulaResult, projectFormulaDependencyOrder, projectFormulaReferenceValue } from './formula'
import type { ProjectCard, ProjectProperty } from './model'

const values = new Map<string, string>([
  ['price', '10'],
  ['qty', '3'],
  ['name', 'Tea'],
])

describe('the formula language', () => {
  it('resolves references by name and keeps arithmetic precedence', () => {
    expect(evaluateProjectFormula('{Price} * {Qty}', values)).toBe('30')
    expect(evaluateProjectFormula('({Price}+2)*2', values)).toBe('24')
    expect(evaluateProjectFormula('{Price}/4', values)).toBe('2.5')
  })

  it('offers the documented functions', () => {
    expect(evaluateProjectFormula('IF({Qty} > 2, "bulk", "single")', values)).toBe('bulk')
    expect(evaluateProjectFormula('ROUND({Price}/3, 2)', values)).toBe('3.33')
    expect(evaluateProjectFormula('SUM({Price}, {Qty})', values)).toBe('13')
    expect(evaluateProjectFormula('MAX({Price}, {Qty})', values)).toBe('10')
    expect(evaluateProjectFormula('CONCAT({Name}, "!")', values)).toBe('Tea!')
    expect(evaluateProjectFormula('LEN({Name})', values)).toBe('3')
    expect(evaluateProjectFormula('DAYS(0, 86400000)', values)).toBe('1')
  })

  it('reports unknown references and parse failures instead of silently blanking', () => {
    expect(evaluateProjectFormulaResult('{Missing} + 1', values)).toEqual({ value: '', error: 'unknown reference Missing' })
    expect(evaluateProjectFormulaResult('{Price} *', values).error).toBe('unexpected end')
    expect(evaluateProjectFormulaResult('{Price}/0', values).error).toBe('division by zero')
    expect(evaluateProjectFormula('', values)).toBe('')
  })

  it('refuses anything outside the grammar', () => {
    expect(evaluateProjectFormula('1; alert(1)', values)).toBe('')
    expect(evaluateProjectFormula('this.price', values)).toBe('')
    expect(evaluateProjectFormula('{Price} *', values)).toBe('')
    expect(evaluateProjectFormula('EVAL("1+1")', values)).toBe('')
  })

  it('orders formula dependencies and reports cycles', () => {
    const properties: ProjectProperty[] = [
      { id: 'f1', name: 'Final', type: 'formula', options: [], config: { expression: '{Base} * 2' } },
      { id: 'f2', name: 'Base', type: 'formula', options: [], config: { expression: '{Price} + 1' } },
    ]
    expect(projectFormulaDependencyOrder(properties).order).toEqual(['f2', 'f1'])
    properties[0]!.config!.expression = '{Cycle}'
    properties.push({ id: 'f3', name: 'Cycle', type: 'formula', options: [], config: { expression: '{Final}' } })
    expect(projectFormulaDependencyOrder(properties).cycles).toEqual(new Set(['f1', 'f3']))
  })

  it('uses option labels and date timestamps as formula inputs', () => {
    const card: ProjectCard = {
      id: 'c1', boardId: 'b1', parentId: '', title: '', icon: '', isTemplate: false, contentOrder: [], deleteAt: 0,
      values: { status: 's1', due: JSON.stringify({ from: 1000 }) }, createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1,
    }
    const status: ProjectProperty = { id: 'status', name: 'Status', type: 'select', options: [{ id: 's1', value: 'Ready', color: '' }] }
    const due: ProjectProperty = { id: 'due', name: 'Due', type: 'date', options: [] }
    expect(projectFormulaReferenceValue(card, status)).toBe('Ready')
    expect(projectFormulaReferenceValue(card, due)).toBe('1000')
  })
})
