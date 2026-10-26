import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Modal } from '../../../../../components/overlay'
import { Button, IconButton } from '../../../../../components/primitives'
import { Tooltip } from '../../../../../components/overlay'
import { t } from '../../../../../lib/i18n'
import { useColorStudioStore } from '../../store'

export function CreateCustomPaletteModal() {
  const isOpen = useColorStudioStore((s) => s.isCreatePaletteModalOpen)
  const onClose = useColorStudioStore((s) => s.closeCreatePaletteModal)
  const currentHex = useColorStudioStore((s) => s.currentHex)
  const savePalette = useColorStudioStore((s) => s.savePalette)

  const [title, setTitle] = useState('My Custom Palette')
  const [description, setDescription] = useState('')
  const [tagsInput, setTagsInput] = useState('custom, design')
  const [colors, setColors] = useState<string[]>([currentHex, '#f43f5e', '#3b82f6', '#10b981'])
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleColorChange = (index: number, val: string) => {
    const updated = [...colors]
    updated[index] = val
    setColors(updated)
  }

  const handleAddColor = () => {
    if (colors.length >= 12) return
    setColors([...colors, currentHex])
  }

  const handleRemoveColor = (index: number) => {
    if (colors.length <= 2) return
    setColors(colors.filter((_, i) => i !== index))
  }

  const handleSave = async () => {
    if (!title.trim()) return
    setIsSubmitting(true)
    try {
      const tags = tagsInput
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const items = colors.map((hex) => ({ hex }))
      await savePalette(title.trim(), items, 'custom', tags, description.trim())
      onClose()
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title={t('tools.color.create_palette.title')}
      width={580}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={onClose} disabled={isSubmitting}>
            {t('tools.color.common.cancel')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={handleSave}
            disabled={isSubmitting || !title.trim()}
          >
            {t('tools.color.create_palette.save')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Title */}
        <div>
          <label className="block text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
            {t('tools.color.create_palette.name')}
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="mt-1 w-full rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-1.5 text-[length:var(--text-13)] text-[var(--text-primary)] focus:border-[var(--brand-primary)] focus:outline-none"
            placeholder={t('tools.color.create_palette.placeholder')}
          />
        </div>

        {/* Colors Swatches List */}
        <div>
          <div className="flex items-center justify-between">
            <label className="block text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
              {t('tools.color.create_palette.color_count', { count: colors.length })}
            </label>
            <Button
              size="sm"
              variant="secondary"
              onClick={handleAddColor}
              disabled={colors.length >= 12}
            >
              <Plus size={12} className="mr-1" />
              {t('tools.color.create_palette.add_color')}
            </Button>
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2 max-h-48 overflow-y-auto p-1">
            {colors.map((hex, idx) => (
              <div
                key={idx}
                className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2"
              >
                <input
                  type="color"
                  value={hex}
                  onChange={(e) => handleColorChange(idx, e.target.value)}
                  className="h-7 w-7 cursor-pointer rounded-[var(--radius-xs)] border-0 bg-transparent shrink-0"
                />
                <input
                  type="text"
                  value={hex}
                  onChange={(e) => handleColorChange(idx, e.target.value)}
                  className="w-full rounded-[var(--radius-xs)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-0.5 font-mono text-[length:var(--text-12)] uppercase text-[var(--text-primary)]"
                />
                <Tooltip label={t('tools.color.create_palette.remove_color')}>
                  <IconButton
                    size="xs"
                    label={t('tools.color.create_palette.remove_color')}
                    disabled={colors.length <= 2}
                    onClick={() => handleRemoveColor(idx)}
                  >
                    <Trash2 size={12} />
                  </IconButton>
                </Tooltip>
              </div>
            ))}
          </div>
        </div>

        {/* Tags */}
        <div>
          <label className="block text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
            {t('tools.color.create_palette.tags_label')}
          </label>
          <input
            type="text"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            className="mt-1 w-full rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-1.5 text-[length:var(--text-13)] text-[var(--text-primary)] focus:border-[var(--brand-primary)] focus:outline-none"
            placeholder={t('tools.color.create_palette.tags_placeholder')}
          />
        </div>

        {/* Description */}
        <div>
          <label className="block text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
            {t('tools.color.create_palette.desc_label')}
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-1.5 text-[length:var(--text-13)] text-[var(--text-primary)] focus:border-[var(--brand-primary)] focus:outline-none resize-none"
            placeholder={t('tools.color.create_palette.desc_placeholder')}
          />
        </div>
      </div>
    </Modal>
  )
}
