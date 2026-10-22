import { useRef, useState, type ReactElement } from 'react'
import {
  Archive,
  Copy,
  Link2,
  ListChecks,
  ListX,
  MoreHorizontal,
  Pencil,
  Pin,
  RotateCcw,
  Share2,
  Trash2,
} from 'lucide-react'
import { MEMOS_APP_PATH } from '@shared/memos/constants'
import type { Memo } from '@shared/memos/types'
import { IconButton } from '../../../components/primitives'
import { Menu, confirm, type MenuItem } from '../../../components/overlay'
import { copyText } from '../../../lib/clipboard'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { useMemos } from '../state'
import { setAllMemoTasks } from '../task-toggle'
import { MemoShareDialog } from './MemoShareDialog'

export interface MemoCardActionsProps {
  memo: Memo
  onEdit?: () => void
  onDeleted?: () => void
}

export function MemoCardActions({ memo, onEdit, onDeleted }: MemoCardActionsProps): ReactElement {
  const [open, setOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const notify = (title: string, tone: 'default' | 'success' | 'danger', description?: string): void => {
    useUi.getState().toast({ title, tone, description })
  }
  const failed = (): void => {
    notify(
      t('memos.card.action_failed'),
      'danger',
      useMemos.getState().mutationError ?? undefined,
    )
  }

  const togglePin = async (): Promise<void> => {
    const saved = await useMemos.getState().patch(memo.id, { rev: memo.rev, pinned: !memo.pinned })
    if (!saved) failed()
  }

  const setAllTasks = async (checked: boolean): Promise<void> => {
    const content = setAllMemoTasks(memo.content, checked)
    if (!content) {
      failed()
      return
    }
    const saved = await useMemos.getState().patch(memo.id, { rev: memo.rev, content })
    if (saved) {
      notify(
        t(checked ? 'memos.card.tasks_checked' : 'memos.card.tasks_unchecked'),
        'success',
      )
    } else {
      failed()
    }
  }

  const archive = async (): Promise<void> => {
    const saved = await useMemos.getState().patch(memo.id, { rev: memo.rev, state: 'archived' })
    if (saved) notify(t('memos.card.archived'), 'success')
    else failed()
  }

  const restore = async (): Promise<void> => {
    const saved = await useMemos.getState().restore(memo.id)
    if (saved) notify(t('memos.card.restored'), 'success')
    else failed()
  }

  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: t('memos.card.delete_title'),
      description: t('memos.card.delete_description'),
      confirmLabel: t('memos.card.delete_confirm'),
      tone: 'danger',
    })
    if (!ok) return
    const removed = await useMemos.getState().remove(memo.id)
    if (removed) {
      notify(t('memos.card.deleted'), 'success')
      onDeleted?.()
      return
    }
    notify(t('memos.card.delete_failed'), 'danger', useMemos.getState().mutationError ?? undefined)
  }

  const copy = async (text: string, title: string): Promise<void> => {
    const ok = await copyText(text)
    if (ok) notify(title, 'success')
    else notify(t('memos.card.copy_failed'), 'danger')
  }

  const items: MenuItem[] = []
  if (memo.state === 'normal') {
    if (onEdit) {
      items.push({ id: 'edit', label: t('memos.card.edit'), icon: <Pencil size={13} />, onSelect: onEdit })
    }
    items.push({
      id: 'pin',
      label: memo.pinned ? t('memos.card.unpin') : t('memos.card.pin'),
      icon: <Pin size={13} />,
      onSelect: () => void togglePin(),
    })
    if (memo.properties.hasTaskList) {
      items.push({
        id: 'check-all-tasks',
        label: t('memos.card.check_all_tasks'),
        icon: <ListChecks size={13} />,
        separatorBefore: true,
        onSelect: () => void setAllTasks(true),
      })
      items.push({
        id: 'uncheck-all-tasks',
        label: t('memos.card.uncheck_all_tasks'),
        icon: <ListX size={13} />,
        onSelect: () => void setAllTasks(false),
      })
    }
    items.push({
      id: 'archive',
      label: t('memos.card.archive'),
      icon: <Archive size={13} />,
      onSelect: () => void archive(),
    })
  } else {
    items.push({
      id: 'restore',
      label: t('memos.card.restore'),
      icon: <RotateCcw size={13} />,
      onSelect: () => void restore(),
    })
  }
  items.push({
    id: 'copy-link',
    label: t('memos.card.copy_link'),
    icon: <Link2 size={13} />,
    separatorBefore: true,
    onSelect: () => void copy(`${window.location.origin}${MEMOS_APP_PATH}/m/${encodeURIComponent(memo.id)}`, t('memos.card.link_copied')),
  })
  if (memo.state === 'normal') {
    items.push({
      id: 'share',
      label: t('memos.share.card_action'),
      icon: <Share2 size={13} />,
      onSelect: () => setShareOpen(true),
    })
  }
  items.push({
    id: 'copy-content',
    label: t('memos.card.copy_content'),
    icon: <Copy size={13} />,
    onSelect: () => void copy(memo.content, t('memos.card.content_copied')),
  })
  items.push({
    id: 'delete',
    label: t('memos.common.delete'),
    icon: <Trash2 size={13} />,
    tone: 'danger',
    separatorBefore: true,
    onSelect: () => void remove(),
  })

  return (
    <>
      <IconButton
        ref={anchorRef}
        label={t('memos.card.actions')}
        size="sm"
        active={open}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={15} />
      </IconButton>
      <Menu
        anchor={anchorRef}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        label={t('memos.card.actions')}
        align="end"
        width={196}
      />
      <MemoShareDialog memoId={memo.id} memo={memo} open={shareOpen} onClose={() => setShareOpen(false)} />
    </>
  )
}
