/**
 * Referrer and domain parsing, normalization, and self-referrer detection.
 */

export const APP_PACKAGE_TO_DOMAIN: Record<string, string> = {
  'com.linkedin.android': 'linkedin.com',
  'com.twitter.android': 'x.com',
  'com.facebook.katana': 'facebook.com',
  'com.facebook.lite': 'facebook.com',
  'com.instagram.android': 'instagram.com',
  'com.zhiliaoapp.musically': 'tiktok.com',
  'com.ss.android.ugc.trill': 'tiktok.com',
  'com.reddit.frontpage': 'reddit.com',
  'com.pinterest': 'pinterest.com',
  'com.Slack': 'slack.com',
  'com.discord': 'discord.com',
  'org.telegram.messenger': 'telegram.org',
  'com.whatsapp': 'whatsapp.com',
  'com.google.android.youtube': 'youtube.com',
  'com.google.android.gm': 'gmail.com',
  'com.microsoft.office.outlook': 'outlook.com',
  'com.tencent.mm': 'weixin.qq.com',
}

const APP_SCHEME_PREFIXES = ['android-app://', 'ios-app://'] as const

export function normalizeHost(host: string): string {
  const lower = host.toLowerCase().trim()
  return lower.startsWith('www.') ? lower.slice(4) : lower
}

export function parseAppReferrer(rawReferrer: string): { packageName: string } | null {
  for (const prefix of APP_SCHEME_PREFIXES) {
    if (rawReferrer.startsWith(prefix)) {
      const rest = rawReferrer.slice(prefix.length)
      const pkg = rest.split('/')[0]
      return pkg ? { packageName: pkg } : null
    }
  }
  return null
}

export function mapAppPackage(packageName: string): string | null {
  return APP_PACKAGE_TO_DOMAIN[packageName] ?? null
}

export function parseReferrerHost(rawReferrer: string | null | undefined): string | null {
  if (!rawReferrer) return null
  const app = parseAppReferrer(rawReferrer)
  if (app) return mapAppPackage(app.packageName)
  try {
    return normalizeHost(new URL(rawReferrer).hostname)
  } catch {
    return null
  }
}

export function isBareOriginSelfReferrer(rawReferrer: string | null | undefined, requestHost: string): boolean {
  if (!rawReferrer) return false
  try {
    const u = new URL(rawReferrer)
    if (normalizeHost(u.hostname) !== normalizeHost(requestHost)) return false
    return u.pathname === '/' && u.search === '' && u.hash === ''
  } catch {
    return false
  }
}

export function isSelfReferrer(rawReferrer: string | null | undefined, requestHost: string): boolean {
  if (!rawReferrer) return false
  let u: URL
  try {
    u = new URL(rawReferrer)
  } catch {
    return false
  }
  const host = normalizeHost(requestHost)
  if (normalizeHost(u.hostname) !== host) return false

  if (u.pathname === '/') return isBareOriginSelfReferrer(rawReferrer, host)

  // Single segment redirect e.g. /l/slug or /slug
  const segments = u.pathname.split('/').filter(Boolean)
  if (segments.length === 1 && !segments[0].startsWith('_')) return true
  if (segments.length === 2 && segments[0] === 'l') return true
  return false
}
