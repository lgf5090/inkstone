import { describe, expect, it } from 'vitest'
import {
  detectScriptImportSource,
  importTitleDecision,
  parseScriptImport,
} from '../src/shared/scriptshub/import'

describe('snippet import parsing', () => {
  it('reads a masscode export with several files and tags', () => {
    const entries = parseScriptImport('masscode', [{
      name: 'Flatpak setup',
      description: 'Installs flatpak',
      tags: ['linux', { name: 'system' }],
      content: [
        { language: 'shell', value: '#!/bin/sh\nflatpak --version' },
        { language: 'python', value: 'print("ok")' },
      ],
    }])
    expect(entries).toHaveLength(1)
    expect(entries[0]!.title).toBe('Flatpak setup')
    expect(entries[0]!.tags).toEqual(['linux', 'system'])
    expect(entries[0]!.files.map((file) => file.language)).toEqual(['shell', 'python'])
  })

  it('reads a VS Code object keyed by title', () => {
    const entries = parseScriptImport('vscode', {
      'Deploy': {
        scope: 'shell',
        body: ['echo deploying', 'make deploy'],
        description: 'Deploy the app',
      },
    })
    expect(entries).toHaveLength(1)
    expect(entries[0]!.title).toBe('Deploy')
    expect(entries[0]!.files[0]!.content).toBe('echo deploying\nmake deploy')
    expect(entries[0]!.files[0]!.language).toBe('shell')
  })

  it('reads the generic export this app writes', () => {
    const entries = parseScriptImport('generic', {
      snippets: [{ title: 'Backup', description: 'Nightly', files: [{ name: 'backup.sh', content: 'tar -czf x' }], tags: ['ops'] }],
    })
    expect(entries[0]!.files[0]!.name).toBe('backup.sh')
  })

  it('ignores entries with no title or no readable file', () => {
    const entries = parseScriptImport('generic', [
      { title: '', files: [{ name: 'x.sh', content: 'echo x' }] },
      { title: 'Empty', files: [{ name: 'x.sh', content: '   ' }] },
      { title: 'Good', files: [{ name: 'x.sh', content: 'echo x' }] },
    ])
    expect(entries.map((entry) => entry.title)).toEqual(['Good'])
  })

  it('detects the three formats from their shape', () => {
    expect(detectScriptImportSource([{ name: 'a', content: [] }])).toBe('masscode')
    expect(detectScriptImportSource({ snippets: [] })).toBe('masscode')
    expect(detectScriptImportSource({ A: { body: ['x'] } })).toBe('vscode')
    expect(detectScriptImportSource({ snippets: [{ title: 'a', files: [] }] })).toBe('generic')
    expect(detectScriptImportSource([{ title: 'a', files: [] }])).toBe('generic')
  })
})

describe('import conflict decisions', () => {
  it('keeps a new title, skips, overwrites or renames an existing one', () => {
    expect(importTitleDecision('A', 'skip', false)).toEqual({ action: 'keep', title: 'A' })
    expect(importTitleDecision('A', 'skip', true)).toEqual({ action: 'skip' })
    expect(importTitleDecision('A', 'overwrite', true)).toEqual({ action: 'overwrite', title: 'A' })
    expect(importTitleDecision('A', 'rename', true)).toEqual({ action: 'rename', title: 'A' })
  })
})
