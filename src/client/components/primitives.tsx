import { useEffect, useMemo, useState, type ButtonHTMLAttributes, type ReactNode, type Ref } from 'react'
import { cn } from '../lib/cn'
import { prettyCombo } from '../lib/hotkeys'
import { generatedAvatarSeed, isBitmapAvatarDataUrl, parseStoredAvatarUrl } from '@shared/avatar'


export function Logo({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={cn('ink-logo', className)}
      aria-hidden="true"
    >
      <rect
        x="2.5"
        y="2.5"
        width="27"
        height="27"
        rx="8.5"
        className="fill-[var(--text-primary)]"
      />
      <path
        d="M16 8.2c2.7 3.5 5.4 6.3 5.4 9.3a5.4 5.4 0 1 1-10.8 0c0-3 2.7-5.8 5.4-9.3z"
        className="fill-[var(--brand-accent)]"
      />
    </svg>
  )
}


type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle'
type Size = 'sm' | 'md' | 'lg'

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-[var(--accent)] text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] shadow-[0_1px_2px_rgba(0,0,0,.14)]',
  secondary:
    'border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] hover:border-[var(--border-strong)]',
  ghost: 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
  subtle: 'bg-[var(--bg-raised)] text-[var(--text-primary)] hover:bg-[var(--bg-active)]',
  danger:
    'bg-[var(--danger)] text-white hover:brightness-108 shadow-[0_1px_2px_rgba(0,0,0,.14)]',
}

const SIZES: Record<Size, string> = {
  sm: 'h-9 px-3 text-[12px] gap-1.5 rounded-[var(--r-sm)] md:h-7 md:px-2.5',
  md: 'h-10 px-3.5 text-[13px] gap-1.5 rounded-[var(--r-md)] md:h-8 md:px-3',
  lg: 'h-11 px-4 text-[14px] gap-2 rounded-[var(--r-md)] md:h-10',
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
  icon?: ReactNode
  trailing?: ReactNode
  block?: boolean
  ref?: Ref<HTMLButtonElement>
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  icon,
  trailing,
  block,
  className,
  children,
  disabled,
  'aria-busy': ariaBusy,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading ? true : ariaBusy}
      className={cn(
        'relative inline-flex items-center justify-center font-medium whitespace-nowrap select-none',
        'transition-[background-color,border-color,color,opacity,transform] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
        'active:translate-y-px disabled:pointer-events-none disabled:opacity-45',
        VARIANTS[variant],
        SIZES[size],
        block && 'w-full',
        className,
      )}
    >
      {loading ? <Spinner size={size === 'lg' ? 15 : 13} /> : icon}
      {children != null && <span className="truncate">{children}</span>}
      {trailing}
    </button>
  )
}

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  label: string
  size?: 'xs' | Size
  variant?: Variant
  active?: boolean
  ref?: Ref<HTMLButtonElement>
}

export function IconButton({
  label,
  size = 'md',
  variant = 'ghost',
  active,
  className,
  children,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[var(--r-md)]',
        'transition-[background-color,color,transform] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
        'active:scale-[0.94] disabled:pointer-events-none disabled:opacity-40',
        size === 'xs' ? 'size-6' : size === 'sm' ? 'size-8 md:size-6' : size === 'lg' ? 'size-10 md:size-9' : 'size-9 md:size-7',
        active
          ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
          : VARIANTS[variant],
        className,
      )}
    >
      {children}
    </button>
  )
}


export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={cn('shrink-0 animate-[ink-spin_0.7s_linear_infinite]', className)}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  )
}


export function Kbd({ combo, keys }: { combo?: string; keys?: string[] }) {
  const parts = keys ?? (combo ? prettyCombo(combo) : [])
  return (
    <span className="inline-flex shrink-0 items-center gap-[3px]">
      {parts.map((key, i) => (
        <kbd
          key={`${key}-${i}`}
          className={cn(
            'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] px-[5px]',
            'border border-[var(--border-default)] bg-[var(--bg-raised)]',
            'text-[10.5px] font-medium text-[var(--text-tertiary)]',
          )}
        >
          {key}
        </kbd>
      ))}
    </span>
  )
}


export function Avatar({
  src,
  name,
  size = 24,
  className,
}: {
  src?: string
  name: string
  size?: number
  className?: string
}) {
  const seed = name.trim() || '?'
  const storedSrc = useMemo(() => {
    if (isBitmapAvatarDataUrl(src)) return src
    if (parseStoredAvatarUrl(src)) return src
    return null
  }, [src])
  const [generatedSrc, setGeneratedSrc] = useState<string | null>(null)
  const [fallbackSrc, setFallbackSrc] = useState<string | null>(null)
  useEffect(() => {
    if (storedSrc) return
    let cancelled = false
    // dicebear ships full micah style data; keep it out of the boot chunk.
    void import('../lib/avatar').then(({ createAvatarDataUri }) => {
      if (!cancelled) setGeneratedSrc(createAvatarDataUri(generatedAvatarSeed(src) ?? seed))
    })
    return () => {
      cancelled = true
    }
  }, [src, seed, storedSrc])
  const resolvedSrc = fallbackSrc ?? storedSrc ?? generatedSrc
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full',
        'bg-[var(--bg-raised)] text-[var(--text-secondary)] font-medium select-none',
        'ring-1 ring-[var(--border-subtle)]',
        className,
      )}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {resolvedSrc ? (
        <img
          src={resolvedSrc}
          alt=""
          width={size}
          height={size}
          onError={() => {
            if (fallbackSrc) return
            void import('../lib/avatar').then(({ createAvatarDataUri }) =>
              setFallbackSrc(createAvatarDataUri(seed)),
            )
          }}
          className="size-full object-cover"
        />
      ) : (
        <span aria-hidden>{seed.slice(0, 1).toUpperCase()}</span>
      )}
    </span>
  )
}


export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
  className?: string
}) {
  const tones = {
    neutral: 'bg-[var(--bg-raised)] text-[var(--text-tertiary)]',
    accent: 'bg-[var(--accent-soft)] text-[var(--accent)]',
    success: 'bg-[color-mix(in_oklab,var(--success)_15%,transparent)] text-[var(--success)]',
    warning: 'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]',
    danger: 'bg-[color-mix(in_oklab,var(--danger)_15%,transparent)] text-[var(--danger)]',
  }
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-[7px] py-[1px] text-[11px] font-medium tabular',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}


export function Divider({ className, vertical }: { className?: string; vertical?: boolean }) {
  return (
    <div
      role="separator"
      className={cn(
        'shrink-0 bg-[var(--border-subtle)]',
        vertical ? 'h-4 w-px' : 'h-px w-full',
        className,
      )}
    />
  )
}


export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'min-w-0 truncate px-2 pt-1 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.075em] text-[var(--text-quaternary)] whitespace-nowrap',
        className,
      )}
    >
      {children}
    </div>
  )
}
