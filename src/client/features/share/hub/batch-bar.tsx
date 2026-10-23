import { FolderClosed, Pause, Play, X } from 'lucide-react'
import type { ShareFolder } from '@shared/share-hub'
import { Button } from '../../../components/primitives'
import { Menu } from '../../../components/overlay'
import { useRef, useState } from 'react'
import { t } from '../../../lib/i18n'

/**
 * The bar a selection answers with.
 *
 * It reports the count it was given rather than the count the user clicked, because a selection can
 * outlive the rows it named: pause a link from another device, come back, and "6 selected" that acts
 * on 4 is a lie the owner only discovers afterwards. The caller passes the number that will actually
 * be sent.
 */
export function BatchBar(props: {
  count: number
  folders: ShareFolder[]
  onPause: () => void
  onResume: () => void
  onFile: (folderId: string) => void
  onUnfile: () => void
  onRevoke: () => void
  onClear: () => void
  busy: boolean
}) {
  if (!props.count) return null
  const anchor = useRef<HTMLButtonElement | null>(null)
  const [folderMenu, setFolderMenu] = useState(false)

  const folderItems = [
    ...props.folders.map((folder) => ({
      id: folder.id,
      label: folder.name,
      onSelect: () => props.onFile(folder.id),
    })),
    { id: '__none__', label: t('share.hub_batch_unfile'), onSelect: props.onUnfile },
  ]

  return (
    <div
      role="toolbar"
      aria-label={t('share.hub_batch_label')}
      className="flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-2"
    >
      <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
        {t('share.hub_batch_count', { count: props.count })}
      </span>

      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          icon={<Pause size={12}/>}
          disabled={props.busy}
          onClick={props.onPause}
        >
          {t('share.hub_batch_pause')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={<Play size={12}/>}
          disabled={props.busy}
          onClick={props.onResume}
        >
          {t('share.hub_batch_resume')}
        </Button>

        <div className="relative">
          <Button
            ref={anchor}
            variant="ghost"
            size="sm"
            icon={<FolderClosed size={12}/>}
            aria-haspopup="menu"
            aria-expanded={folderMenu}
            disabled={props.busy}
            onClick={() => setFolderMenu((value) => !value)}
          >
            {t('share.hub_batch_file')}
          </Button>
          <Menu
            anchor={anchor}
            open={folderMenu}
            onClose={() => setFolderMenu(false)}
            items={folderItems}
            label={t('share.hub_batch_file')}
            align="end"
          />
        </div>

        <Button
          variant="ghost"
          size="sm"
          className="text-[var(--danger)]"
          disabled={props.busy}
          onClick={props.onRevoke}
        >
          {t('share.hub_batch_revoke')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={<X size={12}/>}
          onClick={props.onClear}
        >
          {t('share.hub_batch_clear')}
        </Button>
      </div>
    </div>
  )
}
