import { useEffect, useState } from 'react'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Checkbox, Input, Segmented } from '../../components/form'
import { Modal } from '../../components/overlay'
import {
  DEFAULT_OFFICE_PREFS,
  OFFICE_AUTOSAVE_DELAYS,
  OFFICE_BUILDS,
  OFFICE_VIEW_MODES,
  type OfficeBuild,
  type OfficePrefs,
  type OfficeViewMode,
} from './office-prefs'

export interface OfficeSettingsDialogProps {
  open: boolean
  prefs: OfficePrefs
  onClose: () => void
  onSave: (patch: Partial<OfficePrefs>) => void
}

function delayLabel(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`
}

/**
 * The reader's own decisions about the Office tab.
 *
 * Two of these change what the editors load rather than how they look: the build (Pro package set) and
 * the licence. Both are applied on the next mount, so the dialog says so instead of pretending a
 * running editor can switch underneath the reader.
 */
export function OfficeSettingsDialog({ open, prefs, onClose, onSave }: OfficeSettingsDialogProps) {
  const [draft, setDraft] = useState<OfficePrefs>(prefs)

  useEffect(() => {
    if (open) setDraft(prefs)
  }, [open, prefs])

  const patch = (next: Partial<OfficePrefs>) => setDraft((current) => ({ ...current, ...next }))
  const rebuilds = draft.build !== prefs.build || draft.license !== prefs.license

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('office.settings.title')}
      description={t('office.settings.description')}
      width={620}
      footer={(
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setDraft({ ...DEFAULT_OFFICE_PREFS, ...{ build: draft.build, license: draft.license } })}>
            {t('office.settings.reset')}
          </Button>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('office.settings.cancel')}</Button>
          <Button size="sm" variant="primary" onClick={() => { onSave(draft); onClose() }}>
            {t('office.settings.save')}
          </Button>
        </div>
      )}
    >
      <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-2">
          <h3 className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{t('office.settings.build.title')}</h3>
          <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('office.settings.build.hint')}</p>
          <Segmented<OfficeBuild>
            value={draft.build}
            size="sm"
            label={t('office.settings.build.title')}
            options={OFFICE_BUILDS.map((build) => ({ value: build, label: t(build === 'full' ? 'office.settings.build.full' : 'office.settings.build.lite') }))}
            onChange={(build) => patch({ build })}
          />
          <label className="flex flex-col gap-1.5">
            <span className="text-[length:var(--text-11)] text-[var(--text-secondary)]">{t('office.settings.license.label')}</span>
            <Input
              type="password"
              value={draft.license}
              disabled={draft.build === 'lite'}
              placeholder={t('office.settings.license.placeholder')}
              aria-label={t('office.settings.license.label')}
              onChange={(event) => patch({ license: event.target.value })}
            />
            <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {draft.build === 'lite'
                ? t('office.settings.license.lite')
                : draft.license.trim()
                  ? t('office.settings.license.set')
                  : t('office.settings.license.empty')}
            </span>
          </label>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{t('office.settings.editing.title')}</h3>
          <label className="flex items-center justify-between gap-3">
            <span className="text-[length:var(--text-11)] text-[var(--text-secondary)]">{t('office.settings.autosave')}</span>
            <Segmented<string>
              value={String(draft.autosaveDelayMs)}
              size="sm"
              label={t('office.settings.autosave')}
              options={OFFICE_AUTOSAVE_DELAYS.map((ms) => ({ value: String(ms), label: delayLabel(ms) }))}
              onChange={(value) => patch({ autosaveDelayMs: Number(value) })}
            />
          </label>
          <label className="flex items-center justify-between gap-3">
            <span className="text-[length:var(--text-11)] text-[var(--text-secondary)]">{t('office.settings.restore_tabs')}</span>
            <Checkbox checked={draft.restoreTabs} onChange={(checked) => patch({ restoreTabs: checked })} label={t('office.settings.restore_tabs')} />
          </label>
          <label className="flex items-center justify-between gap-3">
            <span className="text-[length:var(--text-11)] text-[var(--text-secondary)]">{t('office.settings.split_default')}</span>
            <Checkbox checked={draft.openSplitByDefault} onChange={(checked) => patch({ openSplitByDefault: checked })} label={t('office.settings.split_default')} />
          </label>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{t('office.settings.listing.title')}</h3>
          <label className="flex items-center justify-between gap-3">
            <span className="text-[length:var(--text-11)] text-[var(--text-secondary)]">{t('office.settings.default_view')}</span>
            <Segmented<OfficeViewMode>
              value={draft.viewMode}
              size="sm"
              label={t('office.settings.default_view')}
              options={OFFICE_VIEW_MODES.map((mode) => ({ value: mode, label: t(`office.view.${mode}` as 'office.view.list') }))}
              onChange={(viewMode) => patch({ viewMode })}
            />
          </label>
          <label className="flex items-center justify-between gap-3">
            <span className="text-[length:var(--text-11)] text-[var(--text-secondary)]">{t('office.settings.checkboxes')}</span>
            <Checkbox checked={draft.showCheckboxes} onChange={(checked) => patch({ showCheckboxes: checked })} label={t('office.settings.checkboxes')} />
          </label>
        </section>

        {rebuilds && (
          <p role="status" className="rounded-[var(--r-sm)] bg-[var(--bg-sunken)] px-2 py-1.5 text-[length:var(--text-11)] text-[var(--text-secondary)]">
            {t('office.settings.rebuild')}
          </p>
        )}
      </div>
    </Modal>
  )
}
