import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { normalizeHex } from '@shared/tools/color/spaces'
import { Modal } from '../../../../../components/overlay'
import { Button, IconButton } from '../../../../../components/primitives'
import { ColorWellField } from '../../../../../components/color-field'
import { Field, Input, Textarea } from '../../../../../components/form'
import { Tooltip } from '../../../../../components/overlay'
import { t } from '../../../../../lib/i18n'
import { useColorStudioStore } from '../../store'
import { parseHexInput } from '../../lib/hex-input'

/** Rows the editor starts with, and the ceiling it can grow to. */
const MIN_ROWS = 1
const MAX_ROWS = 12

export function CreateCustomPaletteModal() {
  const isOpen = useColorStudioStore((s) => s.isCreatePaletteModalOpen)
  const onClose = useColorStudioStore((s) => s.closeCreatePaletteModal)
  const savePalette = useColorStudioStore((s) => s.savePalette)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [rows, setRows] = useState<string[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)

  // The form used to be seeded once, at app start: the second time it opened it still held the previous
  // palette's title and tags, and its first row was the color that happened to be selected when the app
  // booted rather than the one on screen now.
  useEffect(() => {
    if (!isOpen) return
    const seed = useColorStudioStore.getState().currentHex
    setTitle('')
    setDescription('')
    setTagsInput('')
    setRows([seed])
    setIsSubmitting(false)
  }, [isOpen])

  const invalidRows = rows.map((value) => parseHexInput(value) === null)
  const hasInvalid = invalidRows.some(Boolean)

  const setRow = (index: number, value: string) => {
    setRows((current) => current.map((row, i) => (i === index ? value : row)))
  }

  const addRow = () => {
    setRows((current) =>
      current.length >= MAX_ROWS ? current : [...current, useColorStudioStore.getState().currentHex],
    )
  }

  const removeRow = (index: number) => {
    setRows((current) => (current.length <= MIN_ROWS ? current : current.filter((_, i) => i !== index)))
  }

  const handleSave = async () => {
    if (!title.trim() || hasInvalid) return
    const colors = rows.map((row) => parseHexInput(row) ?? normalizeHex(row, true))
    const tags = tagsInput
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean)

    setIsSubmitting(true)
    try {
      // Only a saved palette may close the window: the store reports a failed write as a toast and used to
      // resolve anyway, so the editor shut and the reader's colors were gone.
      if (await savePalette(title.trim(), colors.map((hex) => ({ hex })), 'custom', tags, description.trim())) {
        onClose()
      }
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
            disabled={isSubmitting || !title.trim() || hasInvalid}
          >
            {t('tools.color.create_palette.save')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label={t('tools.color.create_palette.name')}>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={100}
            placeholder={t('tools.color.create_palette.placeholder')}
          />
        </Field>

        <div>
          <div className="flex items-center justify-between">
            <span className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
              {t('tools.color.create_palette.color_count', { count: rows.length })}
            </span>
            <Button size="sm" variant="secondary" onClick={addRow} disabled={rows.length >= MAX_ROWS}>
              <Plus size={12} className="mr-1" />
              {t('tools.color.create_palette.add_color')}
            </Button>
          </div>

          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 max-h-48 overflow-y-auto p-0.5">
            {rows.map((value, index) => {
              const parsed = parseHexInput(value)
              return (
                <div
                  key={index}
                  className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2"
                >
                  <ColorWellField
                    value={parsed}
                    label={t('tools.color.create_palette.row_picker', { index: index + 1 })}
                    onChange={(next) => setRow(index, next)}
                  />
                  <Input
                    value={value}
                    onChange={(e) => setRow(index, e.target.value)}
                    aria-label={t('tools.color.create_palette.row_hex', { index: index + 1 })}
                    aria-invalid={parsed === null || undefined}
                    maxLength={7}
                    className="min-w-0 flex-1 font-mono text-[length:var(--text-12)] uppercase"
                  />
                  <Tooltip label={t('tools.color.create_palette.remove_color')}>
                    <IconButton
                      size="xs"
                      label={t('tools.color.create_palette.remove_color')}
                      disabled={rows.length <= MIN_ROWS}
                      onClick={() => removeRow(index)}
                    >
                      <Trash2 size={12} />
                    </IconButton>
                  </Tooltip>
                </div>
              )
            })}
          </div>

          {hasInvalid && (
            <p role="alert" className="mt-1 text-[length:var(--text-11)] text-[var(--danger)]">
              {t('tools.color.create_palette.invalid_hex')}
            </p>
          )}
        </div>

        <Field label={t('tools.color.create_palette.tags_label')} hint={t('tools.color.create_palette.tags_hint')}>
          <Input
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder={t('tools.color.create_palette.tags_placeholder')}
          />
        </Field>

        <Field label={t('tools.color.create_palette.desc_label')}>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            maxLength={1000}
            placeholder={t('tools.color.create_palette.desc_placeholder')}
          />
        </Field>
      </div>
    </Modal>
  )
}
