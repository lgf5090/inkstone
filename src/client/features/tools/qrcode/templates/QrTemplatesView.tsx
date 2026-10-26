import { useEffect, useState } from 'react'
import { Plus, RefreshCw, Sparkles, Trash2, Undo2 } from 'lucide-react'
import { QR_PRESETS } from '../../../../../shared/tools/qrcode/presets'
import type { QrCodeTemplate } from '../../../../../shared/tools/qrcode/types'
import { deleteQrTemplate, fetchQrTemplates, saveQrTemplate } from '../api'
import { useQrCodeStore } from '../store'
import { useToolsStore } from '../../store'
import { Button, IconButton } from '../../../../components/primitives'
import { confirm, prompt } from '../../../../components/overlay'
import { useUi } from '../../../../store/ui'
import { t } from '../../../../lib/i18n'

export function QrTemplatesView() {
  const [customTemplates, setCustomTemplates] = useState<QrCodeTemplate[]>([])
  const [loading, setLoading] = useState(false)

  const setActiveView = useQrCodeStore((s) => s.setActiveView)
  const setOptions = useQrCodeStore((s) => s.setOptions)
  const currentOptions = useQrCodeStore((s) => s.options)

  const loadTemplates = async () => {
    setLoading(true)
    try {
      const data = await fetchQrTemplates()
      setCustomTemplates(data.templates.filter((tpl) => !tpl.isBuiltin))
    } catch {
      useUi.getState().toast({ title: t('tools.qrcode.templates.load_error'), tone: 'danger' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadTemplates()
  }, [])

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

  return (
    <div className="flex h-full flex-col p-4 overflow-y-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">
            {t('tools.qrcode.templates.library_title')}
          </h2>
          <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
            {t('tools.qrcode.templates.library_subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2">
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

      <div className="flex flex-col gap-6">
        {customTemplates.length > 0 && (
          <div>
            <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)] mb-2.5">
              {t('tools.qrcode.templates.custom_section')}
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2.5">
              {customTemplates.map((tpl) => (
                <div
                  key={tpl.id}
                  className="flex flex-col rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3 shadow-xs"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)] truncate">
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
                  <Button
                    variant="subtle"
                    size="sm"
                    onClick={() => handleApplyCustom(tpl)}
                    icon={<Undo2 size={13} />}
                  >
                    {t('tools.qrcode.templates.apply')}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)] mb-2.5">
            {t('tools.qrcode.templates.builtin_section')}
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2.5">
            {QR_PRESETS.map((preset) => (
              <div
                key={preset.id}
                className="flex flex-col items-center justify-between rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3 text-center"
              >
                <div className="flex items-center gap-1.5 mb-2">
                  <Sparkles size={14} className="text-[var(--accent)]" />
                  <span className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">
                    {t(preset.nameKey as any)}
                  </span>
                </div>
                <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)] mb-3 line-clamp-2">
                  {preset.description}
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  block
                  onClick={() => {
                    useQrCodeStore.getState().applyPreset(preset)
                    setActiveView('generator')
      useToolsStore.getState().setActiveQrCodeView('generator')
                  }}
                >
                  {t('tools.qrcode.templates.apply')}
                </Button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
