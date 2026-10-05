import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOTS = ['src/client', 'src/shared', 'index.html']
const EXTENSIONS = ['.ts', '.tsx', '.css', '.html']
const PREFIX = 'backdrop'
const PATTERN = new RegExp([PREFIX, '-filter|', PREFIX, 'Filter|', PREFIX, '-blur'].join(''))

function collect(): string[] {
  const files: string[] = []
  for (const root of ROOTS) {
    const absolute = path.resolve(root)
    const info = statSync(absolute, { throwIfNoEntry: false })
    if (!info) continue
    if (info.isFile()) {
      files.push(absolute)
      continue
    }
    const stack = [absolute]
    while (stack.length) {
      const directory = stack.pop()!
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name)
        if (entry.isDirectory()) stack.push(full)
        else if (EXTENSIONS.includes(path.extname(full))) files.push(full)
      }
    }
  }
  return files
}

function offendersIn(file: string, text: string): string[] {
  return text.split('\n')
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => PATTERN.test(line))
    .map(({ line, index }) => `${file}:${index + 1}: ${line.trim().slice(0, 90)}`)
}

const files = collect()
const found = files.flatMap((file) => offendersIn(path.relative(process.cwd(), file), readFileSync(file, 'utf8')))

describe('backdrop blur budget', () => {
  it('detects the two spellings it forbids', () => {
    const jsx = `  <div className="bg-[var(--scrim)] ${PREFIX}-blur-[3px]"/>`
    const css = `  ${PREFIX}-filter: blur(3px);`
    expect(offendersIn('sample.tsx', jsx)).toHaveLength(1)
    expect(offendersIn('sample.css', css)).toHaveLength(1)
    expect(offendersIn('sample.tsx', '  const calm = 1')).toEqual([])
  })

  it('scans a meaningful slice of the client source', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files.some((file) => file.endsWith('CommandPalette.tsx'))).toBe(true)
    expect(files.some((file) => file.endsWith('overlay.tsx'))).toBe(true)
  })

  it('keeps the forbidden property out of the app: cost scales with blurred area, not radius', () => {
    expect(found).toEqual([])
  })
})
