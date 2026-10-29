import { useState } from 'react'
import { ChevronRight, Pin, Plus, Trash2, Tv } from 'lucide-react'
import type { SavedYouTubeChannel } from '@shared/youtube/model'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { confirm } from '../../../components/overlay'
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
  const updateChannel = useYoutubeStore((state) => state.updateChannel)
  const removeChannel = useYoutubeStore((state) => state.removeChannel)
  const ordered = channels
    .slice()
    .sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.updatedAt - left.updatedAt)

  const togglePin = async (channel: SavedYouTubeChannel) => {
    try {
      await updateChannel({ ...channel, pinned: !channel.pinned, updatedAt: Date.now() })
    } catch (error) {
      reportFailure(error)
    }
  }

  const remove = async (channel: SavedYouTubeChannel) => {
    const title = channel.data.title || channel.id
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
            ordered.map((channel) => (
              <div key={channel.id} className="yt-sidebar-row relative flex min-w-0 items-center">
                <SidebarLink
                  href={`/youtube/channels/${encodeURIComponent(channel.id)}`}
                  label={channel.data.title || channel.id}
                  icon={<ChannelAvatar channel={channel} />}
                  badge={
                    channel.pinned ? (
                      <Pin size={10} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]" />
                    ) : undefined
                  }
                  active={activeChannelId === channel.id}
                  onActivate={() => onSelect(channel.id)}
                  className="pr-14"
                />
                <div className="yt-row-actions absolute right-0.5 flex items-center gap-0.5">
                  <IconButton
                    label={channel.pinned ? t('youtube.sidebar.unpin') : t('youtube.sidebar.pin')}
                    size="xs"
                    active={channel.pinned}
                    onClick={(event) => {
                      event.stopPropagation()
                      void togglePin(channel)
                    }}
                  >
                    <Pin size={12} />
                  </IconButton>
                  <IconButton
                    label={t('youtube.sidebar.unsubscribe')}
                    size="xs"
                    onClick={(event) => {
                      event.stopPropagation()
                      void remove(channel)
                    }}
                  >
                    <Trash2 size={12} />
                  </IconButton>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </section>
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
