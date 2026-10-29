/**
 * The YouTube settings dialog: the instance API connection for the owner, and this browser's
 * defaults and layout for everyone.
 */
import { useEffect, useRef, useState } from 'react'
import { KeyRound, RefreshCw } from 'lucide-react'
import type { MessageKey } from '@shared/locales/en-US'
import {
  SORT_KEYS,
  TIME_RANGES,
  type SortKey,
  type TimeRange,
} from '@shared/youtube/model'
import type { YouTubeSettingsPatch, YouTubeSettingsView } from '@shared/youtube/settings'
import { Badge, Button } from '../../../components/primitives'
import { Field, Input, Select, Switch } from '../../../components/form'
import { Modal } from '../../../components/overlay'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { useYoutubeStore } from '../store'
import { fetchYouTubeSettings, updateYouTubeSettings } from '../api'
import { YOUTUBE_SIDEBAR_WIDTH, YOUTUBE_SPLIT_RATIO } from '../prefs'

const SORT_LABELS: Record<SortKey, MessageKey> = {
  relevance: 'youtube.sort.relevance',
  date: 'youtube.sort.date',
  viewCount: 'youtube.sort.view_count',
  rating: 'youtube.sort.rating',
}

const RANGE_LABELS: Record<TimeRange, MessageKey> = {
  today: 'youtube.range.today',
  week: 'youtube.range.week',
  month: 'youtube.range.month',
  quarter: 'youtube.range.quarter',
  year: 'youtube.range.year',
  all: 'youtube.range.all',
}

export function YouTubeSettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const sort = useYoutubeStore((state) => state.sort)
  const range = useYoutubeStore((state) => state.range)
  const showComments = useYoutubeStore((state) => state.showComments)
  const setPrefs = useYoutubeStore((state) => state.setPrefs)
  const [data, setData] = useState<YouTubeSettingsView | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [region, setRegion] = useState('')
  const [quota, setQuota] = useState('')
  const [saving, setSaving] = useState(false)
  const generation = useRef(0)

  useEffect(() => {
    if (!open) {
      generation.current++
      setApiKey('')
      setError(null)
      return
    }
    const current = ++generation.current
    setLoading(true)
    setError(null)
    void fetchYouTubeSettings()
      .then((next) => {
        if (current !== generation.current) return
        setData(next)
        setRegion(next.api.region ?? '')
        setQuota(String(next.api.dailyQuota))
      })
      .catch((cause) => {
        if (current === generation.current) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (current === generation.current) setLoading(false)
      })
  }, [open])

  const fail = (cause: unknown) => {
    useUi.getState().toast({
      title: t('youtube.failed'),
      description: cause instanceof Error ? cause.message : String(cause),
      tone: 'danger',
    })
  }

  const saveApi = async (patch: YouTubeSettingsPatch, success: 'saved' | 'key_saved' | 'key_removed') => {
    if (saving) return
    setSaving(true)
    try {
      const next = await updateYouTubeSettings(patch)
      setData(next)
      setRegion(next.api.region ?? '')
      setQuota(String(next.api.dailyQuota))
      setApiKey('')
      useUi.getState().toast({
        title: success === 'key_saved'
          ? t('youtube.settings.key_saved')
          : success === 'key_removed'
            ? t('youtube.settings.key_removed')
            : t('youtube.settings.saved'),
        tone: 'success',
      })
    }
    catch (cause) {
      fail(cause)
    }
    finally {
      setSaving(false)
    }
  }

  const save = () => {
    if (!data?.canEdit) return
    const patch: YouTubeSettingsPatch = {
      regionCode: region.trim() ? region.trim().toUpperCase() : null,
      dailyQuota: quota.trim() ? Number(quota) : null,
    }
    const trimmed = apiKey.trim()
    if (trimmed) patch.apiKey = trimmed
    void saveApi(patch, patch.apiKey ? 'key_saved' : 'saved')
  }

  const removeKey = () => {
    if (!data?.canEdit || !data.api.hasStoredKey) return
    void saveApi({ apiKey: null }, 'key_removed')
  }

  const resetLayout = () => {
    setPrefs({
      sidebarWidth: YOUTUBE_SIDEBAR_WIDTH.default,
      sidebarCollapsed: false,
      splitRatio: YOUTUBE_SPLIT_RATIO.default,
    })
    useUi.getState().toast({ title: t('youtube.settings.layout_reset'), tone: 'success' })
  }

  const sourceLabel = !data
    ? ''
    : data.api.source === 'stored'
      ? t('youtube.settings.key_stored')
      : data.api.source === 'env'
        ? t('youtube.settings.key_env')
        : t('youtube.settings.key_none')

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('youtube.settings.title')}
      width={640}
      footer={<Button variant="secondary" onClick={onClose}>{t('common.close')}</Button>}
    >
      {loading && !data ? (
        <div className="flex items-center justify-center gap-2 py-12 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          <RefreshCw size={14} className="animate-[ink-spin_0.7s_linear_infinite]" />
          {t('common.loading')}
        </div>
      ) : error ? (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <p className="text-[length:var(--text-12)] text-[var(--danger)]">{t('youtube.settings.load_failed')}</p>
          <p className="max-w-[44ch] text-[length:var(--text-11)] text-[var(--text-quaternary)]">{error}</p>
          <Button variant="secondary" size="sm" onClick={() => { setData(null); void fetchYouTubeSettings().then(setData).catch(fail) }}>
            {t('common.retry')}
          </Button>
        </div>
      ) : data ? (
        <div className="space-y-[var(--sp-5)]">
          <section aria-label={t('youtube.settings.api_section')} className="space-y-[var(--sp-3)]">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
                {t('youtube.settings.api_section')}
              </h3>
              <Badge tone={data.api.configured ? 'success' : 'warning'}>
                {data.api.configured ? t('youtube.settings.key_configured') : t('youtube.settings.key_none')}
              </Badge>
              <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{sourceLabel}</span>
            </div>
            <p className="text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
              {t('youtube.settings.api_desc')}
            </p>
            {!data.canEdit && (
              <p className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
                {t('youtube.settings.owner_only')}
              </p>
            )}
            {data.canEdit && !data.api.vaultAvailable && (
              <p className="text-[length:var(--text-11-5)] text-[var(--danger)]">
                {t('youtube.settings.vault_required')}
              </p>
            )}
            <Field label={t('youtube.settings.key')} hint={data.api.hasStoredKey ? t('youtube.settings.key_stored') : undefined}>
              <Input
                type="password"
                value={apiKey}
                disabled={!data.canEdit || !data.api.vaultAvailable}
                placeholder={t('youtube.settings.key_placeholder')}
                autoComplete="new-password"
                onChange={(event) => setApiKey(event.target.value)}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                icon={<KeyRound size={13} />}
                loading={saving}
                disabled={!data.canEdit || !apiKey.trim()}
                onClick={save}
              >
                {t('youtube.settings.save')}
              </Button>
              {data.api.hasStoredKey && (
                <Button size="sm" variant="ghost" disabled={!data.canEdit || saving} onClick={removeKey}>
                  {t('youtube.settings.key_remove')}
                </Button>
              )}
            </div>
            <div className="grid gap-[var(--sp-3)] sm:grid-cols-2">
              <Field label={t('youtube.settings.region')} hint={t('youtube.settings.region_hint')}>
                <Input
                  value={region}
                  disabled={!data.canEdit}
                  maxLength={2}
                  placeholder="US"
                  onChange={(event) => setRegion(event.target.value.toUpperCase())}
                />
              </Field>
              <Field label={t('youtube.settings.daily_quota')} hint={t('youtube.settings.daily_quota_hint')}>
                <Input
                  type="number"
                  min={1}
                  max={1_000_000}
                  value={quota}
                  disabled={!data.canEdit}
                  onChange={(event) => setQuota(event.target.value)}
                />
              </Field>
            </div>
            {data.canEdit && (
              <div className="flex justify-end">
                <Button size="sm" variant="secondary" loading={saving} onClick={save}>
                  {t('youtube.settings.save')}
                </Button>
              </div>
            )}
            <p className="pt-1 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('youtube.settings.deployment')}</p>
            <dl className="grid gap-x-[var(--sp-3)] gap-y-[var(--sp-1)] rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-[var(--sp-3)] text-[length:var(--text-11)] sm:grid-cols-[auto_1fr]">
              <dt className="text-[var(--text-tertiary)]">{t('youtube.settings.api_base')}</dt>
              <dd className="truncate text-[var(--text-secondary)]">{data.api.apiBase}</dd>
              <dt className="text-[var(--text-tertiary)]">{t('youtube.settings.image_base')}</dt>
              <dd className="truncate text-[var(--text-secondary)]">{data.api.imageBase}</dd>
              <dt className="text-[var(--text-tertiary)]">{t('youtube.settings.vault')}</dt>
              <dd className="text-[var(--text-secondary)]">{data.api.vaultAvailable ? t('youtube.settings.available') : t('youtube.settings.unavailable')}</dd>
              <dt className="text-[var(--text-tertiary)]">{t('youtube.settings.r2')}</dt>
              <dd className="text-[var(--text-secondary)]">{data.api.r2Available ? t('youtube.settings.available') : t('youtube.settings.unavailable')}</dd>
              <dt className="text-[var(--text-tertiary)]">{t('youtube.settings.search_limit')}</dt>
              <dd className="text-[var(--text-secondary)]">{t('youtube.settings.search_limit_value')}</dd>
            </dl>
          </section>

          <section aria-label={t('youtube.settings.defaults')} className="space-y-[var(--sp-3)] border-t border-[var(--border-subtle)] pt-[var(--sp-4)]">
            <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
              {t('youtube.settings.defaults')}
            </h3>
            <div className="grid gap-[var(--sp-3)] sm:grid-cols-2">
              <Field label={t('youtube.settings.default_sort')}>
                <Select value={sort} onChange={(event) => setPrefs({ sort: event.target.value as SortKey })}>
                  {SORT_KEYS.map((key) => (
                    <option key={key} value={key}>{t(SORT_LABELS[key])}</option>
                  ))}
                </Select>
              </Field>
              <Field label={t('youtube.settings.default_range')}>
                <Select value={range} onChange={(event) => setPrefs({ range: event.target.value as TimeRange })}>
                  {TIME_RANGES.map((key) => (
                    <option key={key} value={key}>{t(RANGE_LABELS[key])}</option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{t('youtube.settings.show_comments')}</p>
                <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('youtube.settings.show_comments_hint')}</p>
              </div>
              <Switch
                checked={showComments}
                onChange={(next) => setPrefs({ showComments: next })}
                label={t('youtube.settings.show_comments')}
              />
            </div>
            <div className="flex justify-end">
              <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={resetLayout}>
                {t('youtube.settings.reset_layout')}
              </Button>
            </div>
          </section>
        </div>
      ) : null}
    </Modal>
  )
}
