import { describe, expect, it } from 'vitest'
import { cloudDrivePath, parseCloudDriveAddress } from '../src/client/features/clouddrive/address'

describe('CloudDrive address', () => {
  it('decodes path segments once, so a Chinese folder is navigable and shown as typed', () => {
    const decoded = parseCloudDriveAddress('/clouddrive/files/primary/%E6%8E%A2%E9%92%88%E6%96%87%E4%BB%B6%E5%A4%B9/a%20b', '')
    expect(decoded).toEqual({ page: 'files', mountId: 'primary', path: '/探针文件夹/a b' })
    expect(cloudDrivePath('files', 'primary', decoded.path)).toBe(
      '/clouddrive/files/primary/%E6%8E%A2%E9%92%88%E6%96%87%E4%BB%B6%E5%A4%B9/a%20b',
    )
  })

  it('keeps a malformed escape as text rather than throwing', () => {
    expect(parseCloudDriveAddress('/clouddrive/files/primary/%E0%A4%A', '').path).toBe('/%E0%A4%A')
  })

  it('reads the mount and path from the query form', () => {
    expect(parseCloudDriveAddress('/clouddrive', '?mount=photos&path=%2F2026')).toEqual({
      page: 'files',
      mountId: 'photos',
      path: '/2026',
    })
  })
})
