import { useEffect, useState } from 'react'
import { Modal } from '../../../../../components/overlay'
import { Button } from '../../../../../components/primitives'
import { Field, Input, Textarea } from '../../../../../components/form'
import { t } from '../../../../../lib/i18n'
import { useColorStudioStore } from '../../store'
import { parseTags } from './EditFavoriteModal'

/**
 * Rename a saved palette, describe it, and tag it.
 *
 * A palette is the only copy of its colours — there is no trash and no export list to restore it from — so
 * what the reader calls it is the only thing that makes it findable later. The title, description, tags and
 * order columns had no way in from the interface until here.
 */
export function EditPaletteModal() {
  const editingId = useColorStudioStore((s) => s.editingPaletteId)
  const palette = useColorStudioStore((s) => s.palettes.find((p) => p.id === s.editingPaletteId))
  const close = useColorStudioStore((s) => s.closeEditPalette)
  const updatePalette = useColorStudioStore((s) => s.updatePalette)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    if (!editingId || !palette) return
    setTitle(palette.title)
    setDescription(palette.description)
    setTagsInput(palette.tags.join(', '))
    setIsSaving(false)
  }, [editingId, palette])

  const trimmedTitle = title.trim()
  const tags = parseTags(tagsInput)
  // The server wants at least one character of title and no tag longer than 50.
  const invalid = trimmedTitle.length === 0 || trimmedTitle.length > 100 || description.length > 1000 || tags.some((tag) => tag.length > 50)

  const handleSave = async () => {
    if (!editingId || invalid) return
    setIsSaving(true)
    const ok = await updatePalette(editingId, { title: trimmedTitle, description, tags })
    if (ok) close()
    else setIsSaving(false)
  }

  return (
    <Modal
      open={Boolean(editingId)}
      onClose={close}
      title={t('tools.color.edit.palette_title')}
      width={520}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            {t('tools.color.common.cancel')}
          </Button>
          <Button variant="primary" disabled={isSaving || invalid} onClick={handleSave}>
            {t('tools.color.edit.save')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {palette && (
          <div className="flex h-10 w-full overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)]">
            {palette.colors.map((color, index) => (
              <span
                key={`${color.hex}-${index}`}
                className="flex-1"
                style={{ backgroundColor: color.hex }}
                title={color.hex}
              />
            ))}
          </div>
        )}

        <Field label={t('tools.color.create_palette.name')}>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('tools.color.create_palette.placeholder')}
            maxLength={100}
          />
        </Field>

        <Field label={t('tools.color.create_palette.tags_label')} hint={t('tools.color.create_palette.tags_hint')}>
          <Input
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder={t('tools.color.edit.tags_placeholder')}
          />
        </Field>

        <Field label={t('tools.color.edit.description')}>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('tools.color.edit.description_placeholder')}
            rows={3}
            maxLength={1000}
          />
        </Field>
      </div>
    </Modal>
  )
}
