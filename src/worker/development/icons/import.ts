/**
 * Brand and duotone collections paint several colours; monochrome sets paint one. The filter panel
 * offers this as a facet, so it is recorded once at import time rather than guessed per request.
 */
export function detectColorMode(body: string): 'mono' | 'multi' {
  const colors = new Set<string>()
  for (const match of body.matchAll(/(?:fill|stroke)=["']([^"']+)["']/gi)) {
    const value = match[1]!.trim().toLowerCase()
    if (!value || value === 'none' || value === 'currentcolor' || value === 'transparent') continue
    if (value.startsWith('url(')) return 'multi'
    colors.add(value)
    if (colors.size > 1) return 'multi'
  }
  return colors.size > 1 ? 'multi' : 'mono'
}
