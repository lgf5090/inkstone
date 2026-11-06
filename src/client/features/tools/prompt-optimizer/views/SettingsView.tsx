/**
 * Tool settings: which model answers, how drafts behave, and the data lifecycle.
 */

import { useEffect, useState } from 'react'
import { Database, Download, RotateCcw, Trash2, Upload } from 'lucide-react'
import { Button, Badge } from '../../../../components/primitives'
import { Field, Input, Switch, Textarea } from '../../../../components/form'
import { SelectMenu } from '../../../../components/select-menu'
import { confirm, Modal } from '../../../../components/overlay'
import { t } from '../../../../lib/i18n'
import { useUiStore } from '../../../../lib/ui-store'
import { usePromptOptimizerStore } from '../store'

export function SettingsView() {
  const settings = usePromptOptimizerStore((s) => s.settings)
  const models = usePromptOptimizerStore((s) => s.models)
  const stats = usePromptOptimizerStore((s) => s.stats)
  const backups = usePromptOptimizerStore((s) => s.backups)
  const saveSettings = usePromptOptimizerStore((s) => s.saveSettings)
  const createBackup = usePromptOptimizerStore((s) => s.createBackup)
  const restoreBackup = usePromptOptimizerStore((s) => s.restoreBackup)
  const deleteBackup = usePromptOptimizerStore((s) => s.deleteBackup)
  const exportData = usePromptOptimizerStore((s) => s.exportData)
  const importData = usePromptOptimizerStore((s) => s.importData)
  const clearAll = usePromptOptimizerStore((s) => s.clearAll)
  const refreshStats = usePromptOptimizerStore((s) => s.refreshStats)
  const refreshBackups = usePromptOptimizerStore((s) => s.refreshBackups)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [retention, setRetention] = useState('0')
  const [groups, setGroups] = useState('2')

  useEffect(() => {
    void Promise.all([refreshStats(), refreshBackups()])
  }, [refreshStats, refreshBackups])

  useEffect(() => {
    if (!settings) return
    setRetention(String(settings.historyRetentionDays))
    setGroups(String(settings.testGroupDefault))
  }, [settings])

  if (!settings) return null

  const textOptions = [
    { value: '', label: t('tools.prompt_optimizer.common.none') },
    ...models.text.map((model) => ({ value: model.id, label: model.label || model.model })),
  ]
  const imageOptions = [
    { value: '', label: t('tools.prompt_optimizer.common.none') },
    ...models.image.map((model) => ({ value: model.id, label: model.label || model.model })),
  ]

  return (
    <div className="h-full min-h-0 overflow-y-auto p-4">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <header>
          <h1 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">
            {t('tools.prompt_optimizer.settings.title')}
          </h1>
          <p className="mt-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {t('tools.prompt_optimizer.settings.model_hint')}
          </p>
        </header>

        <section className="flex flex-col gap-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
          <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
            {t('tools.prompt_optimizer.settings.models')}
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('tools.prompt_optimizer.settings.default_model')}>
              <SelectMenu
                label={t('tools.prompt_optimizer.settings.default_model')}
                value={settings.defaultTextModelId}
                options={textOptions}
                onChange={(value) => void saveSettings({ defaultTextModelId: value })}
                width={300}
              />
            </Field>
            <Field label={t('tools.prompt_optimizer.settings.evaluation_model')}>
              <SelectMenu
                label={t('tools.prompt_optimizer.settings.evaluation_model')}
                value={settings.evaluationModelId}
                options={textOptions}
                onChange={(value) => void saveSettings({ evaluationModelId: value })}
                width={300}
              />
            </Field>
            <Field label={t('tools.prompt_optimizer.settings.vision_model')}>
              <SelectMenu
                label={t('tools.prompt_optimizer.settings.vision_model')}
                value={settings.imageRecognitionModelId}
                options={textOptions}
                onChange={(value) => void saveSettings({ imageRecognitionModelId: value })}
                width={300}
              />
            </Field>
            <Field label={t('tools.prompt_optimizer.settings.image_model')}>
              <SelectMenu
                label={t('tools.prompt_optimizer.settings.image_model')}
                value={settings.imageModelId}
                options={imageOptions}
                onChange={(value) => void saveSettings({ imageModelId: value })}
                width={300}
              />
            </Field>
          </div>
        </section>

        <section className="flex flex-col gap-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
          <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
            {t('tools.prompt_optimizer.settings.workspace')}
          </h2>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">
                {t('tools.prompt_optimizer.settings.autosave')}
              </p>
              <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                {t('tools.prompt_optimizer.settings.autosave_hint')}
              </p>
            </div>
            <Switch
              checked={settings.autosaveDrafts}
              onChange={(checked) => void saveSettings({ autosaveDrafts: checked })}
              label={t('tools.prompt_optimizer.settings.autosave')}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('tools.prompt_optimizer.settings.test_groups')}>
              <div className="flex items-end gap-2">
                <Input value={groups} onChange={(event) => setGroups(event.target.value)} inputMode="numeric" className="w-20" />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void saveSettings({ testGroupDefault: Math.max(1, Math.min(8, Number(groups) || 1)) })}
                >
                  {t('tools.prompt_optimizer.common.save')}
                </Button>
              </div>
            </Field>
            <Field label={t('tools.prompt_optimizer.settings.history_retention')} hint={t('tools.prompt_optimizer.settings.history_retention_hint')}>
              <div className="flex items-end gap-2">
                <Input value={retention} onChange={(event) => setRetention(event.target.value)} inputMode="numeric" className="w-20" />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void saveSettings({ historyRetentionDays: Math.max(0, Math.min(3650, Number(retention) || 0)) })}
                >
                  {t('tools.prompt_optimizer.common.save')}
                </Button>
              </div>
            </Field>
          </div>
        </section>

        <section className="flex flex-col gap-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
          <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
            {t('tools.prompt_optimizer.settings.stats')}
          </h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              [t('tools.prompt_optimizer.settings.stats_chains'), stats?.historyChains],
              [t('tools.prompt_optimizer.settings.stats_records'), stats?.historyRecords],
              [t('tools.prompt_optimizer.settings.stats_favorites'), stats?.favorites],
              [t('tools.prompt_optimizer.settings.stats_templates'), stats?.templates],
              [t('tools.prompt_optimizer.settings.stats_evaluations'), stats?.evaluations],
              [t('tools.prompt_optimizer.settings.stats_assets'), stats?.assets],
              [t('tools.prompt_optimizer.settings.stats_backups'), stats?.backups],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-[var(--r-sm)] bg-[var(--bg-raised)] p-2">
                <div className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{label}</div>
                <div className="text-[length:var(--text-15)] font-semibold tabular text-[var(--text-primary)]">{value ?? 0}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
          <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
            {t('tools.prompt_optimizer.settings.data')}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => void exportData('json')}>
              <Download size={13} />
              {t('tools.prompt_optimizer.settings.export_json')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void exportData('txt')}>
              <Download size={13} />
              {t('tools.prompt_optimizer.settings.export_txt')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setImportOpen(true)}>
              <Upload size={13} />
              {t('tools.prompt_optimizer.settings.import')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void createBackup()}>
              <Database size={13} />
              {t('tools.prompt_optimizer.settings.backup')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => void confirm({ title: t('tools.prompt_optimizer.settings.clear_confirm'), tone: 'danger' })
                .then((ok) => { if (ok) void clearAll() })}
            >
              <Trash2 size={13} />
              {t('tools.prompt_optimizer.settings.clear')}
            </Button>
          </div>
          <div className="flex flex-col gap-1">
            {backups.length === 0 ? (
              <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('tools.prompt_optimizer.settings.no_backups')}</p>
            ) : backups.map((backup) => (
              <div key={backup.id} className="flex items-center gap-2 rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-2 py-1">
                <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-primary)]">{backup.filename}</span>
                <Badge tone="neutral">{`${Math.round(backup.bytes / 1024)} KB`}</Badge>
                <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{new Date(backup.createdAt).toLocaleString()}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void confirm({
                    title: t('tools.prompt_optimizer.settings.restore_confirm').replace('{filename}', backup.filename),
                    tone: 'danger',
                  }).then((ok) => { if (ok) void restoreBackup(backup.id) })}
                >
                  <RotateCcw size={12} />
                  {t('tools.prompt_optimizer.settings.restore')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void deleteBackup(backup.id)}>
                  <Trash2 size={12} />
                  {t('tools.prompt_optimizer.settings.delete_backup')}
                </Button>
              </div>
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
          <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
            {t('tools.prompt_optimizer.settings.about')}
          </h2>
          <p className="text-[length:var(--text-12)] leading-relaxed text-[var(--text-secondary)]">
            {t('tools.prompt_optimizer.settings.about_body')}
          </p>
          <div className="flex flex-wrap gap-2">
            <Badge tone="neutral">{'prompt-optimizer 2.15.1'}</Badge>
            <Badge tone="neutral">{'AGPL-3.0-only'}</Badge>
            <Badge tone="neutral">{'Inkstone Tools'}</Badge>
          </div>
        </section>
      </div>

      <Modal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title={t('tools.prompt_optimizer.settings.import')}
        width={560}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setImportOpen(false)}>{t('tools.prompt_optimizer.common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={!importText.trim()}
              onClick={() => {
                try {
                  const parsed = JSON.parse(importText) as unknown
                  void importData(parsed).then(() => {
                    setImportOpen(false)
                    setImportText('')
                  })
                } catch {
                  useUiStore.getState().toast(t('tools.prompt_optimizer.errors.invalid_json'), 'error')
                }
              }}
            >
              {t('tools.prompt_optimizer.common.import')}
            </Button>
          </>
        )}
      >
        <Field label={t('tools.prompt_optimizer.settings.import_hint')}>
          <Textarea value={importText} rows={10} onChange={(event) => setImportText(event.target.value)} className="font-mono text-[length:var(--text-12)]" />
        </Field>
      </Modal>
    </div>
  )
}
