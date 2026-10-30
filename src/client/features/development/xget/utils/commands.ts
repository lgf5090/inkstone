import { XGET_PLATFORMS, xgetPathPrefix, type XgetPlatform } from '@shared/development/xget/catalog'

export interface DetectedUrl {
  platform: XgetPlatform
  url: URL
  original: string
}

const GIT_PLATFORMS = new Set(['gh', 'gist', 'gl', 'gitea', 'codeberg', 'sf', 'aosp', 'homebrew'])

const NON_REPO_SEGMENTS = new Set([
  'archive',
  'blob',
  'blame',
  'branches',
  'commit',
  'commits',
  'compare',
  'download',
  'downloads',
  'files',
  'info',
  'issues',
  'lfs',
  'merge_requests',
  'objects',
  'packages',
  'pulls',
  'raw',
  'releases',
  'tags',
  'tree',
  'wiki',
])

const FILE_SUFFIX =
  /\.(?:zip|tar|tgz|gz|bz2|xz|zst|7z|rar|exe|msi|dmg|pkg|apk|deb|rpm|jar|war|whl|bin|md|rb|json|txt|html?)$/i

function pathMatch(url: URL): XgetPlatform | null {
  const matches: { platform: XgetPlatform; path: string }[] = []
  for (const platform of XGET_PLATFORMS) {
    for (const host of platform.hosts) {
      const slash = host.indexOf('/')
      if (slash === -1) continue
      const hostname = host.slice(0, slash)
      const path = host.slice(slash + 1)
      if (url.hostname !== hostname) continue
      if (url.pathname !== `/${path}` && !url.pathname.startsWith(`/${path}/`)) continue
      matches.push({ platform, path })
    }
  }
  matches.sort((a, b) => b.path.length - a.path.length || b.platform.key.length - a.platform.key.length)
  return matches[0]?.platform ?? null
}

export function detectPlatform(input: string): DetectedUrl | null {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.pathname === '/' || url.pathname === '') return null

  const matched = pathMatch(url)
  if (matched) return { platform: matched, url, original: input }

  const platform = XGET_PLATFORMS.find((candidate) =>
    candidate.hosts.some((host) => !host.includes('/') && host === url.hostname),
  )
  return platform ? { platform, url, original: input } : null
}

export function buildProxyUrl(proxyBase: string, key: string, pathname: string, search = ''): string {
  return `${proxyBase.replace(/\/+$/, '')}/${xgetPathPrefix(key)}${pathname}${search}`
}

function pathSegments(acceleratedUrl: string, platformKey: string): string[] | null {
  let url: URL
  try {
    url = new URL(acceleratedUrl)
  } catch {
    return null
  }
  const segments = url.pathname.split('/').filter(Boolean)
  const prefix = xgetPathPrefix(platformKey).split('/')
  for (let index = 0; index <= segments.length - prefix.length; index += 1) {
    if (prefix.every((segment, offset) => segments[index + offset] === segment)) {
      return segments.slice(index + prefix.length)
    }
  }
  return null
}

function isRepoRoot(acceleratedUrl: string, platformKey: string): boolean {
  const segments = pathSegments(acceleratedUrl, platformKey)
  if (!segments) return false
  if (segments.some((segment) => NON_REPO_SEGMENTS.has(segment.toLowerCase()))) return false
  const last = segments[segments.length - 1]?.replace(/\.git$/i, '') ?? ''
  if (!last || FILE_SUFFIX.test(last)) return false

  switch (platformKey) {
    case 'gh':
    case 'gist':
    case 'gitea':
    case 'codeberg':
      return segments.length === 2
    case 'homebrew':
      return segments.length === 1
    default:
      return segments.length >= 2
  }
}

export function buildCommands(
  acceleratedUrl: string,
  platformKey: string,
): { name: string; command: string }[] {
  const commands: { name: string; command: string }[] = []
  if (GIT_PLATFORMS.has(platformKey) && isRepoRoot(acceleratedUrl, platformKey)) {
    const cloneUrl = acceleratedUrl.replace(/\/+$/, '').replace(/\.git$/, '')
    commands.push({ name: 'git clone', command: `git clone ${cloneUrl}.git` })
  }
  commands.push({ name: 'wget', command: `wget -c "${acceleratedUrl}"` })
  commands.push({ name: 'curl', command: `curl -L -O "${acceleratedUrl}"` })
  commands.push({ name: 'aria2', command: `aria2c -x 16 -s 16 "${acceleratedUrl}"` })
  return commands
}

export function buildEcosystemCommands(proxyBase: string): { name: string; command: string }[] {
  const base = proxyBase.replace(/\/+$/, '')
  return [
    { name: 'pip', command: `pip config set global.index-url ${base}/pypi/simple/` },
    { name: 'npm', command: `npm config set registry ${base}/npm/` },
    { name: 'git', command: `git config --global url."${base}/gh/".insteadOf "https://github.com/"` },
    { name: 'HF', command: `export HF_ENDPOINT='${base}/hf'` },
    { name: 'conda', command: `conda config --set channel_alias ${base}/conda/community` },
    { name: 'Go', command: `go env -w GOPROXY=${base}/golang,direct` },
  ]
}
