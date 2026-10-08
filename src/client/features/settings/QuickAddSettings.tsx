/**
 * Settings → Automation: the whole QuickAdd feature in one page.
 *
 * The formats an author writes are the reason this page lives in the app's own settings sheet: a
 * capture that inserts a note into the middle of a heading list should look like any other preference,
 * not like a plugin window dropped on top. Everything here edits the account's choice library, which
 * the store pushes to the server on a debounce — so the page writes through the store, never to the
 * endpoint directly, and a reload of the section shows the same data another tab just saved.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { QUICKADD_LIMITS, type QuickAddOnePageMode, type QuickAddPeriod } from '@shared/quickadd'
import { Button, IconButton } from '../../components/primitives'
import { Field, Input, Select, SettingRow, Switch, Textarea } from '../../components/form'
import { confirm } from '../../components/overlay'
import { t, useLocale } from '../../lib/i18n'
import type { MessageKey } from '@shared/locales/en-US'
import { previewDateFormat } from '../../lib/quickadd/preview'
import { useNoteTemplates } from '../../store/note-templates'
import { useQuickAdd } from '../../store/quickadd'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { QuickAddChoiceList } from '../quickadd/choice-list'

const PERIODS: QuickAddPeriod[] = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly']

const PERIOD_KEYS = {
  daily: 'settings.quickadd_period_daily',
  weekly: 'settings.quickadd_period_weekly',
  monthly: 'settings.quickadd_period_monthly',
  quarterly: 'settings.quickadd_period_quarterly',
  yearly: 'settings.quickadd_period_yearly',
} as const satisfies Record<QuickAddPeriod, MessageKey>

export function QuickAddSettings() {
  const settings = useQuickAdd((state) => state.settings)
  const save = useQuickAdd((state) => state.saveSettings)
  const importLibrary = useQuickAdd((state) => state.importLibrary)
  const exportText = useQuickAdd((state) => state.exportText)
  const globalVars = settings.globalVars
  const user = useSession((state) => state.user)
  const owner = user?.id ?? ''
  const hydrateTemplates = useNoteTemplates((state) => state.hydrate)
  const templates = useNoteTemplates((state) => state.templates)
  const toast = useUi((state) => state.toast)
  const locale = useLocale()
  const [transport, setTransport] = useState('')
  const [draftVar, setDraftVar] = useState({ name: '', value: '' })
  const [mode, setMode] = useState<'merge' | 'replace'>('merge')

  useEffect(() => {
    if (!owner) return
    void hydrateTemplates(owner).catch(() => {})
  }, [owner, hydrateTemplates])

  const datePreview = useMemo(() => previewDateFormat(settings.dateFormat, locale), [locale, settings.dateFormat])
  const timePreview = useMemo(() => previewDateFormat(settings.timeFormat, locale), [locale, settings.timeFormat])

  const setVar = useCallback((index: number, next: { name: string; value: string }) => {
    save({ globalVars: globalVars.map((entry, at) => (at === index ? next : entry)) })
  }, [globalVars, save])

  // A variable with no name is dropped by the library normalizer, so the new one is drafted here
  // and only joins the list when it has something to be called.
  const duplicateVar = useMemo(
    () => globalVars.some((entry) => entry.name.toLowerCase() === draftVar.name.trim().toLowerCase()),
    [draftVar.name, globalVars],
  )
  const canAddVar = draftVar.name.trim() !== '' && !duplicateVar && globalVars.length < QUICKADD_LIMITS.maxGlobalVars
  const addVar = useCallback(() => {
    const name = draftVar.name.trim()
    if (!name || duplicateVar || globalVars.length >= QUICKADD_LIMITS.maxGlobalVars) return
    save({ globalVars: [...globalVars, { name, value: draftVar.value }] })
    setDraftVar({ name: '', value: '' })
  }, [draftVar, duplicateVar, globalVars, save])

  const dropVar = useCallback((index: number) => {
    save({ globalVars: globalVars.filter((_, at) => at !== index) })
  }, [globalVars, save])

  const runImport = useCallback(() => {
    const result = importLibrary(transport, mode)
    setTransport('')
    if (result.error) {
      toast({ title: t(result.error as MessageKey), tone: 'danger' })
      return
    }
    toast({
      title: t('quickadd.import_result', { value0: String(result.added), value1: String(result.skipped) }),
      tone: result.added > 0 ? 'success' : 'default',
    })
  }, [importLibrary, mode, toast, transport])

  return (
    <div className="space-y-8">
      <section>
        <SettingRow title={t('settings.quickadd_enabled')} description={t('settings.quickadd_enabled_desc')}>
          <Switch label={t('settings.quickadd_enabled')} checked={settings.enabled} onChange={(enabled) => save({ enabled })}/>
        </SettingRow>
        <SettingRow title={t('settings.quickadd_notifications')} description={t('settings.quickadd_notifications_desc')}>
          <Switch label={t('settings.quickadd_notifications')} checked={settings.notifications} onChange={(notifications) => save({ notifications })}/>
        </SettingRow>
        <SettingRow title={t('settings.quickadd_cancel_notice')} description={t('settings.quickadd_cancel_notice_desc')}>
          <Switch label={t('settings.quickadd_cancel_notice')} checked={settings.cancelNotice} onChange={(cancelNotice) => save({ cancelNotice })}/>
        </SettingRow>
        <SettingRow title={t('settings.quickadd_selection_as_value')} description={t('settings.quickadd_selection_as_value_desc')}>
          <Switch label={t('settings.quickadd_selection_as_value')} checked={settings.selectionAsValue} onChange={(selectionAsValue) => save({ selectionAsValue })}/>
        </SettingRow>
        <SettingRow title={t('settings.quickadd_drafts')} description={t('settings.quickadd_drafts_desc')}>
          <Switch label={t('settings.quickadd_drafts')} checked={settings.drafts} onChange={(drafts) => save({ drafts })}/>
        </SettingRow>
        <SettingRow title={t('quickadd.field_one_page')} description={t('quickadd.field_one_page_desc')}>
          <Select aria-label={t('quickadd.field_one_page')} value={settings.onePage} onChange={(event) => save({ onePage: event.target.value as QuickAddOnePageMode })}>
            <option value="auto">{t('quickadd.one_page_auto')}</option>
            <option value="always">{t('quickadd.one_page_always')}</option>
            <option value="never">{t('quickadd.one_page_never')}</option>
          </Select>
        </SettingRow>
        <SettingRow title={t('settings.quickadd_default_folder')} description={t('settings.quickadd_default_folder_desc')}>
          <Input aria-label={t('settings.quickadd_default_folder')} className="w-[220px] max-w-full" value={settings.defaultFolder} onChange={(event) => save({ defaultFolder: event.target.value })}/>
        </SettingRow>
        <SettingRow title={t('settings.quickadd_date_format')} description={`${t('quickadd.preview_label')} ${datePreview}`}>
          <Input aria-label={t('settings.quickadd_date_format')} className="w-[180px] max-w-full font-mono" value={settings.dateFormat} onChange={(event) => save({ dateFormat: event.target.value })}/>
        </SettingRow>
        <SettingRow title={t('settings.quickadd_time_format')} description={`${t('quickadd.preview_label')} ${timePreview}`}>
          <Input aria-label={t('settings.quickadd_time_format')} className="w-[180px] max-w-full font-mono" value={settings.timeFormat} onChange={(event) => save({ timeFormat: event.target.value })}/>
        </SettingRow>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 data-setting-title={t('settings.quickadd_global_vars')} className="text-[13px] font-semibold text-[var(--text-primary)]">{t('settings.quickadd_global_vars')}</h3>
        </div>
        <p className="text-[11.5px] text-[var(--text-quaternary)]">{t('settings.quickadd_global_vars_desc')}</p>
        {globalVars.length === 0 && <p className="text-[12px] text-[var(--text-quaternary)]">{t('settings.quickadd_no_vars')}</p>}
        {globalVars.map((entry, index) => (
          <div key={entry.name} className="flex items-end gap-2">
            <span className="w-[150px] shrink-0 truncate py-2 font-mono text-[12.5px] text-[var(--text-secondary)]" title={entry.name}>
              {entry.name}
            </span>
            <Field label={t('quickadd.var_value')} className="flex-1">
              <Input
                aria-label={`${t('quickadd.var_value')} ${index + 1}`}
                value={entry.value}
                maxLength={QUICKADD_LIMITS.maxFormatLength}
                onChange={(event) => setVar(index, { ...entry, value: event.target.value })}/>
            </Field>
            <IconButton label={t('common.delete')} size="sm" variant="danger" onClick={() => dropVar(index)}>
              <Trash2 size={13}/>
            </IconButton>
          </div>
        ))}
        <div className="flex items-end gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2">
          <Field label={t('quickadd.var_name')} className="w-[170px] shrink-0">
            <Input
              aria-label={t('quickadd.var_name')}
              value={draftVar.name}
              maxLength={60}
              className="font-mono"
              onChange={(event) => setDraftVar({ ...draftVar, name: event.target.value })}/>
          </Field>
          <Field
            label={t('quickadd.var_value')}
            hint={duplicateVar ? t('settings.quickadd_var_taken') : undefined}
            className="min-w-0 flex-1">
            <Input
              aria-label={t('quickadd.var_value')}
              value={draftVar.value}
              maxLength={QUICKADD_LIMITS.maxFormatLength}
              onChange={(event) => setDraftVar({ ...draftVar, value: event.target.value })}/>
          </Field>
          <Button size="sm" onClick={addVar} disabled={!canAddVar}>
            <Plus size={13}/>{t('settings.quickadd_add_var')}
          </Button>
        </div>
      </section>

      <section className="space-y-2">
        <h3 data-setting-title={t('settings.quickadd_periodic')} className="text-[13px] font-semibold text-[var(--text-primary)]">{t('settings.quickadd_periodic')}</h3>
        <p className="text-[11.5px] text-[var(--text-quaternary)]">{t('settings.quickadd_periodic_desc')}</p>
        {PERIODS.map((period) => (
          <div key={period} role="group" aria-label={t(PERIOD_KEYS[period])} className="grid gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2.5 md:grid-cols-3">
            <Field label={t(PERIOD_KEYS[period])}>
              <Input
                aria-label={t(PERIOD_KEYS[period])}
                value={settings.periodic[period].folder}
                onChange={(event) => save({ periodic: { ...settings.periodic, [period]: { ...settings.periodic[period], folder: event.target.value } } })}/>
            </Field>
            <Field label={t('quickadd.period_format')}>
              <Input
                aria-label={`${t('quickadd.period_format')} ${period}`}
                value={settings.periodic[period].format}
                className="font-mono"
                onChange={(event) => save({ periodic: { ...settings.periodic, [period]: { ...settings.periodic[period], format: event.target.value } } })}/>
            </Field>
            <Field label={t('quickadd.period_template')}>
              <Select
                aria-label={`${t('quickadd.period_template')} ${period}`}
                value={settings.periodic[period].templateId ?? ''}
                onChange={(event) => save({ periodic: { ...settings.periodic, [period]: { ...settings.periodic[period], templateId: event.target.value === '' ? null : event.target.value } } })}>
                <option value="">{t('quickadd.no_template')}</option>
                {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
              </Select>
            </Field>
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <h3 data-setting-title={t('settings.quickadd_choices')} className="text-[13px] font-semibold text-[var(--text-primary)]">{t('settings.quickadd_choices')}</h3>
        <QuickAddChoiceList/>
      </section>

      <section className="space-y-2">
        <h3 data-setting-title={t('settings.quickadd_transport')} className="text-[13px] font-semibold text-[var(--text-primary)]">{t('settings.quickadd_transport')}</h3>
        <p className="text-[11.5px] text-[var(--text-quaternary)]">{t('settings.quickadd_transport_desc')}</p>
        <Textarea
          aria-label={t('settings.quickadd_transport')}
          value={transport}
          rows={6}
          spellCheck={false}
          className="w-full font-mono text-[12px]"
          onChange={(event) => setTransport(event.target.value.slice(0, QUICKADD_LIMITS.maxPayloadLength))}/>
        <div className="flex flex-wrap items-center gap-2">
          <Select aria-label={t('quickadd.import_mode')} value={mode} onChange={(event) => setMode(event.target.value as 'merge' | 'replace')}>
            <option value="merge">{t('quickadd.import_merge')}</option>
            <option value="replace">{t('quickadd.import_replace')}</option>
          </Select>
          <Button size="sm" disabled={transport.trim() === ''} onClick={() => void runImport()}>{t('quickadd.import')}</Button>
          <Button
            size="sm"
            onClick={async () => {
              if (mode === 'replace') {
                const ok = await confirm({
                  title: t('quickadd.export_replace_title'),
                  description: t('quickadd.export_replace_desc'),
                  confirmLabel: t('quickadd.import'),
                  tone: 'danger',
                })
                if (!ok) return
              }
              setTransport(exportText())
              toast({ title: t('quickadd.exported'), tone: 'success' })
            }}>
            {t('quickadd.export')}
          </Button>
        </div>
      </section>
    </div>
  )
}
