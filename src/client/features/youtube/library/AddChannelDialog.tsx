import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { formatCount, type YouTubeChannel } from '@shared/youtube/model'
import { Button, Spinner } from '../../../components/primitives'
import { Input, commitOnEnter } from '../../../components/form'
import { Modal } from '../../../components/overlay'
import { ApiError } from '../../../lib/api'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { channelIconUrl, fetchChannel } from '../api'
import { useYoutubeStore } from '../store'

/**
 * Looks a channel up by ID, handle or URL and offers it for subscription.
 *
 * The lookup is the only network work here; adding writes the same `YouTubeChannel` the worker
 * answered with, through the store's optimistic `saveChannel`. A duplicate stays visible instead of
 * erroring, because the reader may have arrived from a stale sidebar.
 */
export function AddChannelDialog({
  open,
  onClose,
  existingIds,
}: {
  open: boolean
  onClose: () => void
  existingIds: Set<string>
}) {
  const saveChannel = useYoutubeStore((state) => state.saveChannel)
  const [value, setValue] = useState('')
  const [channel, setChannel] = useState<YouTubeChannel | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A response that belongs to a lookup the reader has already replaced must not paint.
  const generationRef = useRef(0)

  useEffect(() => {
    if (open) return
    generationRef.current++
    setValue('')
    setChannel(null)
    setLoading(false)
    setSaving(false)
    setError(null)
  }, [open])

  const query = async () => {
    const reference = value.trim()
    if (!reference || loading) return
    const generation = ++generationRef.current
    setLoading(true)
    setError(null)
    setChannel(null)
    try {
      const result = await fetchChannel(reference)
      if (generation !== generationRef.current) return
      setChannel(result.channel)
    } catch (cause) {
      if (generation !== generationRef.current) return
      setError(queryError(cause))
    } finally {
      if (generation === generationRef.current) setLoading(false)
    }
  }

  const duplicate = channel ? existingIds.has(channel.id) : false

  const add = async () => {
    if (!channel || duplicate || saving) return
    setSaving(true)
    try {
      await saveChannel(channel)
      onClose()
    } catch (cause) {
      useUi.getState().toast({
        title: t('youtube.failed'),
        description: messageOf(cause),
        tone: 'danger',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('youtube.channels.add_title')}
      description={t('youtube.channels.add_desc')}
      width={480}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={!channel || duplicate}
            onClick={() => void add()}
          >
            {t('youtube.channels.add_subscription')}
          </Button>
        </>
      }
    >
      <div className="space-y-[var(--sp-3)]">
        <div className="flex gap-[var(--sp-2)]">
          <Input
            value={value}
            placeholder={t('youtube.channels.input_placeholder')}
            disabled={loading}
            onChange={(event) => {
              setValue(event.target.value)
              if (error) setError(null)
            }}
            onKeyDown={(event) => {
              commitOnEnter(event, () => {
                void query()
              })
            }}
          />
          <Button
            icon={<Search size={14} />}
            loading={loading}
            disabled={!value.trim()}
            onClick={() => void query()}
          >
            {t('youtube.channels.query')}
          </Button>
        </div>

        {loading && !channel && (
          <p
            role="status"
            className="flex items-center gap-[var(--sp-1-5)] text-[length:var(--text-11-5)] text-[var(--text-tertiary)]"
          >
            <Spinner size={12} />
            {t('common.loading')}
          </p>
        )}

        {error && (
          <p role="alert" className="text-[length:var(--text-11-5)] text-[var(--danger)]">
            {error}
          </p>
        )}

        {channel && (
          <div className="flex items-center gap-[var(--sp-3)] rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-[var(--sp-3)]">
            <img
              src={channel.thumbnailUrl || channelIconUrl(channel.id)}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              className="size-10 shrink-0 rounded-full bg-[var(--bg-hover)] object-cover"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
                {channel.title}
              </p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-[var(--sp-1-5)] text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                <span>{t('youtube.channels.video_count', { count: formatCount(channel.videoCount) })}</span>
                <span aria-hidden="true">·</span>
                <span>
                  {channel.subscriberCount < 0
                    ? t('youtube.channels.hidden_subscribers')
                    : t('youtube.channels.subscriber_count', {
                        count: formatCount(channel.subscriberCount),
                      })}
                </span>
              </p>
              {channel.customUrl && (
                <p className="mt-0.5 truncate text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                  {channel.customUrl}
                </p>
              )}
            </div>
          </div>
        )}

        {duplicate && (
          <p role="status" className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            {t('youtube.channels.already_added')}
          </p>
        )}
      </div>
    </Modal>
  )
}

/** A 404 means the reference named nothing; anything else is the route's own sentence. */
function queryError(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 404) return t('youtube.channels.not_found')
    return cause.serverMessage || cause.message
  }
  return messageOf(cause)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
