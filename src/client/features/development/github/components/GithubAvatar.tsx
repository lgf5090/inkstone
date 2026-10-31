import { useState } from 'react'
import { cn } from '../../../../lib/cn'

export function GithubAvatar({ src, name, size = 24, className }: { src: string; name: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false)
  const letter = (name.trim()[0] ?? '?').toUpperCase()
  if (!src || failed) {
    return (
      <span
        aria-hidden="true"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
        className={cn('inline-flex shrink-0 items-center justify-center rounded-full bg-[var(--bg-raised)] font-medium text-[var(--text-secondary)]', className)}
      >
        {letter}
      </span>
    )
  }
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      style={{ width: size, height: size }}
      className={cn('shrink-0 rounded-full bg-[var(--bg-inset)] object-cover', className)}
    />
  )
}
