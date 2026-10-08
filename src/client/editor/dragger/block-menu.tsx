import { useMemo } from 'react'
import {
  CheckSquare,
  Copy,
  GitCommitHorizontal,
  Heading1,
  List,
  ListOrdered,
  MessageSquare,
  Pilcrow,
  Quote,
  Scissors,
  Sigma,
  Sparkles,
  Square,
  Trash2,
  Type,
} from 'lucide-react'
import type { EditorView } from '@codemirror/view'
import type { EditorSettings } from '@shared/types'
import { Menu, submenuFor, type MenuItem } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { t } from '../../lib/i18n'
import type { DraggerIconName } from './menu-entries'
import { draggerBlockMenuEntries, isDraggerMenuGroup } from './menu-entries'
import { copyBlock, cutBlock, deleteBlock, duplicateBlock, convertBlock } from './commands'

/** Where the pointer asked for the block menu, and which block it was pointing at. */
export interface DraggerBlockMenuRequest {
  view: EditorView
  /** 1-based, the block's first line. */
  line: number
  x: number
  y: number
}

const ICONS: Record<DraggerIconName, typeof Pilcrow> = {
  pilcrow: Pilcrow,
  heading: Heading1,
  'heading-level': Type,
  list: List,
  'list-ordered': ListOrdered,
  'list-checks': CheckSquare,
  quote: Quote,
  callout: MessageSquare,
  code: Square,
  math: Sigma,
  sparkles: Sparkles,
  copy: Copy,
  scissors: Scissors,
  duplicate: GitCommitHorizontal,
  trash: Trash2,
}

function icon(name: DraggerIconName) {
  const Glyph = ICONS[name] ?? Pilcrow
  return <Glyph size={15}/>
}

/** A style the reader wrote carries its own glyph; a built-in row keeps the mapped lucide mark. */
function rowIcon(option: { icon: DraggerIconName; glyph?: string }) {
  return option.glyph ? <span className="text-[15px] leading-none" aria-hidden="true">{option.glyph}</span> : icon(option.icon)
}

/**
 * The handle's popup menu: change this block into that kind of block, or take the block out.
 *
 * The rows come from the reader's own order, and a group that lost every row loses its entry too, so
 * the menu only ever offers what the note can become.
 */
export function DraggerBlockMenuAt({ request, settings, onClose }: {
  request: DraggerBlockMenuRequest | null
  settings: EditorSettings
  onClose: () => void
}) {
  const items = useMemo(() => (request ? buildDraggerBlockMenuItems(request.view, request.line, settings, onClose) : []),
    [request, settings, onClose])
  if (!request) return null
  return <Menu anchor={{ x: request.x, y: request.y }} open onClose={onClose} items={items} label={t('dragger.change_type')} width={216}/>
}

/** Exported for the editor toolbar and the command palette, which open the same menu at the caret. */
export function buildDraggerBlockMenuItems(
  view: EditorView,
  line: number,
  settings: EditorSettings,
  onClose: () => void,
): MenuItem[] {
  const toast = (title: string, tone?: 'default' | 'danger') => useUi.getState().toast({ title, tone })
  const items: MenuItem[] = []
  for (const entry of draggerBlockMenuEntries(settings)) {
    if (isDraggerMenuGroup(entry)) {
      const subItems = entry.options.map((option) => ({
        id: option.id,
        label: option.label,
        icon: rowIcon(option),
        onSelect: () => {
          if (!convertBlock(view, line, option.target)) toast(t('dragger.could_not_change'), 'danger')
          onClose()
        },
      }))
      items.push({ id: `group-${entry.id}`, label: entry.label, icon: icon(entry.icon), submenu: submenuFor(subItems), subItems })
      continue
    }
    items.push({
      id: entry.id,
      label: entry.label,
      icon: rowIcon(entry),
      onSelect: () => {
        if (!convertBlock(view, line, entry.target)) toast(t('dragger.could_not_change'), 'danger')
        onClose()
      },
    })
  }
  items.push({
    id: 'copy',
    label: t('dragger.copy_block'),
    icon: icon('copy'),
    separatorBefore: items.length > 0,
    onSelect: () => {
      void copyBlock(view, line).then((ok) => {
        if (!ok) toast(t('dragger.could_not_copy'), 'danger')
        else toast(t('dragger.block_copied'))
        onClose()
      })
    },
  })
  items.push({
    id: 'cut',
    label: t('dragger.cut_block'),
    icon: icon('scissors'),
    onSelect: () => {
      void cutBlock(view, line).then((ok) => {
        if (!ok) toast(t('dragger.could_not_cut'), 'danger')
        else toast(t('dragger.block_cut'))
        onClose()
      })
    },
  })
  items.push({
    id: 'duplicate',
    label: t('dragger.duplicate_block'),
    icon: icon('duplicate'),
    onSelect: () => {
      if (!duplicateBlock(view, line)) toast(t('dragger.could_not_duplicate'), 'danger')
      onClose()
    },
  })
  items.push({
    id: 'delete',
    label: t('dragger.delete_block'),
    icon: icon('trash'),
    tone: 'danger',
    onSelect: () => {
      if (!deleteBlock(view, line)) toast(t('dragger.could_not_delete'), 'danger')
      onClose()
    },
  })
  return items
}
