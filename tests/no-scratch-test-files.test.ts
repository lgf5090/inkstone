// @vitest-environment node
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { isScratchPath, walkSource } from '../scripts/lib/scratch-files.mjs'
import appConfig from '../vitest.config'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const MARKER = '.tmp.'
const PATTERN = '**/*.tmp.*'
const TS_PROJECTS = ['tsconfig.client.json', 'tsconfig.worker.json']
const SCAN_ROOTS = ['src', 'tests', 'scripts', 'public']
const TREE_WALKING_GATES = ['scripts/check-i18n.mjs', 'scripts/check-comments.mjs']

const isScratch = (file: string) => path.basename(file).includes(MARKER)
const relative = (file: string) => path.relative(ROOT, file).split(path.sep).join('/')

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) yield* walk(target)
    else yield target
  }
}

function scratchFiles(): string[] {
  return SCAN_ROOTS
    .flatMap((root) => [...walk(path.join(ROOT, root))])
    .filter(isScratch)
    .map(relative)
    .sort()
}

function compilerProject(name: string): { include?: string[], exclude?: string[] } {
  const text = readFileSync(path.join(ROOT, name), 'utf8')
  return (ts.parseConfigFileTextToJson(name, text).config ?? {}) as { include?: string[], exclude?: string[] }
}

function projectExclude(name: string): string[] {
  const projects = appConfig.test?.projects ?? []
  const project = projects.find((candidate) => (candidate as { test?: { name?: string } }).test?.name === name)
  return ((project as { test?: { exclude?: string[] } }).test?.exclude ?? [])
}

describe('scratch probes stay out of the gates', () => {
  it('leaves no scratch file inside the scanned source roots', () => {
    expect(scratchFiles(), 'a measurement in flight belongs under docs/**/probes/, not here').toEqual([])
  })

  it('names the marker the compiler itself rejects', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'inkstone-scratch-'))
    try {
      writeFileSync(path.join(dir, 'kept.test.ts'), '')
      writeFileSync(path.join(dir, 'a.tmp.test.ts'), '')
      writeFileSync(path.join(dir, 'b.tmp.ts'), '')
      const parsed = ts.parseJsonConfigFileContent({ include: ['**/*.ts'], exclude: [PATTERN] }, ts.sys, dir)
      expect(parsed.fileNames.map((file) => path.basename(file))).toEqual(['kept.test.ts'])
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('carries the exclusion in every tsconfig project that globs the source tree', () => {
    for (const name of TS_PROJECTS) {
      const config = compilerProject(name)
      expect(config.exclude ?? [], name).toContain(PATTERN)
      expect(ts.parseJsonConfigFileContent(config, ts.sys, ROOT).fileNames.filter(isScratch), name).toEqual([])
    }
  })

  it('carries the exclusion in the vitest project that collects the source tree', () => {
    expect(projectExclude('jsdom'), 'jsdom').toContain(PATTERN)
  })

  it('hides the marker from the gates that walk the tree as text', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'inkstone-scratch-walk-'))
    try {
      mkdirSync(path.join(dir, 'nested'))
      writeFileSync(path.join(dir, 'kept.ts'), '')
      writeFileSync(path.join(dir, 'probe.tmp.ts'), '')
      writeFileSync(path.join(dir, 'nested', 'kept.mjs'), '')
      writeFileSync(path.join(dir, 'nested', 'probe.tmp.mjs'), '')
      expect([...walkSource(dir)].map((file) => path.relative(dir, file).split(path.sep).join('/')).sort(), 'walked files').toEqual(['kept.ts', 'nested/kept.mjs'])
      expect(isScratchPath(`scripts/probe${MARKER}ts`), 'marker').toBe(true)
      expect(isScratchPath('scripts/probe.ts'), 'ordinary file').toBe(false)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves the text gates no private copy of the tree walk', () => {
    for (const name of TREE_WALKING_GATES) {
      const source = readFileSync(path.join(ROOT, name), 'utf8')
      expect(source, name).toContain('walkSource(')
      expect(source, name).not.toMatch(/function\* walk\(/)
    }
  })
})
