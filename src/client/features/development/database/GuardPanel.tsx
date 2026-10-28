import { ShieldAlert, ShieldCheck } from 'lucide-react'
import { useRef } from 'react'
import { t } from '../../../lib/i18n'
import { Button, IconButton } from '../../../components/primitives'
import { Checkbox } from '../../../components/form'
import { Tooltip } from '../../../components/overlay'
import { ToolbarPanel } from './ToolbarPanel'
import type { ConnectionGuard } from './guards'

export interface GuardPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  guard: ConnectionGuard
  onChange: (patch: Partial<ConnectionGuard>) => void
  unlockedUntil?: number
  onLockNow: () => void
  disabled?: boolean
}

export function GuardPanel({ open, onOpenChange, guard, onChange, unlockedUntil, onLockNow, disabled }: GuardPanelProps) {
  const anchor = useRef<HTMLButtonElement>(null)
  const locked = Boolean(unlockedUntil && unlockedUntil > Date.now())
  return (
    <>
      <Tooltip label={t('development.database.guard.title')}>
        <IconButton
          ref={anchor}
          label={t('development.database.guard.title')}
          size="sm"
          disabled={disabled}
          onClick={() => onOpenChange(!open)}
          className={guard.readOnly || guard.production ? 'text-[var(--warning)]' : undefined}
        >
          {guard.readOnly ? <ShieldAlert size={14} /> : <ShieldCheck size={14} />}
        </IconButton>
      </Tooltip>
      <ToolbarPanel open={open} onClose={() => onOpenChange(false)} anchor={anchor} label={t('development.database.guard.title')} width={280}>
        <div className="space-y-2">
          <label className="flex items-start gap-2 rounded-[var(--r-sm)] px-1 py-1 hover:bg-[var(--bg-hover)]">
            <Checkbox checked={guard.readOnly} onChange={(next) => onChange({ readOnly: next })} ariaLabel={t('development.database.guard.read_only')} />
            <span className="min-w-0">
              <span className="block text-[length:var(--text-12)] text-[var(--text-primary)]">{t('development.database.guard.read_only')}</span>
              <span className="block text-[length:var(--text-10)] leading-relaxed text-[var(--text-tertiary)]">{t('development.database.guard.read_only_hint')}</span>
            </span>
          </label>
          <label className="flex items-start gap-2 rounded-[var(--r-sm)] px-1 py-1 hover:bg-[var(--bg-hover)]">
            <Checkbox checked={guard.production} onChange={(next) => onChange({ production: next })} ariaLabel={t('development.database.guard.production')} />
            <span className="min-w-0">
              <span className="block text-[length:var(--text-12)] text-[var(--text-primary)]">{t('development.database.guard.production')}</span>
              <span className="block text-[length:var(--text-10)] leading-relaxed text-[var(--text-tertiary)]">{t('development.database.guard.production_hint')}</span>
            </span>
          </label>
          {locked && unlockedUntil && (
            <div className="flex items-center justify-between gap-2 rounded-[var(--r-sm)] border border-[var(--warning)]/30 bg-[var(--warning-soft)] px-2 py-1.5">
              <span className="text-[length:var(--text-10)] text-[var(--warning)]">
                {t('development.database.guard.unlocked_until', { time: new Date(unlockedUntil).toLocaleTimeString(undefined, { hour12: false }) })}
              </span>
              <Button variant="ghost" size="sm" onClick={onLockNow}>{t('development.database.guard.lock_now')}</Button>
            </div>
          )}
        </div>
      </ToolbarPanel>
    </>
  )
}
