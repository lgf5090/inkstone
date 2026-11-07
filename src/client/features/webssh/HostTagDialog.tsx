/**
 * Adds tags to the hosts selected in the list. Existing tags are offered as checkboxes and a new
 * name can be typed in; removal stays in the host editor, so one batch action never silently drops a
 * label another reader set on a host.
 */
import { useState } from 'react'
import type { WebsshHostTagCount } from '@shared/webssh/types'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { Checkbox, Input, commitOnEnter } from '../../components/form'
import { Modal } from '../../components/overlay'
import { X } from 'lucide-react'

export function HostTagDialog({
  open,
  existingTags,
  hostCount,
  onClose,
  onConfirm,
}: {
  open: boolean
  existingTags: readonly WebsshHostTagCount[]
  hostCount: number
  onClose: () => void
  onConfirm: (tags: string[]) => void
}) {
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [draft, setDraft] = useState('')

  const close = () => {
    setChosen(new Set())
    setDraft('')
    onClose()
  }

  const addDraft = () => {
    const tag = draft.trim()
    if (!tag) return
    setChosen((current) => new Set(current).add(tag))
    setDraft('')
  }

  const confirm = () => {
    if (chosen.size === 0) return
    onConfirm([...chosen])
    setChosen(new Set())
    setDraft('')
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={t('webssh.tags.title')}
      description={t('webssh.tags.description', { count: hostCount })}
      width={440}
      footer={(
        <>
          <Button variant="ghost" onClick={close}>{t('webssh.actions.cancel')}</Button>
          <Button variant="primary" disabled={chosen.size === 0} onClick={confirm}>{t('webssh.actions.apply')}</Button>
        </>
      )}
    >
      <div className="space-y-3">
        {existingTags.length > 0 && (
          <div role="group" aria-label={t('webssh.tags.existing')} className="grid max-h-56 grid-cols-2 gap-1 overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2">
            {existingTags.map((tag) => (
              <Checkbox
                key={tag.name}
                checked={chosen.has(tag.name)}
                ariaLabel={t('webssh.tags.choose', { name: tag.name })}
                label={<span className="truncate">{tag.name}<span className="ms-1 text-[var(--text-quaternary)]">{tag.count}</span></span>}
                onChange={(next) => {
                  setChosen((current) => {
                    const updated = new Set(current)
                    if (next) updated.add(tag.name)
                    else updated.delete(tag.name)
                    return updated
                  })
                }}
              />
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => commitOnEnter(event, addDraft)}
              placeholder={t('webssh.tags.new_placeholder')}
              aria-label={t('webssh.tags.new_label')}
            />
          </div>
          <Button variant="secondary" disabled={!draft.trim()} onClick={addDraft}>{t('webssh.tags.add')}</Button>
        </div>
        {chosen.size > 0 && (
          <div className="flex flex-wrap gap-1">
            {[...chosen].map((tag) => (
              <span key={tag} className="inline-flex items-center gap-1 rounded-[var(--r-xs)] bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-11)] text-[var(--text-secondary)]">
                {tag}
                <IconButton
                  label={t('webssh.tags.remove', { name: tag })}
                  size="xs"
                  onClick={() => setChosen((current) => {
                    const next = new Set(current)
                    next.delete(tag)
                    return next
                  })}
                >
                  <X size={10} aria-hidden="true" />
                </IconButton>
              </span>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
