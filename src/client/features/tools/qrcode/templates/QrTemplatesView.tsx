import { useEffect, useState } from 'react'
import { Plus, RefreshCw, Trash2, Undo2 } from 'lucide-react'
import { QR_PRESETS } from '../../../../../shared/tools/qrcode/presets'
import type { QrCodeTemplate, QrPreset, QrStylingOptions, QrTemplateCategory } from '../../../../../shared/tools/qrcode/types'
import { deleteQrTemplate, fetchQrTemplates, saveQrTemplate } from '../api'
import { useQrCodeStore } from '../store'
import { useToolsStore } from '../../store'
import { Button, IconButton } from '../../../../components/primitives'
import { confirm, prompt } from '../../../../components/overlay'
import { useUi } from '../../../../store/ui'
import { t, type MessageKey } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { TemplateThumbnail } from './TemplateThumbnail'

const CATEGORIES: readonly { id: 'all' | QrTemplateCategory | 'custom'; labelKey: MessageKey }[] = [
  { id: 'all', labelKey: 'tools.qrcode.templates.cat_all' },
  { id: 'minimal', labelKey: 'tools.qrcode.templates.cat_minimal' },
  { id: 'frame', labelKey: 'tools.qrcode.templates.cat_frame' },
  { id: 'artistic', labelKey: 'tools.qrcode.templates.cat_artistic' },
  { id: 'scenario', labelKey: 'tools.qrcode.templates.cat_scenario' },
  { id: 'custom', labelKey: 'tools.qrcode.templates.custom_section' },
]

export function QrTemplatesView() {
  const [customTemplates, setCustomTemplates] = useState<QrCodeTemplate[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedCategory, setSelectedCategory] = useState<'all' | QrTemplateCategory | 'custom'>('all')

  const setActiveView = useQrCodeStore((s) => s.setActiveView)
  const setOptions = useQrCodeStore((s) => s.setOptions)
  const currentOptions = useQrCodeStore((s) => s.options)

  const loadTemplates = async () => {
    setLoading(true)
    try {
      const data = await fetchQrTemplates()
      const list: QrCodeTemplate[] = Array.isArray(data) ? data : (data as any)?.templates || []
      setCustomTemplates(list.filter((tpl: QrCodeTemplate) => !tpl.isBuiltin))
    } catch {
      useUi.getState().toast({ title: t('tools.qrcode.templates.load_error'), tone: 'danger' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadTemplates()
  }, [])

  const handleApplyPreset = (preset: QrPreset) => {
    useQrCodeStore.getState().applyPreset(preset)
    setActiveView('generator')
    useToolsStore.getState().setActiveQrCodeView('generator')
    useUi.getState().toast({ title: t('tools.qrcode.templates.applied'), tone: 'success' })
  }

  const handleApplyCustom = (tpl: QrCodeTemplate) => {
    try {
      const parsed = JSON.parse(tpl.optionsJson)
      setOptions(parsed)
      setActiveView('generator')
      useToolsStore.getState().setActiveQrCodeView('generator')
      useUi.getState().toast({ title: t('tools.qrcode.templates.applied'), tone: 'success' })
    } catch {
      useUi.getState().toast({ title: t('tools.qrcode.templates.apply_error'), tone: 'danger' })
    }
  }

  const handleSaveCurrentAsTemplate = async () => {
    const name = await prompt({
      title: t('tools.qrcode.templates.prompt_name'),
    })
    if (!name?.trim()) return

    try {
      const created = await saveQrTemplate({
        name: name.trim(),
        category: 'custom',
        options: currentOptions,
      })
      setCustomTemplates((prev) => [created, ...prev])
      useUi.getState().toast({ title: t('tools.qrcode.templates.save_success'), tone: 'success' })
    } catch {
      useUi.getState().toast({ title: t('tools.qrcode.templates.save_error'), tone: 'danger' })
    }
  }

  const handleDelete = async (tpl: QrCodeTemplate) => {
    const confirmed = await confirm({
      title: t('tools.qrcode.templates.delete_confirm_title'),
      description: t('tools.qrcode.templates.delete_confirm_desc'),
      confirmLabel: t('tools.qrcode.templates.delete_confirm_button'),
      tone: 'danger',
    })
    if (!confirmed) return

    try {
      await deleteQrTemplate(tpl.id)
      setCustomTemplates((prev) => prev.filter((t) => t.id !== tpl.id))
      useUi.getState().toast({ title: t('tools.qrcode.templates.delete_success'), tone: 'success' })
    } catch {
      useUi.getState().toast({ title: t('tools.qrcode.templates.delete_error'), tone: 'danger' })
    }
  }

  const parseCustomOptions = (json: string): QrStylingOptions => {
    try {
      return JSON.parse(json)
    } catch {
      return currentOptions
    }
  }

  const showCustom = selectedCategory === 'all' || selectedCategory === 'custom'
  const showBuiltin = selectedCategory !== 'custom'
  const filteredPresets = selectedCategory === 'all'
    ? QR_PRESETS
    : QR_PRESETS.filter((p) => p.category === selectedCategory)

  return (
    <div className="flex h-full flex-col p-4 md:p-6 overflow-y-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5 border-b border-[var(--border-subtle)] pb-4">
        <div>
          <h2 className="text-[length:var(--text-18)] font-bold text-[var(--text-primary)]">
            {t('tools.qrcode.templates.library_title')}
          </h2>
          <p className="text-[length:var(--text-13)] text-[var(--text-secondary)] mt-0.5">
            {t('tools.qrcode.templates.library_subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto shrink-0">
          <Button
            variant="secondary"
            size="sm"
            onClick={loadTemplates}
            loading={loading}
            icon={<RefreshCw size={14} />}
          >
            {t('tools.qrcode.templates.refresh')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSaveCurrentAsTemplate}
            icon={<Plus size={14} />}
          >
            {t('tools.qrcode.templates.save_current')}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-5">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            type="button"
            onClick={() => setSelectedCategory(cat.id)}
            className={cn(
              'rounded-[var(--r-md)] px-3 py-1.5 text-[length:var(--text-12)] font-medium transition-colors',
              selectedCategory === cat.id
                ? 'bg-[var(--accent)] text-[var(--accent-contrast)] shadow-xs'
                : 'bg-[var(--bg-sunken)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
            )}
          >
            {t(cat.labelKey)}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-8 pb-8">
        {showCustom && customTemplates.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <h3 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
                {t('tools.qrcode.templates.custom_section')}
              </h3>
              <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.2 text-[length:var(--text-10)] font-semibold text-[var(--accent-on-soft)]">
                {customTemplates.length}
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3.5">
              {customTemplates.map((tpl) => {
                const opts = parseCustomOptions(tpl.optionsJson)
                return (
                  <div
                    key={tpl.id}
                    className="group flex flex-col rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3 shadow-xs hover:border-[var(--accent)] transition-all"
                  >
                    <div className="flex h-36 w-full items-center justify-center overflow-hidden rounded-[var(--r-md)] bg-white p-2 shadow-xs mb-3">
                      <TemplateThumbnail options={opts} />
                    </div>

                    <div className="flex items-center justify-between mb-1">
                      <span className="truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
                        {tpl.name}
                      </span>
                      <IconButton
                        size="sm"
                        label={t('tools.qrcode.templates.delete')}
                        onClick={() => handleDelete(tpl)}
                      >
                        <Trash2 size={13} className="text-[var(--danger)]" />
                      </IconButton>
                    </div>

                    <div className="mt-auto pt-2">
                      <Button
                        variant="subtle"
                        size="sm"
                        block
                        onClick={() => handleApplyCustom(tpl)}
                        icon={<Undo2 size={13} />}
                      >
                        {t('tools.qrcode.templates.apply')}
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {showBuiltin && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <h3 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
                {t('tools.qrcode.templates.builtin_section')}
              </h3>
              <span className="rounded-full bg-[var(--bg-sunken)] px-2 py-0.2 text-[length:var(--text-10)] font-semibold text-[var(--text-tertiary)]">
                {filteredPresets.length}
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3.5">
              {filteredPresets.map((preset) => (
                <div
                  key={preset.id}
                  className="group flex flex-col rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3 shadow-xs hover:border-[var(--accent)] transition-all"
                >
                  <div className="flex h-36 w-full items-center justify-center overflow-hidden rounded-[var(--r-md)] bg-white p-2 shadow-xs mb-3">
                    <TemplateThumbnail options={preset.options} />
                  </div>

                  <div className="flex items-center justify-between gap-1 mb-1">
                    <span className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)] truncate">
                      {preset.name}
                    </span>
                    <span className="shrink-0 rounded bg-[var(--bg-sunken)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--text-tertiary)]">
                      {preset.category === 'minimal' && t('tools.qrcode.templates.cat_minimal')}
                      {preset.category === 'frame' && t('tools.qrcode.templates.cat_frame')}
                      {preset.category === 'artistic' && t('tools.qrcode.templates.cat_artistic')}
                      {preset.category === 'scenario' && t('tools.qrcode.templates.cat_scenario')}
                    </span>
                  </div>

                  <p className="text-[length:var(--text-11)] text-[var(--text-secondary)] line-clamp-2 mb-3 min-h-[30px]">
                    {preset.description}
                  </p>

                  <div className="mt-auto">
                    <Button
                      variant="secondary"
                      size="sm"
                      block
                      onClick={() => handleApplyPreset(preset)}
                    >
                      {t('tools.qrcode.templates.apply')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
