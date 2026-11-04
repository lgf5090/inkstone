import { useId, useState, type ReactElement } from 'react'
import { Eye, EyeOff, Lock, LockOpen } from 'lucide-react'
import { Button } from '../../../components/primitives'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { MemoBody, type MemoBodyProps } from './MemoBody'

export interface MemoMaskedBodyProps extends MemoBodyProps {
  blurred: boolean
  /** The memo's body is sealed; `content` is the decrypted body only when `revealed` is true. */
  sealed?: boolean
  revealed?: boolean
  unlocking?: boolean
  onUnlock?: () => void
  onRelock?: () => void
}

const MOSAIC_LINE_WIDTHS = ['78%', '92%', '64%', '85%', '48%'] as const

function SealedPlaceholder({
  className,
  unlocking,
  onUnlock,
}: {
  className?: string
  unlocking: boolean
  onUnlock?: () => void
}): ReactElement {
  return (
    <div
      data-memo-sealed="locked"
      className={cn(
        'relative min-h-20 overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2.5 py-2',
        className,
      )}
    >
      <div aria-hidden="true" className="space-y-1.5 blur-[6px] saturate-50 select-none">
        {MOSAIC_LINE_WIDTHS.map((width, index) => (
          <span
            key={width}
            className={cn(
              'block h-2.5 rounded-[var(--r-xs)] bg-[var(--text-quaternary)] opacity-[0.55]',
              index % 2 === 0 && 'opacity-[0.45]',
            )}
            style={{ width }}
          />
        ))}
      </div>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-[color-mix(in_oklab,var(--bg-inset)_78%,transparent)]">
        <span className="inline-flex items-center gap-1 text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">
          <Lock size={12} aria-hidden="true" />
          {t('memos.cipher.masked')}
        </span>
        {onUnlock ? (
          <Button
            size="sm"
            variant="secondary"
            icon={<LockOpen size={13} />}
            loading={unlocking}
            onClick={onUnlock}
          >
            {t('memos.cipher.unlock')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export function MemoMaskedBody({
  blurred,
  sealed = false,
  revealed = false,
  unlocking = false,
  onUnlock,
  onRelock,
  className,
  ...body
}: MemoMaskedBodyProps): ReactElement {
  const [revealedByRule, setRevealedByRule] = useState(false)
  const bodyId = useId()

  if (sealed) {
    if (!revealed) return <SealedPlaceholder className={className} unlocking={unlocking} onUnlock={onUnlock} />
    return (
      <div className={cn('relative min-w-0', className)} data-memo-sealed="revealed">
        <div id={bodyId}>
          <MemoBody {...body} />
        </div>
        {onRelock ? (
          <div className="mt-2 flex justify-end">
            <Button
              size="sm"
              variant="ghost"
              icon={<Lock size={13} />}
              aria-controls={bodyId}
              onClick={onRelock}
            >
              {t('memos.cipher.relock')}
            </Button>
          </div>
        ) : null}
      </div>
    )
  }

  const hidden = blurred && !revealedByRule
  return (
    <div className={cn('relative min-w-0', className)} data-memo-blurred={blurred ? 'true' : undefined}>
      <div
        id={bodyId}
        data-memo-mask={hidden ? 'hidden' : 'revealed'}
        aria-hidden={hidden || undefined}
        inert={hidden || undefined}
        className={cn(hidden && 'select-none blur-[var(--memo-blur)]')}
      >
        <MemoBody {...body} />
      </div>
      {blurred ? (
        <div className={cn(hidden ? 'absolute inset-0 flex items-center justify-center' : 'mt-2 flex justify-end')}>
          <Button
            size="sm"
            variant={hidden ? 'secondary' : 'ghost'}
            icon={hidden ? <Eye size={13} /> : <EyeOff size={13} />}
            aria-expanded={!hidden}
            aria-controls={bodyId}
            onClick={() => setRevealedByRule((value) => !value)}
          >
            {hidden ? t('memos.blur.reveal') : t('memos.blur.hide')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
