import { useEffect, useState } from 'react'
import { Modal } from '../../../../../components/overlay'
import { Button } from '../../../../../components/primitives'
import { Field, Input, Textarea } from '../../../../../components/form'
import { t } from '../../../../../lib/i18n'
import { useColorStudioStore } from '../../store'

/** Split a comma-separated box the way the create dialog does, without leaving blanks behind. */
export function parseTags(input: string): string[] {
  return input
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
}

/**
 * Rename a saved colour, tag it, and leave a note on it.
 *
 * The row was write-once before this: the name, tags, note and order columns existed, the update endpoint
 * existed, and nothing in the interface could reach any of them — so a saved colour was stuck with whatever
 * name the button that saved it happened to send.
 */
export function EditFavoriteModal() {
  const editingId = useColorStudioStore((s) => s.editingFavoriteId)
  const favorite = useColorStudioStore((s) => s.favorites.find((f) => f.id === s.editingFavoriteId))
  const close = useColorStudioStore((s) => s.closeEditFavorite)
  const updateFavorite = useColorStudioStore((s) => s.updateFavorite)

  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  // Seeded per row, not once: the second editor used to open holding the first row's text.
  useEffect(() => {
    if (!editingId || !favorite) return
    setName(favorite.name)
    setNote(favorite.note)
    setTagsInput(favorite.tags.join(', '))
    setIsSaving(false)
  }, [editingId, favorite])

  const trimmedName = name.trim()
  const tooLong = trimmedName.length > 100 || note.length > 500 || parseTags(tagsInput).some((tag) => tag.length > 50)

  const handleSave = async () => {
    if (!editingId || tooLong) return
    setIsSaving(true)
    const ok = await updateFavorite(editingId, { name: trimmedName, note, tags: parseTags(tagsInput) })
    // A refused save keeps the dialog and its text: the reader has to be able to fix it, not retype it.
    if (ok) close()
    else setIsSaving(false)
  }

  return (
    <Modal
      open={Boolean(editingId)}
      onClose={close}
      title={t('tools.color.edit.favorite_title')}
      width={480}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            {t('tools.color.common.cancel')}
          </Button>
          <Button variant="primary" disabled={isSaving || tooLong} onClick={handleSave}>
            {t('tools.color.edit.save')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {favorite && (
          <div className="flex items-center gap-3">
            <span
              className="h-10 w-14 shrink-0 rounded-[var(--r-md)] border border-black/10"
              style={{ backgroundColor: favorite.hex }}
              aria-hidden="true"
            />
            <span className="font-mono text-[length:var(--text-14)] font-semibold uppercase text-[var(--text-primary)]">
              {favorite.hex}
            </span>
          </div>
        )}

        <Field label={t('tools.color.edit.name')}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('tools.color.edit.name_placeholder')}
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

        <Field label={t('tools.color.edit.note')}>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('tools.color.edit.note_placeholder')}
            rows={3}
            maxLength={500}
          />
        </Field>
      </div>
    </Modal>
  )
}
