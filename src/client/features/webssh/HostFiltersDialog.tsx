/**
 * The advanced filter sheet: provider, connection state, pinned, and two date ranges.
 *
 * Every value is a plain piece of the URL query, so the same screen can be shared as a link. The
 * dialog edits a draft and only writes it back on Apply, which keeps half-typed dates out of the list.
 */
import { useEffect, useState } from 'react'
import type { WebsshHostFilters, WebsshProvider, WebsshHostStatusFilter } from '@shared/webssh/types'
import { WEBSSH_BUILTIN_PROVIDERS } from '@shared/webssh/providers'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Field, Switch } from '../../components/form'
import { Modal } from '../../components/overlay'
import { SelectMenu } from '../../components/select-menu'
import { DatePicker } from '../../components/date-picker'
import { providerText } from './HostIcon'

export function HostFiltersDialog({
  open,
  filters,
  providers,
  onClose,
  onApply,
}: {
  open: boolean
  filters: WebsshHostFilters
  providers: readonly WebsshProvider[]
  onClose: () => void
  onApply: (filters: WebsshHostFilters) => void
}) {
  const [draft, setDraft] = useState<WebsshHostFilters>(filters)

  useEffect(() => {
    if (open) setDraft(filters)
  }, [open, filters])

  const patch = (next: Partial<WebsshHostFilters>) => setDraft((current) => ({ ...current, ...next }))

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('webssh.filter.title')}
      description={t('webssh.filter.description')}
      width={560}
      footer={(
        <>
          <Button variant="ghost" onClick={() => setDraft({ provider: '', pinned: false, status: '', connected: { from: '', to: '' }, created: { from: '', to: '' } })}>
            {t('webssh.filter.reset')}
          </Button>
          <Button variant="ghost" onClick={onClose}>{t('webssh.actions.cancel')}</Button>
          <Button variant="primary" onClick={() => { onApply(draft); onClose() }}>{t('webssh.filter.apply')}</Button>
        </>
      )}
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('webssh.filter.provider')}>
            <SelectMenu
              label={t('webssh.filter.provider')}
              value={draft.provider}
              onChange={(provider) => patch({ provider })}
              options={[
                { value: '', label: t('webssh.filter.all_providers') },
                ...WEBSSH_BUILTIN_PROVIDERS.map((provider) => ({ value: provider.id, label: providerText(provider.id, providers) })),
                ...providers.filter((provider) => provider.id.startsWith('custom:')).map((provider) => ({ value: provider.id, label: provider.label })),
              ]}
              searchable
              width={240}
            />
          </Field>
          <Field label={t('webssh.filter.status')}>
            <SelectMenu
              label={t('webssh.filter.status')}
              value={draft.status}
              onChange={(status) => patch({ status: status as WebsshHostStatusFilter })}
              options={[
                { value: '', label: t('webssh.filter.status_any') },
                { value: 'connected', label: t('webssh.filter.status_connected') },
                { value: 'never', label: t('webssh.filter.status_never') },
              ]}
              width={200}
            />
          </Field>
        </div>

        <label className="flex items-center justify-between gap-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-3 py-2">
          <span className="text-[length:var(--text-12-5)] text-[var(--text-secondary)]">{t('webssh.filter.pinned_only')}</span>
          <Switch checked={draft.pinned} onChange={(pinned) => patch({ pinned })} label={t('webssh.filter.pinned_only')} />
        </label>

        <section aria-labelledby="webssh-filter-connected" className="space-y-2">
          <p id="webssh-filter-connected" className="text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">{t('webssh.filter.connected_range')}</p>
          <div className="grid grid-cols-2 gap-2">
            <DatePicker label={t('webssh.filter.from')} value={draft.connected.from} onChange={(from) => patch({ connected: { ...draft.connected, from } })} />
            <DatePicker label={t('webssh.filter.to')} value={draft.connected.to} onChange={(to) => patch({ connected: { ...draft.connected, to } })} />
          </div>
        </section>

        <section aria-labelledby="webssh-filter-created" className="space-y-2">
          <p id="webssh-filter-created" className="text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">{t('webssh.filter.created_range')}</p>
          <div className="grid grid-cols-2 gap-2">
            <DatePicker label={t('webssh.filter.from')} value={draft.created.from} onChange={(from) => patch({ created: { ...draft.created, from } })} />
            <DatePicker label={t('webssh.filter.to')} value={draft.created.to} onChange={(to) => patch({ created: { ...draft.created, to } })} />
          </div>
        </section>
      </div>
    </Modal>
  )
}
