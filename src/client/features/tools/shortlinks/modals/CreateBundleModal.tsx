import { useEffect, useState } from 'react'
import { Modal } from '../../../../components/overlay'
import { Button } from '../../../../components/primitives'
import { Input } from '../../../../components/form'
import { type MessageKey, t } from '../../../../lib/i18n'
import { useUiStore } from '../../../../lib/ui-store'
import type { BundleAccent } from '@shared/tools/shortlinks/types'
import { ACCENT_DOT } from '../accents'
import { useShortlinksStore } from '../store'
import { shortlinksApi } from '../api'

const ACCENT_COLORS: { id: BundleAccent; labelKey: MessageKey }[] = [
  { id: 'orange', labelKey: 'tools.shortlinks.modal.color_orange' },
  { id: 'red', labelKey: 'tools.shortlinks.modal.color_red' },
  { id: 'green', labelKey: 'tools.shortlinks.modal.color_green' },
  { id: 'blue', labelKey: 'tools.shortlinks.modal.color_blue' },
  { id: 'purple', labelKey: 'tools.shortlinks.modal.color_purple' },
]

export function CreateBundleModal() {
  const open = useShortlinksStore((s) => s.bundleModalOpen)
  const bundle = useShortlinksStore((s) => s.editingBundle)
  const closeBundleModal = useShortlinksStore((s) => s.closeBundleModal)
  const fetchBundles = useShortlinksStore((s) => s.fetchBundles)

  const [name, setName] = useState('')
  const [accent, setAccent] = useState<BundleAccent>('blue')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (bundle) {
      setName(bundle.name)
      setAccent(bundle.accent)
      setDescription(bundle.description || '')
    } else {
      setName('')
      setAccent('blue')
      setDescription('')
    }
  }, [bundle, open])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName) return

    setSubmitting(true)
    try {
      if (bundle) {
        await shortlinksApi.updateBundle(bundle.id, {
          name: trimmedName,
          accent,
          description: description.trim() || undefined,
        })
      } else {
        await shortlinksApi.createBundle({
          name: trimmedName,
          accent,
          description: description.trim() || undefined,
        })
      }

      useUiStore.getState().toast(t('tools.shortlinks.bundles.saved'), 'success')
      closeBundleModal()
      void fetchBundles()
    } catch (err) {
      useUiStore.getState().toast((err as Error).message, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const isEdit = Boolean(bundle)

  return (
    <Modal
      open={open}
      dismissible={!submitting}
      onClose={closeBundleModal}
      title={
        isEdit
          ? t('tools.shortlinks.modal.edit_bundle_title')
          : t('tools.shortlinks.modal.create_bundle_title')
      }
      width={460}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="ghost" onClick={closeBundleModal} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={submitting || !name.trim()}
          >
            {t('common.save')}
          </Button>
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4 py-2">
        <div>
          <label className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)] mb-1">
            {t('tools.shortlinks.modal.bundle_name')}{' '}
            <span className="text-[var(--danger)]">*</span>
          </label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('tools.shortlinks.modal.bundle_name_placeholder')}
            required
            autoFocus
          />
        </div>

        <div>
          <label className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)] mb-1.5">
            {t('tools.shortlinks.modal.bundle_accent')}
          </label>
          <div className="flex items-center gap-2">
            {ACCENT_COLORS.map((c) => {
              const isSelected = accent === c.id
              const colorName = t(c.labelKey)
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setAccent(c.id)}
                  style={{ backgroundColor: ACCENT_DOT[c.id] }}
                  className={`size-7 rounded-full transition-transform ${
                    isSelected ? 'scale-110 ring-2 ring-offset-2 ring-[var(--accent)]' : 'opacity-80 hover:opacity-100'
                  }`}
                  aria-label={colorName}
                  title={colorName}
                />
              )
            })}
          </div>
        </div>

        <div>
          <label className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)] mb-1">
            {t('tools.shortlinks.modal.bundle_description')}
          </label>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('tools.shortlinks.modal.bundle_description_placeholder')}
          />
        </div>
      </form>
    </Modal>
  )
}
