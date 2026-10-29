import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ListVideo, Search } from 'lucide-react'
import { formatCount, type YouTubePlaylist } from '@shared/youtube/model'
import { Button } from '../../../components/primitives'
import { Input, commitOnEnter } from '../../../components/form'
import { Modal } from '../../../components/overlay'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { fetchChannelPlaylists, fetchPlaylist } from '../api'
import { useYoutubeStore } from '../store'

/**
 * Collects playlists from a channel, or one playlist pasted as a URL.
 *
 * A pasted playlist link is resolved with one metadata request when it is added, so the sidebar shows
 * the playlist's real title rather than its id. A channel reference lists 25 playlists per page and
 * appends on demand. Adding keeps the dialog open so several playlists can be saved in one pass.
 */
export function AddPlaylistDialog({
  open,
  onClose,
  existingIds,
}: {
  open: boolean
  onClose: () => void
  existingIds: Set<string>
}) {
  const savePlaylist = useYoutubeStore((state) => state.savePlaylist)
  const [value, setValue] = useState('')
  const [playlists, setPlaylists] = useState<YouTubePlaylist[]>([])
  const [nextPageToken, setNextPageToken] = useState<string | null>(null)
  const [queried, setQueried] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [addedIds, setAddedIds] = useState<string[]>([])
  const [savingId, setSavingId] = useState<string | null>(null)
  // Late pages of a lookup the reader has replaced must not append to the new list.
  const generationRef = useRef(0)

  useEffect(() => {
    if (open) return
    generationRef.current++
    setValue('')
    setPlaylists([])
    setNextPageToken(null)
    setQueried(false)
    setLoading(false)
    setError(null)
    setAddedIds([])
    setSavingId(null)
  }, [open])

  const directId = useMemo(() => extractPlaylistId(value), [value])
  const direct = useMemo(() => (directId ? barePlaylist(directId) : null), [directId])
  const rows = direct ? [direct] : playlists

  const lookup = async (pageToken?: string) => {
    if (loading) return
    const reference = channelReference(value)
    if (!reference) return
    const generation = ++generationRef.current
    setLoading(true)
    setError(null)
    if (!pageToken) {
      setPlaylists([])
      setNextPageToken(null)
      setQueried(false)
    }
    try {
      const result = await fetchChannelPlaylists(reference, pageToken)
      if (generation !== generationRef.current) return
      setPlaylists((previous) => (pageToken ? [...previous, ...result.items] : result.items))
      setNextPageToken(result.nextPageToken)
      setQueried(true)
    } catch (cause) {
      if (generation === generationRef.current) setError(messageOf(cause))
    } finally {
      if (generation === generationRef.current) setLoading(false)
    }
  }

  const query = () => {
    if (directId) return
    void lookup()
  }

  const add = async (playlist: YouTubePlaylist) => {
    if (existingIds.has(playlist.id) || addedIds.includes(playlist.id) || savingId) return
    setSavingId(playlist.id)
    try {
      const target = direct && playlist.id === directId
        ? (await fetchPlaylist(playlist.id)).playlist
        : playlist
      await savePlaylist(target)
      setAddedIds((previous) =>
        previous.includes(playlist.id) ? previous : [...previous, playlist.id],
      )
    } catch (cause) {
      useUi.getState().toast({
        title: t('youtube.failed'),
        description: messageOf(cause),
        tone: 'danger',
      })
    } finally {
      setSavingId(null)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('youtube.playlists.add_title')}
      description={t('youtube.playlists.add_desc')}
      width={560}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      <div className="space-y-[var(--sp-3)]">
        <div className="flex gap-[var(--sp-2)]">
          <Input
            value={value}
            placeholder={t('youtube.playlists.input_placeholder')}
            disabled={loading}
            onChange={(event) => {
              setValue(event.target.value)
              if (error) setError(null)
            }}
            onKeyDown={(event) => {
              commitOnEnter(event, query)
            }}
          />
          <Button
            icon={<Search size={14} />}
            loading={loading && !direct}
            disabled={!value.trim() || Boolean(directId)}
            onClick={query}
          >
            {t('youtube.playlists.query')}
          </Button>
        </div>

        {error && (
          <p role="alert" className="text-[length:var(--text-11-5)] text-[var(--danger)]">
            {error}
          </p>
        )}

        {rows.length > 0 && (
          <ul
            role="list"
            aria-busy={loading}
            className="max-h-[min(360px,50vh)] divide-y divide-[var(--border-subtle)] overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-subtle)]"
          >
            {rows.map((playlist) => {
              const exists = existingIds.has(playlist.id) || addedIds.includes(playlist.id)
              return (
                <li
                  key={playlist.id}
                  className="flex items-center gap-[var(--sp-2-5)] bg-[var(--bg-sunken)] p-[var(--sp-2)]"
                >
                  <div className="flex h-[54px] w-[96px] shrink-0 items-center justify-center overflow-hidden rounded-[var(--r-sm)] bg-[var(--bg-hover)]">
                    {playlist.thumbnailUrl ? (
                      <img
                        src={playlist.thumbnailUrl}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        className="size-full object-cover"
                      />
                    ) : (
                      <ListVideo size={18} aria-hidden="true" className="text-[var(--text-quaternary)]" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
                      {playlist.title}
                    </p>
                    {(playlist.channelTitle || playlist.itemCount > 0) && (
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-[var(--sp-1-5)] text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                        {playlist.channelTitle && (
                          <span className="truncate">{playlist.channelTitle}</span>
                        )}
                        {playlist.channelTitle && <span aria-hidden="true">·</span>}
                        <span>
                          {t('youtube.playlists.video_count', {
                            count: formatCount(playlist.itemCount),
                          })}
                        </span>
                      </p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant={exists ? 'ghost' : 'secondary'}
                    icon={exists ? <Check size={13} /> : undefined}
                    loading={savingId === playlist.id}
                    disabled={exists}
                    className={cn('shrink-0', exists && 'text-[var(--success)]')}
                    onClick={() => void add(playlist)}
                  >
                    {exists ? t('youtube.playlists.already_added') : t('youtube.playlists.add')}
                  </Button>
                </li>
              )
            })}
          </ul>
        )}

        {!direct && queried && playlists.length === 0 && !loading && !error && (
          <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            {t('youtube.playlists.empty')}
          </p>
        )}

        {!direct && nextPageToken && (
          <div className="flex justify-center">
            <Button
              size="sm"
              variant="secondary"
              loading={loading}
              onClick={() => void lookup(nextPageToken)}
            >
              {t('youtube.playlists.load_more')}
            </Button>
          </div>
        )}
      </div>
    </Modal>
  )
}

/** A playlist link carries its own ID in `list=`; the rest of the URL is not needed. */
function extractPlaylistId(value: string): string | null {
  const match = /(?:^|[?&\s])list=([A-Za-z0-9_-]{6,64})/.exec(value.trim())
  return match?.[1] ?? null
}

/**
 * A channel URL names its ID in the path; the playlists route takes only the ID. Handles and other
 * references are handed over as typed — the route answers with its own explanation.
 */
function channelReference(value: string): string {
  const trimmed = value.trim()
  const match = /youtube\.com\/channel\/([A-Za-z0-9_-]{6,64})/.exec(trimmed)
  return match?.[1] ?? trimmed
}

/**
 * The row a pasted link can add without a lookup. Only the ID is known, so the title is the ID and
 * the next read of the library replaces both with the playlist's own metadata.
 */
function barePlaylist(id: string): YouTubePlaylist {
  return {
    id,
    title: id,
    description: '',
    channelId: '',
    channelTitle: '',
    thumbnailUrl: '',
    itemCount: 0,
    publishedAt: '',
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
