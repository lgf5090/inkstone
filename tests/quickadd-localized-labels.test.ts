// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { EN_US_MESSAGES } from '../src/shared/locales/en-US'
import { ZH_CN_MESSAGES } from '../src/shared/locales/zh-CN'

const ENGINE_DIR = 'src/client/lib/quickadd'

function engineSources(): string[] {
  return readdirSync(ENGINE_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => `${ENGINE_DIR}/${name}`)
}

it('never hands the prompt dialog a label the engine wrote itself', () => {
  const offenders: string[] = []
  for (const path of engineSources()) {
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(/\blabel:\s*'([^']+)'/g)) {
      offenders.push(`${path}: label: '${match[1]}'`)
    }
  }
  expect(offenders, `a prompt label must come from the locale files: ${offenders.join(' | ')}`).toEqual([])
})

it('asks for a math expression in every shipped language', () => {
  expect(EN_US_MESSAGES['quickadd.prompt_math']).toBe('Math expression')
  expect(ZH_CN_MESSAGES['quickadd.prompt_math']).toMatch(/[\u4e00-\u9fff]/)
})

it('builds the math prompt from one label on both the discovery and the run path', () => {
  const format = readFileSync(`${ENGINE_DIR}/format.ts`, 'utf8')
  expect(format.match(/label: t\('quickadd\.prompt_math'\)/g) ?? []).toHaveLength(2)
})
