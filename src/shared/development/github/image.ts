import { isBlockedTarget } from '../../ai-proxy-guard'

export const MAX_GITHUB_IMAGE_URL_CHARS = 4096

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com'])
const REPO_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/
const GITHUB_FILE_PATH = /^\/([^/]+)\/([^/]+)\/(blob|raw)\/([^/]+)\/(.+)$/

export interface ImageUrlCheck {
  ok: boolean
  url: string
  reason: string
}

export function normalizeGithubImageUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return raw
  }
  if (url.protocol !== 'https:' || !GITHUB_HOSTS.has(url.hostname.toLowerCase())) return raw
  const match = GITHUB_FILE_PATH.exec(url.pathname)
  if (!match) return raw
  const [, owner, repo, , ref, file] = match
  if (!owner || !repo || !ref || !file) return raw
  if (!REPO_SEGMENT.test(owner) || !REPO_SEGMENT.test(repo)) return raw
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${file}`
}

export function checkGithubImageUrl(raw: string): ImageUrlCheck {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, url: '', reason: 'An image URL is required' }
  if (trimmed.length > MAX_GITHUB_IMAGE_URL_CHARS) {
    return { ok: false, url: '', reason: 'That image URL is too long' }
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { ok: false, url: '', reason: 'That image URL is not a valid URL' }
  }
  if (url.protocol !== 'https:') {
    return { ok: false, url: '', reason: 'Image URLs must use HTTPS' }
  }
  if (url.username || url.password) {
    return { ok: false, url: '', reason: 'Image URLs cannot carry credentials' }
  }
  if (url.port && url.port !== '443') {
    return { ok: false, url: '', reason: 'Image URLs cannot use a custom port' }
  }
  if (isBlockedTarget(url.hostname)) {
    return { ok: false, url: '', reason: 'That address is not a public host' }
  }
  return { ok: true, url: url.toString(), reason: '' }
}
