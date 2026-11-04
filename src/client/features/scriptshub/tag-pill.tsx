/**
 * Tag chips for a snippet row.
 *
 * The chip's colour is the tag's own when it has one, otherwise a hash of its name into the app's
 * existing colour tokens. The text stays on the theme's secondary token so the label clears AA in
 * both themes; only the frame and the dot carry the hue. Overflow folds into `+N`, whose menu lists
 * every tag so none becomes unreachable.
 */
import { useMemo, useRef, useState } from 'react'
import { Copy, Hash, MoreHorizontal, Palette, Pencil, Tag as TagIcon, Trash2 } from 'lucide-react'
import type { ScriptTag } from '@shared/scriptshub/types'
import { t } from '../../lib/i18n'
import { copyText } from '../../lib/clipboard'
import { cn } from '../../lib/cn'
import { Button, IconButton } from '../../components/primitives'
import { Input } from '../../components/form'
import { ColorWellField } from '../../components/color-field'
import { Menu, Modal, confirm, useContextMenu, type MenuItem } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { useScriptsHub } from './store'
import { tagColorFor, tagPillStyle } from './tag-color'

export function TagPills({ tags, max = 3, onFilter }: {
  tags: readonly ScriptTag[]
  max?: number
  onFilter: (tagId: string) => void
}) {
  const overflowAnchor = useRef<HTMLButtonElement>(null)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const visible = tags.slice(0, max)
  const hidden = tags.slice(max)
  const overflowItems: MenuItem[] = hidden.map((tag) => ({
    id: tag.id,
    label: `#${tag.name}`,
    icon: <Hash size={13} aria-hidden="true" />,
    onSelect: () => onFilter(tag.id),
  }))
  return (
    <div className="mt-1.5 flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-[length:var(--text-10-5)]">
      {visible.map((tag) => (
        <TagPill key={tag.id} tag={tag} onFilter={onFilter} />
      ))}
      {hidden.length > 0 && (
        <>
          <Button ref={overflowAnchor} size="sm" variant="ghost" className="h-5 shrink-0 px-1 text-[length:var(--text-10)]" onClick={() => setOverflowOpen(true)}>
            +{hidden.length}
          </Button>
          <Menu anchor={overflowAnchor} open={overflowOpen} onClose={() => setOverflowOpen(false)} items={overflowItems} width={180} />
        </>
      )}
    </div>
  )
}

export function TagPill({ tag, onFilter }: { tag: ScriptTag; onFilter: (tagId: string) => void }) {
  const toast = useUi((state) => state.toast)
  const updateTag = useScriptsHub((state) => state.updateTag)
  const deleteTag = useScriptsHub((state) => state.deleteTag)
  const menu = useContextMenu()
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(tag.name)
  const [coloring, setColoring] = useState(false)
  const [color, setColor] = useState<string | null>(tag.color)
  const style = useMemo(() => tagPillStyle(tag.name, tag.color), [tag.color, tag.name])
  const colorValue = tagColorFor(tag.name, tag.color)

  const commitRename = async () => {
    const next = name.trim()
    setRenaming(false)
    if (!next || next === tag.name) return
    try {
      await updateTag(tag.id, { name: next })
    } catch (error) {
      toast({ title: t('scriptshub.toast.tag_rename_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    }
  }

  const commitColor = async () => {
    setColoring(false)
    try {
      await updateTag(tag.id, { color })
    } catch (error) {
      toast({ title: t('scriptshub.toast.tag_color_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    }
  }

  const remove = async () => {
    const agreed = await confirm({
      title: t('scriptshub.confirm.delete_tag_title', { name: tag.name }),
      description: t('scriptshub.confirm.delete_tag_body'),
      confirmLabel: t('scriptshub.common.delete'),
      tone: 'danger',
    })
    if (agreed) await deleteTag(tag.id)
  }

  const items: MenuItem[] = [
    { id: 'filter', label: t('scriptshub.tag.filter'), icon: <TagIcon size={13} aria-hidden="true" />, onSelect: () => onFilter(tag.id) },
    { id: 'copy', label: t('scriptshub.tag.copy_name'), icon: <Copy size={13} aria-hidden="true" />, onSelect: () => {
      void copyText(`#${tag.name}`).then((ok) => toast({ title: ok ? t('scriptshub.tag.copied') : t('scriptshub.common.copy_failed'), tone: ok ? 'success' : 'danger' }))
    } },
    { id: 'rename', label: t('scriptshub.common.rename'), icon: <Pencil size={13} aria-hidden="true" />, separatorBefore: true, onSelect: () => { setName(tag.name); setRenaming(true) } },
    { id: 'color', label: t('scriptshub.tag.color'), icon: <Palette size={13} aria-hidden="true" />, onSelect: () => { setColor(tag.color); setColoring(true) } },
    { id: 'delete', label: t('scriptshub.common.delete'), icon: <Trash2 size={13} aria-hidden="true" />, tone: 'danger', separatorBefore: true, onSelect: () => void remove() },
  ]

  return (
    <>
      <span
        className={cn('flex min-w-0 max-w-[70%] shrink-0 items-center gap-1 rounded-[var(--r-full)] border px-1.5 py-px')}
        style={style}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          menu.onContextMenu(event)
        }}
      >
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: colorValue }} />
        {renaming ? (
          <Input
            autoFocus
            aria-label={t('scriptshub.common.rename')}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void commitRename()
              }
              if (event.key === 'Escape') {
                setName(tag.name)
                setRenaming(false)
              }
            }}
            className="h-5 min-w-0 flex-1 px-0.5 text-[length:var(--text-10-5)]"
          />
        ) : (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              onFilter(tag.id)
            }}
            className="min-w-0 truncate text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            #{tag.name}
          </button>
        )}
        <IconButton
          label={t('scriptshub.common.more')}
          size="xs"
          onClick={(event) => {
            event.stopPropagation()
            menu.close()
            menu.onContextMenu(event)
          }}
          className="size-4 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
        >
          <MoreHorizontal size={9} aria-hidden="true" />
        </IconButton>
      </span>

      {menu.point && <Menu anchor={menu.point} open onClose={menu.close} items={items} />}

      <Modal
        open={coloring}
        onClose={() => setColoring(false)}
        title={t('scriptshub.tag.color_title', { name: tag.name })}
        width={360}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setColoring(false)}>{t('scriptshub.common.cancel')}</Button>
            <Button variant="primary" onClick={() => void commitColor()}>{t('scriptshub.common.save')}</Button>
          </>
        )}
      >
        <div className="flex items-center gap-3">
          <ColorWellField value={color} label={t('scriptshub.tag.color')} onChange={setColor} />
          <span className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('scriptshub.tag.color_hint')}</span>
        </div>
      </Modal>
    </>
  )
}
