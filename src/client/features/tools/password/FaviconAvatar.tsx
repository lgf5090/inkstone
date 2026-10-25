import { useEffect, useState } from 'react'
import { cn } from '../../../lib/cn'

export interface FaviconAvatarProps {
  url?: string
  title?: string
  favicon?: string
  size?: number
  className?: string
}

export function extractDomain(link?: string): string {
  if (!link) return ''
  const trimmed = link.trim()
  if (!trimmed) return ''

  try {
    const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    const parsed = new URL(withProto)
    return parsed.hostname.toLowerCase()
  } catch {
    const match = trimmed.match(/^([a-zA-Z0-9-]+\.[a-zA-Z0-9.-]+)/)
    return match ? match[1].toLowerCase() : ''
  }
}

const BG_PALETTES = [
  'bg-blue-600 text-white',
  'bg-emerald-600 text-white',
  'bg-amber-600 text-white',
  'bg-violet-600 text-white',
  'bg-rose-600 text-white',
  'bg-indigo-600 text-white',
  'bg-cyan-600 text-white',
  'bg-teal-600 text-white',
  'bg-fuchsia-600 text-white',
]

export function getAvatarColor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i)
    hash |= 0
  }
  return BG_PALETTES[Math.abs(hash) % BG_PALETTES.length]!
}

export function getInitial(title?: string, url?: string): string {
  const target = (title || extractDomain(url) || '?').trim()
  if (!target) return '?'
  const chars = Array.from(target)
  const first = chars[0] ?? '?'
  return /[a-z]/i.test(first) ? first.toUpperCase() : first
}

export function FaviconAvatar({
  url,
  title = '',
  favicon,
  size = 32,
  className,
}: FaviconAvatarProps) {
  const [loadFailed, setLoadFailed] = useState(false)
  const domain = extractDomain(url)
  const candidateSrc = favicon || (domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=64` : '')

  useEffect(() => {
    setLoadFailed(false)
  }, [candidateSrc])

  const initial = getInitial(title, url)
  const colorClass = getAvatarColor(title || domain || initial)
  const showImg = Boolean(candidateSrc) && !loadFailed

  return (
    <div
      data-testid="favicon-avatar"
      style={{ width: size, height: size, minWidth: size, minHeight: size }}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg font-semibold select-none',
        !showImg && colorClass,
        className,
      )}
    >
      {showImg ? (
        <img
          src={candidateSrc}
          alt={title || domain || 'Favicon'}
          loading="lazy"
          className="size-full object-contain p-0.5"
          onError={() => setLoadFailed(true)}
        />
      ) : (
        <span
          data-testid="favicon-initial"
          style={{ fontSize: Math.max(10, Math.round(size * 0.45)) }}
        >
          {initial}
        </span>
      )}
    </div>
  )
}
