// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const OFFICE = path.join('src', 'client', 'features', 'office')
const SHELL = [
  'OfficeApp.tsx',
  'OfficeSidebar.tsx',
  'OfficeFileList.tsx',
  'OfficeEditorTabs.tsx',
  'OfficeEditorHost.tsx',
  'OfficeVersions.tsx',
  'office-menus.tsx',
  'api.ts',
  'office-prefs.ts',
  'office-address.ts',
]

function read(file: string): string {
  return readFileSync(path.join(OFFICE, file), 'utf8')
}

describe('office lazy boundaries', () => {
  it('loads the office shell only when the rail opens it', () => {
    const host = readFileSync(path.join('src', 'client', 'features', 'shell', 'AppTabHost.tsx'), 'utf8')
    expect(host).toContain("office: lazy(() => import('../office/OfficeApp')")
  })

  it('keeps every shell module free of a Univer or concrete editor import', () => {
    for (const file of SHELL) {
      const source = read(file)
      expect(source, `${file} imports Univer`).not.toMatch(/from ['"]@univerjs/)
      expect(source, `${file} imports a concrete editor`).not.toMatch(/from ['"]\.\/editor\/(sheets|docs|slides|bases|boards|pdfs)/)
    }
  })

  it('maps each product to its own dynamic import in the registry', () => {
    const registry = read(path.join('editor', 'registry.tsx'))
    for (const product of ['sheets', 'docs', 'slides', 'bases', 'boards', 'pdfs']) {
      expect(registry).toContain(`import('./${product}')`)
    }
  })

  it('keeps the editor host on the registry seam', () => {
    const host = read('OfficeEditorHost.tsx')
    expect(host).toContain("from './editor/registry'")
    expect(host).not.toMatch(/from ['"]\.\/editor\/(sheets|docs|slides|bases|boards|pdfs)/)
  })

  it('leaves each product module free of the other products', () => {
    const files = readdirSync(path.join(OFFICE, 'editor')).filter((file) => /\.tsx?$/.test(file))
    for (const file of files) {
      const source = read(path.join('editor', file))
      for (const other of ['sheets', 'docs', 'slides', 'bases', 'boards', 'pdfs']) {
        if (file.startsWith(other) || file.includes(`-${other}`)) continue
        expect(source, `${file} imports ${other}`).not.toContain(`from './${other}'`)
      }
    }
  })
})