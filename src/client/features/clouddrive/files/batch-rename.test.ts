import { describe, expect, it } from 'vitest'
import type { CloudDriveEntry } from '@shared/clouddrive/model'
import { planBatchRename, type BatchRenameOptions } from './batch-rename'

function entry(id: string, name: string, kind: 'folder' | 'file' = 'file'): CloudDriveEntry {
  return {
    id,
    kind,
    name,
    path: `/${name}`,
    mountId: 'primary',
    mountName: 'Primary',
    category: 'other',
    mime: 'application/octet-stream',
    size: 1,
    uploadedAt: 0,
    modifiedAt: 0,
    starredAt: null,
    readOnly: false,
    hasThumbnail: false,
    storage: 'primary',
    storageKind: 'r2',
    color: null,
    tags: [],
  }
}

function options(patch: Partial<BatchRenameOptions>): BatchRenameOptions {
  return { mode: 'prefix', value: '', find: '', start: 1, ...patch }
}

const NAME = (patch: Partial<BatchRenameOptions>) => planBatchRename([entry('1', 'photo.jpg')], [], options(patch))[0].name

describe('planBatchRename', () => {
  it('keeps an extension at the end instead of appending after it', () => {
    expect(NAME({ mode: 'suffix', value: '-v2' })).toBe('photo-v2.jpg')
    expect(NAME({ mode: 'prefix', value: '2024-' })).toBe('2024-photo.jpg')
  })

  it('treats a folder name as one piece, because a folder has no extension', () => {
    expect(planBatchRename([entry('1', 'my.site', 'folder')], [], options({ mode: 'suffix', value: '-v2' }))[0].name).toBe('my.site-v2')
  })

  it('replaces inside the name only, never inside the extension', () => {
    expect(NAME({ mode: 'replace', find: 'pho', value: 'gra' })).toBe('grato.jpg')
    expect(NAME({ mode: 'replace', find: 'jpg', value: 'png' })).toBe('photo.jpg')
  })

  it('numbers with the chosen base and first index, extension preserved', () => {
    const plan = planBatchRename([entry('1', 'a.jpg'), entry('2', 'b.png')], [], options({ mode: 'number', value: 'photo', start: 3 }))
    expect(plan.map((item) => item.name)).toEqual(['photo3.jpg', 'photo4.png'])
  })

  it('marks a name the drive would refuse as invalid', () => {
    expect(planBatchRename([entry('1', 'a.jpg')], [], options({ mode: 'prefix', value: 'x/' }))[0].problem).toBe('invalid')
  })

  it('marks a name a row that stays put already holds, but not the row keeping its own name', () => {
    expect(planBatchRename([entry('1', 'a.jpg')], [entry('2', 'taken.jpg')], options({ mode: 'replace', find: 'a', value: 'taken' }))[0].problem).toBe('duplicate')
    expect(planBatchRename([entry('1', 'a.jpg')], [entry('1', 'a.jpg')], options({ mode: 'prefix', value: '' }))[0].problem).toBeNull()
  })

  it('marks two rows converging on one name, the second one only', () => {
    const plan = planBatchRename([entry('1', 'x.jpg'), entry('2', 'y.jpg')], [], options({ mode: 'replace', find: 'x', value: 'y' }))
    expect(plan.map((item) => item.name)).toEqual(['y.jpg', 'y.jpg'])
    expect(plan.map((item) => item.problem)).toEqual([null, 'duplicate'])
  })
})
