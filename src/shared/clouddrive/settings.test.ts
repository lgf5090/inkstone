import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CLOUDDRIVE_SETTINGS,
  normalizeCloudDriveSettingsPatch,
  parseCloudDriveSettings,
  parsePreviewRules,
  publicCloudDriveSettings,
} from './settings'

describe('cloud drive settings', () => {
  it('returns defaults when no rows exist', () => {
    const settings = parseCloudDriveSettings({})
    expect(settings.uploadPartSizeBytes).toBe(DEFAULT_CLOUDDRIVE_SETTINGS.uploadPartSizeBytes)
    expect(settings.previewRules.length).toBeGreaterThan(0)
    expect(settings.adminOwnerCanViewMemberFiles).toBe(false)
  })

  it('reads overrides and never exposes the webdav hash', () => {
    const settings = parseCloudDriveSettings({
      'upload.maxFileBytes': '1048576',
      'share.allowMemberShares': 'false',
      'webdav.passwordHash': 'hash',
      'preview.rules': JSON.stringify([{ id: 'x', priority: 50, type: 'none', extensions: ['bin'] }]),
    })
    expect(settings.uploadMaxFileBytes).toBe(1048576)
    expect(settings.shareAllowMemberShares).toBe(false)
    expect(settings.webdavPasswordHash).toBe('hash')
    expect(publicCloudDriveSettings(settings).webdavHasPassword).toBe(true)
    expect('webdavPasswordHash' in publicCloudDriveSettings(settings)).toBe(false)
    expect(settings.previewRules).toEqual([{ id: 'x', priority: 50, type: 'none', extensions: ['bin'] }])
  })

  it('rejects invalid preview rules but keeps valid ones', () => {
    expect(parsePreviewRules([
      { id: 'ok', priority: 10, type: 'text', extensions: ['.TXT', 'md', 'md'] },
      { id: 'bad', priority: 999, type: 'text', extensions: ['md'] },
      { id: 'ok', priority: 1, type: 'image', extensions: ['png'] },
    ])).toEqual([{ id: 'ok', priority: 10, type: 'text', extensions: ['txt', 'md'] }])
  })

  it('normalizes a patch into setting rows', () => {
    const result = normalizeCloudDriveSettingsPatch({
      uploadPartSizeBytes: 8 * 1024 * 1024,
      previewTextExtensions: ['.MD', 'txt', 'md'],
      shareDefaultExpiryDays: 0,
    })
    if ('error' in result) throw new Error(result.error)
    expect(result.rows['upload.partSizeBytes']).toBe(String(8 * 1024 * 1024))
    expect(JSON.parse(result.rows['preview.textExtensions']!)).toEqual(['md', 'txt'])
    expect(result.rows['share.defaultExpiryDays']).toBe('0')
  })

  it('reports invalid patches', () => {
    expect(normalizeCloudDriveSettingsPatch({ uploadPartSizeBytes: 1024 })).toEqual({ error: 'Invalid part size' })
    expect(normalizeCloudDriveSettingsPatch({ previewRules: [{ id: 'x', priority: 1, type: 'none', extensions: [] }] })).toEqual({ error: 'Invalid preview rule' })
  })
})
