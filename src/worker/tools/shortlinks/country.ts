/**
 * Country flag emoji and localized name helper.
 */

export function countryFlag(code: string | null | undefined): string {
  if (!code || code.length !== 2) return '🌐'
  const upper = code.toUpperCase()
  if (!/^[A-Z]{2}$/.test(upper)) return '🌐'
  const codePoints = [...upper].map((c) => 127397 + c.charCodeAt(0))
  return String.fromCodePoint(...codePoints)
}

export function countryName(code: string | null | undefined, lang = 'zh-CN'): string {
  if (!code) return lang.startsWith('zh') ? '未知地区' : 'Unknown'
  try {
    const names = new Intl.DisplayNames([lang], { type: 'region' })
    return names.of(code.toUpperCase()) || code
  } catch {
    return code
  }
}
