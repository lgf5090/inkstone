// Derived from Xget (AGPL-3.0-only) src/utils/validation.js, via mpages functions/_lib/development/xget, with Inkstone adaptations.
import { XGET_KNOWN_METHODS } from '@shared/development/xget/constants'
import type { XgetConfig } from '../config'
import { isAIInferenceRequest } from '../protocols/ai'
import { isGitLFSRequest, isGitRequest } from '../protocols/git'
import { isHuggingFaceAPIRequest } from '../protocols/huggingface'

export interface RequestTraits {
  isAI: boolean
  isDocker: boolean
  isGit: boolean
  isGitLFS: boolean
  isHF: boolean
}

export function getRequestTraits(request: Request, url: URL): RequestTraits {
  return {
    isAI: isAIInferenceRequest(request, url),
    isDocker: isDockerRequest(request, url),
    isGit: isGitRequest(request, url),
    isGitLFS: isGitLFSRequest(request, url),
    isHF: isHuggingFaceAPIRequest(request, url),
  }
}

export function isProtocolRequest(traits: RequestTraits): boolean {
  return traits.isGit || traits.isGitLFS || traits.isDocker || traits.isAI || traits.isHF
}

export function isDockerRequest(request: Request, url: URL): boolean {
  const { pathname } = url

  if (pathname === '/v2' || pathname === '/v2/' || pathname.startsWith('/v2/')) return true

  if (pathname.startsWith('/cr/')) {
    if (/^\/cr\/[^/]+\/v2(?:\/|$)/.test(pathname)) return true

    const userAgent = request.headers.get('User-Agent') || ''
    if (userAgent.toLowerCase().includes('docker/')) return true

    const accept = request.headers.get('Accept') || ''
    if (
      accept.includes('application/vnd.docker.distribution.manifest') ||
      accept.includes('application/vnd.oci.image.manifest') ||
      accept.includes('application/vnd.docker.image.rootfs.diff.tar.gzip')
    ) {
      return true
    }

    const contentType = request.headers.get('Content-Type') || ''
    if (
      contentType.includes('application/vnd.docker.distribution.manifest') ||
      contentType.includes('application/vnd.oci.image.manifest')
    ) {
      return true
    }
  }

  return false
}

function decodePathnameForValidation(pathname: string): { ok: true; value: string } | { ok: false } {
  let decoded = pathname
  for (let i = 0; i < 2; i++) {
    if (!/%[0-9a-fA-F]{2}/.test(decoded)) break
    try {
      decoded = decodeURIComponent(decoded)
    } catch {
      return { ok: false }
    }
  }
  return { ok: true, value: decoded }
}

function hasPathTraversal(pathname: string): boolean {
  const decodedResult = decodePathnameForValidation(pathname)
  if (!decodedResult.ok) return true
  const decoded = decodedResult.value.replace(/\\/g, '/')
  return /(^|\/)\.\.(\/|$)/.test(decoded)
}

function hasAsciiControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 31 || code === 127) return true
  }
  return false
}

export interface ValidationResult {
  valid: boolean
  error?: string
  status?: number
}

const PROTOCOL_METHODS: string[] = [...XGET_KNOWN_METHODS]

export function getAllowedMethods(request: Request, url: URL, config: XgetConfig): string[] {
  const traits = getRequestTraits(request, url)
  return isProtocolRequest(traits) ? PROTOCOL_METHODS : config.SECURITY.ALLOWED_METHODS
}

export function validateRequest(
  request: Request,
  url: URL,
  config: XgetConfig,
  traits: RequestTraits = getRequestTraits(request, url),
): ValidationResult {
  const allowedMethods = isProtocolRequest(traits)
    ? PROTOCOL_METHODS
    : config.SECURITY.ALLOWED_METHODS

  if (!allowedMethods.includes(request.method)) {
    return { valid: false, error: 'Method not allowed', status: 405 }
  }

  if (url.pathname.length > config.SECURITY.MAX_PATH_LENGTH) {
    return { valid: false, error: 'Path too long', status: 414 }
  }

  const rawPathname = request.url.startsWith(url.origin)
    ? request.url
        .slice(url.origin.length)
        .split('?')[0]
        .split('#')[0]
        .replace(/\\/g, '/')
    : url.pathname

  if (/(^|\/)\.\.(\/|$)/.test(rawPathname)) {
    return { valid: false, error: 'Invalid path', status: 400 }
  }

  if (hasAsciiControlChars(url.pathname)) {
    return { valid: false, error: 'Invalid path', status: 400 }
  }

  if (hasPathTraversal(url.pathname)) {
    return { valid: false, error: 'Invalid path', status: 400 }
  }

  return { valid: true }
}
