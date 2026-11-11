import type { GithubAssetPlatform } from '@shared/development/github/types'

export function detectDevicePlatform(): GithubAssetPlatform | null {
  if (typeof navigator === 'undefined') return null
  const source = `${navigator.userAgent} ${navigator.platform}`.toLowerCase()
  if (source.includes('android')) return 'android'
  if (source.includes('iphone') || source.includes('ipad') || source.includes('ipod')) return null
  if (source.includes('win')) return 'windows'
  if (source.includes('mac')) return 'macos'
  if (source.includes('linux') || source.includes('x11')) return 'linux'
  return null
}
