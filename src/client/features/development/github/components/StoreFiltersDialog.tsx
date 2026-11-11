import { Languages, Package, RefreshCw, RotateCcw, Tags } from 'lucide-react'
import type { GithubStoreFilters } from '@shared/development/github/types'
import { DEFAULT_STORE_FILTERS, GITHUB_TRACKED_OPTIONS, GITHUB_UPDATED_OPTIONS, GITHUB_UPDATE_FILTER_OPTIONS } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { Button } from '../../../../components/primitives'
import { Checkbox, Field, Input, Segmented } from '../../../../components/form'
import { Modal } from '../../../../components/overlay'
import { SelectMenu } from '../../../../components/select-menu'

export function StoreFiltersDialog({
  open,
  onClose,
  filters,
  onChange,
}: {
  open: boolean
  onClose: () => void
  filters: GithubStoreFilters
  onChange: (next: Partial<GithubStoreFilters>) => void
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('development.github.store.filters.title')}
      description={t('development.github.store.filters.desc')}
      width={560}
      footer={
        <>
          <Button variant="secondary" onClick={() => onChange(DEFAULT_STORE_FILTERS)}><RotateCcw size={12} />{t('development.github.store.filters.reset')}</Button>
          <Button onClick={onClose}>{t('development.github.store.filters.done')}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t('development.github.store.filters.language')} hint={t('development.github.store.filters.language_hint')}>
          <div className="relative">
            <Languages size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-quaternary)]" />
            <Input value={filters.language} onChange={(event) => onChange({ language: event.target.value })} placeholder={t('development.github.store.filters.language_placeholder')} className="h-8 pl-8" maxLength={64} />
          </div>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('development.github.store.filters.updated')}>
            <SelectMenu
              label={t('development.github.store.filters.updated')}
              value={filters.updated}
              options={GITHUB_UPDATED_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
              onChange={(value) => onChange({ updated: value })}
            />
          </Field>
          <Field label={t('development.github.store.filters.tracked')}>
            <SelectMenu
              label={t('development.github.store.filters.tracked')}
              value={filters.tracked}
              options={GITHUB_TRACKED_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
              onChange={(value) => onChange({ tracked: value })}
            />
          </Field>
        </div>
        <Field label={t('development.github.store.filters.update_status')} hint={t('development.github.store.filters.update_status_hint')}>
          <Segmented
            value={filters.updateStatus}
            onChange={(value) => onChange({ updateStatus: value })}
            label={t('development.github.store.filters.update_status')}
            options={GITHUB_UPDATE_FILTER_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
          />
        </Field>
        <label className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-2 text-[length:var(--text-12)]">
          <Checkbox checked={filters.installerOnly} onChange={(checked) => onChange({ installerOnly: checked })} ariaLabel={t('development.github.store.filters.installer')} />
          <Package size={13} className="text-[var(--text-tertiary)]" />
          <span className="min-w-0 flex-1">{t('development.github.store.filters.installer')}</span>
        </label>
        <p className="flex items-center gap-1.5 text-[length:var(--text-10)] text-[var(--text-quaternary)]">
          <Tags size={11} />{t('development.github.store.filters.combine_hint')}
          <RefreshCw size={11} className="ml-auto" />
        </p>
      </div>
    </Modal>
  )
}
