// Derived from Xget (AGPL-3.0-only) src/utils/rewrite.js, via mpages functions/_lib/development/xget, with Inkstone adaptations.

const FLATHUB_REPO_BASE_URL_PATTERN = /https:\/\/(?:dl\.)?flathub\.org\/repo\//g
const FLATPAK_REFERENCE_FILE_PATTERN = /\.(flatpakrepo|flatpakref)$/i

export function shouldRewriteTextResponse(
  platform: string,
  requestPath: string,
  contentType = '',
): boolean {
  if (platform === 'pypi') return contentType.includes('text/html')
  if (platform === 'npm') return contentType.includes('application/json')
  if (platform === 'flathub') return FLATPAK_REFERENCE_FILE_PATTERN.test(requestPath)
  return false
}

export function isFlatpakReferenceFilePath(requestPath: string): boolean {
  return FLATPAK_REFERENCE_FILE_PATTERN.test(requestPath)
}

export function rewriteTextResponse(
  platform: string,
  requestPath: string,
  originalText: string,
  proxyBaseUrl: string,
): string {
  if (platform === 'pypi') {
    return originalText.replace(
      /https:\/\/files\.pythonhosted\.org/g,
      `${proxyBaseUrl}/pypi/files`,
    )
  }
  if (platform === 'npm') {
    return originalText.replace(
      /https:\/\/registry\.npmjs\.org\/([^/]+)/g,
      `${proxyBaseUrl}/npm/$1`,
    )
  }
  if (platform === 'flathub' && isFlatpakReferenceFilePath(requestPath)) {
    return originalText.replace(FLATHUB_REPO_BASE_URL_PATTERN, `${proxyBaseUrl}/flathub/repo/`)
  }
  return originalText
}
