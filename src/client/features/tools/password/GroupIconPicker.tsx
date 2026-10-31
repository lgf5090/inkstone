import { useState } from 'react'
import type { PasswordGroup } from '@shared/tools/password/types'
import { t } from '../../../lib/i18n'
import { cn } from '../../../lib/cn'
import { useUi } from '../../../store/ui'
import { Button } from '../../../components/primitives'
import { Modal } from '../../../components/overlay'
import { GROUP_ICONS } from './groupIcons'
import { usePasswordVaultStore } from './store'

export interface GroupIconPickerProps {
  group: PasswordGroup | null
  onClose: () => void
}

/** Picks the picture a group shows instead of the default folder. An empty id restores the default. */
export function GroupIconPicker({ group, onClose }: GroupIconPickerProps) {
  const updateGroup = usePasswordVaultStore((s) => s.updateGroup)
  const [saving, setSaving] = useState(false)

  const choose = async (icon: string) => {
    if (!group) return
    setSaving(true)
    try {
      await updateGroup(group.id, { icon })
      useUi.getState().toast({ title: t('tools.password.group.icon_saved'), tone: 'success' })
      onClose()
    } catch (err) {
      useUi.getState().toast({
        title: err instanceof Error ? err.message : t('common.save_failed'),
        tone: 'danger',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={Boolean(group)}
      onClose={onClose}
      title={t('tools.password.group.set_icon')}
      width={420}
    >
      <div className="grid grid-cols-4 gap-2 pt-1">
        {GROUP_ICONS.map(({ id, icon: Icon }) => {
          const active = group?.icon === id
          return (
            <button
              key={id}
              type="button"
              aria-pressed={active}
              aria-label={id}
              data-testid={`group-icon-${id}`}
              disabled={saving}
              onClick={() => void choose(id)}
              className={cn(
                'flex h-16 items-center justify-center rounded-[var(--r-md)] border transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
                active
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
                  : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
              )}
            >
              <Icon size={22} aria-hidden="true" />
            </button>
          )
        })}
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-[var(--border-subtle)] pt-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={saving}
          onClick={() => void choose('')}
          data-testid="group-icon-clear"
        >
          {t('tools.password.group.icon_clear')}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={saving}>
          {t('common.cancel')}
        </Button>
      </div>
    </Modal>
  )
}
