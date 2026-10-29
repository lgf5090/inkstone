import { useEffect, useMemo, useRef, useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { ORGANIZER_COLORS } from '@shared/organizer-colors'
import {
  buildTagTree,
  tagSubtreeIds,
  wouldCreateTagCycle,
  type YouTubeTag,
  type YouTubeTagNode,
} from '@shared/youtube/model'
import { YOUTUBE_MAX_TAG_NAME_LENGTH } from '@shared/youtube/validate'
import { Field, Input, Select } from '../../../components/form'
import { confirm, Modal } from '../../../components/overlay'
import { Button, IconButton } from '../../../components/primitives'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { useYoutubeStore } from '../store'
import { Swatch } from '../../../components/color-swatch'
import { organizerColorLabel } from '@shared/organizer-colors'

interface TagOption {
  tag: YouTubeTag
  depth: number
}

/** The tree in drawing order, each row carrying the depth its name is indented by in a flat list. */
function flattenTagTree(nodes: YouTubeTagNode[], depth = 0): TagOption[] {
  return nodes.flatMap((node) => [
    { tag: node, depth },
    ...flattenTagTree(node.children, depth + 1),
  ])
}

function indentedName(name: string, depth: number): string {
  return depth > 0 ? `${'\u2014 '.repeat(depth)}${name}` : name
}

/**
 * The one place a tag is created, renamed, recoloured, re-parented or deleted.
 *
 * The add area stays at the top and keeps its values after a refusal, so a failed write costs a retry
 * rather than the whole form. Editing happens in the row it belongs to — a reader who changed their
 * mind about one tag should not have to read the add form again — and its parent list drops the tag
 * and its descendants, which is the one move the tree rules forbid. Deleting asks first because a tag
 * takes its children and every reference to them with it.
 */
export function TagManagerModal({
  open,
  onClose,
  tags,
}: {
  open: boolean
  onClose: () => void
  tags: YouTubeTag[]
}) {
  const addTag = useYoutubeStore((state) => state.addTag)
  const editTag = useYoutubeStore((state) => state.editTag)
  const removeTag = useYoutubeStore((state) => state.removeTag)

  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(ORGANIZER_COLORS[0])
  const [parentId, setParentId] = useState('')
  const [adding, setAdding] = useState(false)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState<string>(ORGANIZER_COLORS[0])
  const [editParentId, setEditParentId] = useState('')
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const editInputRef = useRef<HTMLInputElement>(null)

  const options = useMemo(() => flattenTagTree(buildTagTree(tags)), [tags])
  const tagsById = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags])

  const editParentOptions = useMemo(() => {
    if (!editingId) return []
    const excluded = tagSubtreeIds(tags, editingId)
    return options.filter(({ tag }) => !excluded.has(tag.id) && !wouldCreateTagCycle(tags, editingId, tag.id))
  }, [editingId, options, tags])

  useEffect(() => {
    if (editingId) editInputRef.current?.focus()
  }, [editingId])

  useEffect(() => {
    if (open) return
    setEditingId(null)
    setSaving(false)
    setDeletingId(null)
  }, [open])

  const fail = (error: unknown) => {
    useUi.getState().toast({
      title: t('youtube.failed'),
      description: error instanceof Error ? error.message : String(error),
      tone: 'danger',
    })
  }

  const submitAdd = async () => {
    const trimmed = name.trim()
    if (!trimmed || adding) return
    setAdding(true)
    try {
      await addTag({ name: trimmed, color, parentId: parentId || null })
      setName('')
      setParentId('')
    } catch (error) {
      fail(error)
    } finally {
      setAdding(false)
    }
  }

  const startEdit = (tag: YouTubeTag) => {
    setEditingId(tag.id)
    setEditName(tag.name)
    setEditColor(tag.color)
    setEditParentId(tag.parentId && tagsById.has(tag.parentId) ? tag.parentId : '')
  }

  const submitEdit = async () => {
    if (!editingId || saving) return
    const trimmed = editName.trim()
    if (!trimmed) return
    const nextParentId = editParentId || null
    if (wouldCreateTagCycle(tags, editingId, nextParentId)) return
    setSaving(true)
    try {
      await editTag(editingId, { name: trimmed, color: editColor, parentId: nextParentId })
      setEditingId(null)
    } catch (error) {
      fail(error)
    } finally {
      setSaving(false)
    }
  }

  const askDelete = async (tag: YouTubeTag) => {
    if (deletingId) return
    const confirmed = await confirm({
      title: t('youtube.tags.delete_title'),
      description: t('youtube.tags.delete_desc', { name: tag.name }),
      confirmLabel: t('youtube.tags.delete'),
      tone: 'danger',
    })
    if (!confirmed) return
    setDeletingId(tag.id)
    try {
      await removeTag(tag.id)
      if (editingId === tag.id) setEditingId(null)
    } catch (error) {
      fail(error)
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('youtube.tags.manager_title')}
      description={t('youtube.tags.manager_desc')}
      width={560}
    >
      <div className="space-y-4 pt-1">
        <section
          aria-label={t('youtube.tags.new')}
          className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-3"
        >
          <h3 className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">
            {t('youtube.tags.new')}
          </h3>
          <form
            className="mt-2 space-y-2.5"
            onSubmit={(event) => {
              event.preventDefault()
              void submitAdd()
            }}
          >
            <Field label={t('youtube.tags.name')}>
              <Input
                value={name}
                maxLength={YOUTUBE_MAX_TAG_NAME_LENGTH}
                placeholder={t('youtube.tags.name_placeholder')}
                autoComplete="off"
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <div>
              <span className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
                {t('youtube.tags.color')}
              </span>
              <div className="mt-1.5">
                <ColorSwatches value={color} onChange={setColor} />
              </div>
            </div>
            <Field label={t('youtube.tags.parent')}>
              <Select value={parentId} onChange={(event) => setParentId(event.target.value)}>
                <option value="">{t('youtube.tags.top_level')}</option>
                {options.map((option) => (
                  <option key={option.tag.id} value={option.tag.id}>
                    {indentedName(option.tag.name, option.depth)}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex justify-end">
              <Button type="submit" variant="primary" loading={adding} disabled={!name.trim()}>
                {t('youtube.tags.add')}
              </Button>
            </div>
          </form>
        </section>

        <section aria-label={t('youtube.tags.existing')}>
          <h3 className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">
            {t('youtube.tags.existing')}
          </h3>
          {tags.length === 0 ? (
            <p className="mt-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {t('youtube.tags.empty')}
            </p>
          ) : (
            <ul className="mt-1 space-y-0.5">
              {options.map(({ tag }) => {
                if (editingId === tag.id) {
                  return (
                    <li key={tag.id}>
                      <form
                        className="space-y-2 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-sunken)] p-2"
                        onSubmit={(event) => {
                          event.preventDefault()
                          void submitEdit()
                        }}
                      >
                        <div className="flex items-center gap-2">
                          <span
                            aria-hidden="true"
                            className="size-[var(--sp-2)] shrink-0 rounded-[var(--r-full)]"
                            style={{ backgroundColor: editColor }}
                          />
                          <Input
                            ref={editInputRef}
                            aria-label={t('youtube.tags.name')}
                            value={editName}
                            maxLength={YOUTUBE_MAX_TAG_NAME_LENGTH}
                            autoComplete="off"
                            onChange={(event) => setEditName(event.target.value)}
                            className="min-w-0 flex-1"
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                            {t('youtube.tags.color')}
                          </span>
                          <ColorSwatches compact value={editColor} onChange={setEditColor} />
                        </div>
                        <Field label={t('youtube.tags.parent')}>
                          <Select
                            value={editParentId}
                            onChange={(event) => setEditParentId(event.target.value)}
                          >
                            <option value="">{t('youtube.tags.top_level')}</option>
                            {editParentOptions.map((option) => (
                              <option key={option.tag.id} value={option.tag.id}>
                                {indentedName(option.tag.name, option.depth)}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <div className="flex justify-end gap-1.5">
                          <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                            {t('common.cancel')}
                          </Button>
                          <Button
                            type="submit"
                            variant="primary"
                            size="sm"
                            loading={saving}
                            disabled={!editName.trim()}
                          >
                            {t('youtube.tags.save')}
                          </Button>
                        </div>
                      </form>
                    </li>
                  )
                }

                const parent = tag.parentId ? tagsById.get(tag.parentId) : undefined
                return (
                  <li
                    key={tag.id}
                    className="flex min-w-0 items-center gap-2 rounded-[var(--r-sm)] px-1.5 py-1 hover:bg-[var(--bg-hover)]"
                  >
                    <span
                      aria-hidden="true"
                      className="size-[var(--sp-2)] shrink-0 rounded-[var(--r-full)]"
                      style={{ backgroundColor: tag.color }}
                    />
                    <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-primary)]">
                      {tag.name}
                    </span>
                    {parent ? (
                      <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                        {t('youtube.tags.parent_of', { name: parent.name })}
                      </span>
                    ) : null}
                    <IconButton label={t('youtube.tags.edit')} size="sm" onClick={() => startEdit(tag)}>
                      <Pencil size={13} aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      label={t('youtube.tags.delete')}
                      size="sm"
                      disabled={deletingId === tag.id}
                      onClick={() => void askDelete(tag)}
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </IconButton>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  )
}

function ColorSwatches({
  value,
  onChange,
  compact = false,
}: {
  value: string
  onChange: (color: string) => void
  compact?: boolean
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {ORGANIZER_COLORS.map((color) => (
        <Swatch
          key={color}
          color={color}
          label={organizerColorLabel(color, t)}
          active={value === color}
          background={color}
          size={compact ? 'sm' : 'md'}
          onPick={() => onChange(color)}
        />
      ))}
    </div>
  )
}
