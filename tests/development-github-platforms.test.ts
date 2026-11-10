import { describe, expect, it } from 'vitest'
import {
  assetPlatform,
  compareVersions,
  normalizeVersionTag,
  pickReleaseAsset,
  releasePlatforms,
  updateState,
} from '../src/shared/development/github/platforms'

describe('github asset platforms', () => {
  it('classifies release assets by their platform suffix', () => {
    expect(assetPlatform('app-1.2.0.apk')).toBe('android')
    expect(assetPlatform('App Setup 1.2.0.EXE')).toBe('windows')
    expect(assetPlatform('App-1.2.0.dmg')).toBe('macos')
    expect(assetPlatform('app_1.2.0_amd64.deb')).toBe('linux')
    expect(assetPlatform('app-1.2.0.tar.gz')).toBeNull()
    expect(assetPlatform('source.zip')).toBeNull()
  })

  it('lists the platforms a release ships', () => {
    expect(releasePlatforms(['app.apk', 'app.dmg', 'notes.txt'])).toEqual(['android', 'macos'])
    expect(releasePlatforms([])).toEqual([])
  })

  it('picks the platform asset and honours an optional name filter', () => {
    const assets = [
      { name: 'app-arm64.apk' },
      { name: 'app-x64.apk' },
      { name: 'app.dmg' },
    ]
    expect(pickReleaseAsset(assets, 'android')?.name).toBe('app-arm64.apk')
    expect(pickReleaseAsset(assets, 'android', 'x64')?.name).toBe('app-x64.apk')
    expect(pickReleaseAsset(assets, 'linux')).toBeNull()
    expect(pickReleaseAsset(assets, 'all')?.name).toBe('app-arm64.apk')
  })
})

describe('github version comparison', () => {
  it('compares plain dotted versions, padding missing parts', () => {
    expect(compareVersions('1.2.0', '1.2')).toBe(0)
    expect(compareVersions('v1.10.0', '1.9.9')).toBe(1)
    expect(compareVersions('2.0.0', '2.0.1')).toBe(-1)
    expect(compareVersions('release-1', '1.0.0')).toBeNull()
    expect(normalizeVersionTag(' v1.2.3 ')).toBe('1.2.3')
  })

  it('reports an update only when the latest tag is newer', () => {
    expect(updateState('v1.3.0', '1.2.0')).toBe('update-available')
    expect(updateState('v1.2.0', '1.2.0')).toBe('up-to-date')
    expect(updateState('v1.1.0', '1.2.0')).toBe('up-to-date')
    expect(updateState('nightly', '1.2.0')).toBe('unknown')
    expect(updateState('', '1.2.0')).toBe('unknown')
  })
})
