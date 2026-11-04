import { describe, expect, it } from 'vitest'
import { MEDIA_UPLOAD_LIMIT, uploadBatch } from './MediaPanel'

function files(count: number): File[] {
  return Array.from({ length: count }, (_, index) => new File(['x'], `f${index}.png`))
}

describe('uploadBatch', () => {
  it('returns exactly the files the counter reports', () => {
    const batch = uploadBatch(files(MEDIA_UPLOAD_LIMIT + 5))
    expect(batch).toHaveLength(MEDIA_UPLOAD_LIMIT)
  })

  it('keeps a smaller selection whole and handles no selection', () => {
    expect(uploadBatch(files(3))).toHaveLength(3)
    expect(uploadBatch(null)).toHaveLength(0)
  })
})
