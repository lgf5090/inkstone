import { describe, expect, it } from 'vitest'
import {
  BACKUP_TEMPLATES_NAME,
  backupTemplatesPath,
  MARKDOWN_BACKUP_FORMAT,
  parseMarkdownBackupManifest,
  type MarkdownBackupManifest,
} from '../src/shared/backup-format'

const STAMP = '20261007-120000-000'

function manifest(overrides: Record<string, unknown> = {}): MarkdownBackupManifest {
  return {
    format: MARKDOWN_BACKUP_FORMAT,
    version: 3,
    appVersion: '0.8.0',
    createdAt: '2026-10-07T12:00:00.000Z',
    snapshot: STAMP,
    notes: [],
    attachments: [],
    ...overrides,
  } as MarkdownBackupManifest
}

function withTemplates(section: Record<string, unknown> | undefined) {
  return manifest(section === undefined ? {} : { templates: section })
}

describe('the templates section of a backup manifest', () => {
  it('is absent for a backup that never carried one', () => {
    expect(parseMarkdownBackupManifest(manifest())?.templates).toBeUndefined()
  })

  it('keeps the section when it points at the canonical file', () => {
    const parsed = parseMarkdownBackupManifest(withTemplates({
      path: BACKUP_TEMPLATES_NAME,
      bytes: 512,
      sha256: 'a'.repeat(64),
    }))
    expect(parsed?.templates).toEqual({ path: 'templates.json', bytes: 512, sha256: 'a'.repeat(64) })
    expect(backupTemplatesPath(STAMP, 3)).toBe('templates.json')
    expect(backupTemplatesPath(STAMP, 2)).toBe(`snapshots/${STAMP}/${BACKUP_TEMPLATES_NAME}`)
  })

  it('rejects the whole manifest when the section cannot be trusted', () => {
    const badHash = withTemplates({ path: BACKUP_TEMPLATES_NAME, bytes: 10, sha256: 'nope' })
    expect(parseMarkdownBackupManifest(badHash)).toBe(null)
    const wrongPath = withTemplates({ path: '../templates.json', bytes: 10, sha256: 'b'.repeat(64) })
    expect(parseMarkdownBackupManifest(wrongPath)).toBe(null)
    const smuggled = withTemplates({ path: 'notes/templates.json', bytes: 10, sha256: 'b'.repeat(64) })
    expect(parseMarkdownBackupManifest(smuggled)).toBe(null)
    const negative = withTemplates({ path: BACKUP_TEMPLATES_NAME, bytes: -1, sha256: 'b'.repeat(64) })
    expect(parseMarkdownBackupManifest(negative)).toBe(null)
    const notARecord = withTemplates({ path: BACKUP_TEMPLATES_NAME, bytes: 10, sha256: 'b'.repeat(64), extra: 1 })
    expect(parseMarkdownBackupManifest(notARecord)?.templates?.bytes).toBe(10)
  })

  it('follows the snapshot layout of the version that wrote it', () => {
    const v2 = manifest({ version: 2, templates: { path: `snapshots/${STAMP}/templates.json`, bytes: 10, sha256: 'c'.repeat(64) } })
    expect(parseMarkdownBackupManifest(v2)?.templates?.path).toBe(`snapshots/${STAMP}/templates.json`)
    const misplacedV2 = manifest({ version: 2, templates: { path: 'templates.json', bytes: 10, sha256: 'c'.repeat(64) } })
    expect(parseMarkdownBackupManifest(misplacedV2)).toBe(null)
  })
})
