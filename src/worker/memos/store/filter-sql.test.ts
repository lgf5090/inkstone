import { describe, expect, it } from 'vitest'
import { prepareMemoFilter } from '@shared/memos/filter'
import { planMemoFilterSql, type MemoFilterSqlPlan } from './filter-sql'

function plan(expression: string): MemoFilterSqlPlan {
  const prepared = prepareMemoFilter(expression)
  if (!prepared.ok) throw new Error(`filter did not parse: ${prepared.error.message}`)
  return planMemoFilterSql(prepared.ast, 'user-1', 1_000)
}

describe('the memo filter SQL planner', () => {
  it('answers a sidebar tag chip from the tag index', () => {
    const result = plan('"work" in tags')
    expect(result.complete?.sql).toContain('FROM memos_tags t')
    expect(result.complete?.sql).toContain('t.tag = ?')
    expect(result.complete?.params).toEqual(['work'])
  })

  it('answers a tag list from the tag index', () => {
    const result = plan('tag in ["work", "home"]')
    expect(result.complete?.sql).toContain('t.tag IN (?, ?)')
    expect(result.complete?.params).toEqual(['work', 'home'])
  })

  it('leaves the search text to the SQL string functions', () => {
    const result = plan('content.contains("coffee") && "work" in tags')
    expect(result.complete?.sql).toContain('instr(i.content_search, ?)')
    expect(result.complete?.sql).toContain('memos_tags')
    expect(result.complete?.params).toEqual(['coffee', 'work'])
  })
})
