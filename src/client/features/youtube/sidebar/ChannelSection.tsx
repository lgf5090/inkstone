/** The subscribed channels: pin/reorder, a right-click menu, and a touch-reachable more button. */
import { useRef, useState, type DragEvent } from 'react'
import { ArrowDown, ArrowUp, ChevronRight, Copy, ExternalLink, MoreHorizontal, Pin, Plus, Trash2, Tv } from 'lucide-react'
import type { SavedYouTubeChannel } from '@shared/youtube/model'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { confirm, Menu, Tooltip, useContextMenu, type MenuItem } from '../../../components/overlay'
import { Button, IconButton } from '../../../components/primitives'
import { useUi } from '../../../store/ui'
import { useYoutubeStore } from '../store'
import { SidebarLink } from './SidebarLink'

export function ChannelSection({
  channels,
  activeChannelId,
  expanded,
  onToggle,
  onOpenAdd,
  onSelect,
}: {
  channels: SavedYouTubeChannel[]
  activeChannelId: string | null
  expanded: boolean
  onToggle: () => void
  onOpenAdd: () => void
  onSelect: (channelId: string) => void
}) {
  const reorderChannels = useYoutubeStore((state) => state.reorderChannels)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const ordered = channels
    .slice()
    .sort((left, right) => Number(right.pinned) - Number(left.pinned)
      || left.sortOrder - right.sortOrder
      || right.updatedAt - left.updatedAt)

  const move = (channel: SavedYouTubeChannel, direction: -1 | 1) => {
    const group = ordered.filter((entry) => entry.pinned === channel.pinned)
    const index = group.findIndex((entry) => entry.id === channel.id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= group.length) return
    const ids = group.map((entry) => entry.id)
    ;[ids[index], ids[target]] = [ids[target]!, ids[index]!]
    void reorderChannels(ids).catch(reportFailure)
  }

  const drop = (sourceId: string, target: SavedYouTubeChannel) => {
    setDraggingId(null)
    const source = ordered.find((entry) => entry.id === sourceId)
    if (!source || source.id === target.id || source.pinned !== target.pinned) return
    const rest = ordered.filter((entry) => entry.id !== sourceId)
    const targetIndex = rest.findIndex((entry) => entry.id === target.id)
    if (targetIndex < 0) return
    const sourceIndex = ordered.findIndex((entry) => entry.id === sourceId)
    const insertAt = sourceIndex < ordered.findIndex((entry) => entry.id === target.id) ? targetIndex + 1 : targetIndex
    rest.splice(insertAt, 0, source)
    void reorderChannels(rest.map((entry) => entry.id)).catch(reportFailure)
  }

  return (
    <section className="mt-2">
      <div className="flex items-center gap-1 px-1">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1 rounded-[var(--r-sm)] px-1 py-1 text-[length:var(--text-10-5)] font-semibold tracking-[0.075em] text-[var(--text-quaternary)] uppercase hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        >
          <ChevronRight
            size={12}
            aria-hidden="true"
            className={cn('shrink-0 transition-transform duration-[var(--dur-fast)]', expanded && 'rotate-90')}
          />
          <span className="truncate">{t('youtube.sidebar.channels')}</span>
        </button>
        <IconButton label={t('youtube.sidebar.add_channel')} size="xs" onClick={onOpenAdd}>
          <Plus size={13} />
        </IconButton>
      </div>
      {expanded && (
        <div className="space-y-0.5 px-1 pt-0.5">
          {ordered.length === 0 ? (
            <div className="px-1 py-1">
              <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                {t('youtube.sidebar.no_channels')}
              </p>
              <Button size="sm" variant="ghost" className="mt-1 px-0" onClick={onOpenAdd}>
                {t('youtube.sidebar.add_channel')}
              </Button>
            </div>
          ) : (
            ordered.map((channel) => {
              const group = ordered.filter((entry) => entry.pinned === channel.pinned)
              return (
              <ChannelRow
                key={channel.id}
                channel={channel}
                active={activeChannelId === channel.id}
                first={group[0]?.id === channel.id}
                last={group[group.length - 1]?.id === channel.id}
                dragging={draggingId === channel.id}
                onSelect={onSelect}
                onMove={move}
                onDragStart={() => setDraggingId(channel.id)}
                onDragEnd={() => setDraggingId(null)}
                onDrop={drop}
              />
              )
            })
          )}
        </div>
      )}
    </section>
  )
}

function ChannelRow({
  channel,
  active,
  first,
  last,
  dragging,
  onSelect,
  onMove,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  channel: SavedYouTubeChannel
  active: boolean
  first: boolean
  last: boolean
  dragging: boolean
  onSelect: (channelId: string) => void
  onMove: (channel: SavedYouTubeChannel, direction: -1 | 1) => void
  onDragStart: () => void
  onDragEnd: () => void
  onDrop: (sourceId: string, target: SavedYouTubeChannel) => void
}) {
  const updateChannel = useYoutubeStore((state) => state.updateChannel)
  const removeChannel = useYoutubeStore((state) => state.removeChannel)
  const menu = useContextMenu()
  const rowRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  const title = channel.data.title || channel.id

  const togglePin = () => {
    void updateChannel({ ...channel, pinned: !channel.pinned, updatedAt: Date.now() }).catch(reportFailure)
  }

  const remove = async () => {
    const confirmed = await confirm({
      title: t('youtube.sidebar.delete_channel_title'),
      description: t('youtube.sidebar.delete_channel_desc', { name: title }),
    })
    if (!confirmed) return
    try {
      await removeChannel(channel.id)
    } catch (error) {
      reportFailure(error)
    }
  }

  const copyLink = () => {
    const link = `https://www.youtube.com/channel/${encodeURIComponent(channel.id)}`
    if (!navigator.clipboard?.writeText) {
      reportFailure(new Error(t('youtube.sidebar.copy_link')))
      return
    }
    void navigator.clipboard.writeText(link).then(() => {
      useUi.getState().toast({ title: t('common.copied'), tone: 'success' })
    }).catch(reportFailure)
  }

  const items: MenuItem[] = [
    {
      id: 'pin',
      label: channel.pinned ? t('youtube.sidebar.unpin') : t('youtube.sidebar.pin'),
      icon: <Pin size={13} />,
      onSelect: togglePin,
    },
    {
      id: 'up',
      label: t('youtube.sidebar.move_up'),
      icon: <ArrowUp size={13} />,
      disabled: first,
      onSelect: () => onMove(channel, -1),
    },
    {
      id: 'down',
      label: t('youtube.sidebar.move_down'),
      icon: <ArrowDown size={13} />,
      disabled: last,
      onSelect: () => onMove(channel, 1),
    },
    {
      id: 'copy',
      label: t('youtube.sidebar.copy_link'),
      icon: <Copy size={13} />,
      onSelect: copyLink,
    },
    {
      id: 'open',
      label: t('youtube.sidebar.open_youtube'),
      icon: <ExternalLink size={13} />,
      onSelect: () => window.open(`https://www.youtube.com/channel/${encodeURIComponent(channel.id)}`, '_blank', 'noopener'),
    },
    {
      id: 'remove',
      label: t('youtube.sidebar.unsubscribe'),
      icon: <Trash2 size={13} />,
      tone: 'danger',
      separatorBefore: true,
      onSelect: () => { void remove() },
    },
  ]

  return (
    <div
      ref={rowRef}
      className={cn(
        'yt-sidebar-row group relative flex min-w-0 items-center rounded-[var(--r-sm)]',
        dropActive && 'ring-1 ring-[var(--accent)] bg-[var(--accent-soft)]',
        dragging && 'opacity-45',
      )}
      draggable
      onContextMenu={(event) => {
        setMenuOpen(false)
        menu.onContextMenu(event)
      }}
      onDragStart={(event: DragEvent<HTMLDivElement>) => {
        event.dataTransfer.setData('application/x-inkstone-youtube-row', channel.id)
        event.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={() => {
        setDropActive(false)
        onDragEnd()
      }}
      onDragOver={(event) => {
        event.preventDefault()
        setDropActive(true)
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDropActive(false)
        if (!event.dataTransfer.types.includes('application/x-inkstone-youtube-row')) return
        const source = event.dataTransfer.getData('application/x-inkstone-youtube-row')
        if (source) onDrop(source, channel)
      }}
    >
      <SidebarLink
        href={`/youtube/channels/${encodeURIComponent(channel.id)}`}
        label={title}
        icon={<ChannelAvatar channel={channel} />}
        badge={channel.pinned ? <Pin size={10} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]" /> : undefined}
        active={active}
        onActivate={() => onSelect(channel.id)}
        className="pr-8"
      />
      <Tooltip label={t('common.more_actions')} side="left">
        <IconButton
          label={t('common.more_actions')}
          size="xs"
          onClick={(event) => {
            event.stopPropagation()
            menu.close()
            setMenuOpen(true)
          }}
          className="absolute right-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100"
        >
          <MoreHorizontal size={12} />
        </IconButton>
      </Tooltip>
      {menuOpen && <Menu anchor={rowRef} open onClose={() => setMenuOpen(false)} items={items} align="end" />}
      {menu.point && <Menu anchor={menu.point} open onClose={menu.close} items={items} />}
    </div>
  )
}

function ChannelAvatar({ channel }: { channel: SavedYouTubeChannel }) {
  const [failed, setFailed] = useState(false)
  if (failed || !channel.data.thumbnailUrl) return <Tv size={14} />
  return (
    <img
      src={channel.data.thumbnailUrl}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="size-4 shrink-0 rounded-[var(--r-full)] object-cover"
    />
  )
}

function reportFailure(error: unknown): void {
  useUi.getState().toast({
    title: t('youtube.failed'),
    description: error instanceof Error ? error.message : String(error),
    tone: 'danger',
  })
}
