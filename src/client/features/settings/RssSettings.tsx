/**
 * The RSS section of the settings panel.
 *
 * It edits `settings.rss`, which is the reading half of the feature: what a channel opens showing,
 * how an article is set, where a saved article goes. The other half — the subscriptions themselves —
 * is not here on purpose. A list of feeds is data a reader edits where they read it, with the
 * article counts beside it, and a settings page cannot show counts it has not fetched.
 *
 * The AI key is the one credential in this panel, and it is not stored with the rest: it lives in
 * this browser only, so it cannot ride out in a backup or appear on a device the reader never typed
 * it into. The note under the field says that rather than leaving it to be inferred.
 */
import { useEffect, useState, type ReactElement } from 'react'
import { Check, PlugZap, Trash2, X } from 'lucide-react'
import {
  RSS_COLUMN_WIDTHS,
  RSS_FONT_SIZE_RANGE,
  RSS_LINE_HEIGHT_RANGE,
  RSS_LIST_WIDTH_RANGE,
  RSS_REFRESH_INTERVALS,
} from '@shared/constants'
import type { RssListDensity, RssReadingFont, RssReadingTheme, RssSortOrder } from '@shared/types'
import { Button } from '../../components/primitives'
import { Field, Input, Select, Segmented, SettingRow, Slider, Switch } from '../../components/form'
import { confirm } from '../../components/overlay'
import { formatBytes } from '../../lib/time'
import { t } from '../../lib/i18n'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { testAIConnection } from '../../lib/ai'
import { aiReady, loadAiConfig, providerForBaseUrl, saveAiConfig, type RssAiConfig } from '../rss/ai'
import { useRss } from '../rss/store'
import { SourceHealth } from '../rss/SourceHealth'

export function RssSettings(): ReactElement {
  const rss = useSession(state => state.settings.rss)
  const update = useSession(state => state.updateSettings)
  const patch = (next: Partial<typeof rss>): void => update({ rss: next })
  const library = useRss(state => state.library)
  const articles = useRss(state => state.articles)
  const [ai, setAi] = useState<RssAiConfig | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean, text: string } | null>(null)

  useEffect(() => {
    void loadAiConfig().then(setAi)
  }, [])

  const cachedFeeds = Object.keys(articles).length
  const cachedBytes = Object.values(articles)
    .reduce((total, entries) => total + entries.reduce((sum, entry) => sum + entry.content.length + entry.summary.length, 0), 0)

  const test = async (): Promise<void> => {
    if (!ai) return
    setTesting(true)
    setTestResult(null)
    const result = await testAIConnection({ provider: providerForBaseUrl(ai.baseURL), baseURL: ai.baseURL, apiKey: ai.apiKey }, ai.model)
    setTesting(false)
    setTestResult({
      ok: result.ok,
      text: result.ok ? t('rss.ai.test_ok', { ms: result.latencyMs }) : t('rss.ai.test_failed', { error: result.error ?? '' }),
    })
  }

  const clearCache = async (): Promise<void> => {
    if (!(await confirm({
      title: t('rss.settings.clear_cache'),
      description: t('rss.settings.clear_cache_confirm'),
      tone: 'danger',
      confirmLabel: t('rss.settings.clear_cache'),
    }))) return
    await useRss.getState().clearCache()
    useUi.getState().toast({ title: t('rss.settings.cache_cleared'), tone: 'success' })
  }

  return (
    <div className="space-y-6">
      <section>
        <SettingRow title={t('rss.settings.refresh')} description={t('rss.settings.refresh_hint')}>
          <Segmented
            size="sm"
            value={String(rss.refreshIntervalMinutes)}
            onChange={value => patch({ refreshIntervalMinutes: Number(value) })}
            options={RSS_REFRESH_INTERVALS.map(minutes => ({
              value: String(minutes),
              label: minutes === 0
                ? t('rss.settings.refresh_off')
                : minutes < 60
                  ? t('rss.settings.refresh_minutes', { n: minutes })
                  : t('rss.settings.refresh_hours', { n: minutes / 60 }),
            }))}
          />
        </SettingRow>
        <SettingRow title={t('rss.settings.default_filter')}>
          <Segmented
            size="sm"
            value={rss.defaultFilter}
            onChange={value => patch({ defaultFilter: value as typeof rss.defaultFilter })}
            options={[
              { value: 'all', label: t('rss.filter_all') },
              { value: 'unread', label: t('rss.filter_unread') },
              { value: 'starred', label: t('rss.filter_starred') },
            ]}
          />
        </SettingRow>
        <SettingRow title={t('rss.settings.sort')} description={t('rss.settings.sort_desc')}>
          <Select
            aria-label={t('rss.settings.sort')}
            className="min-w-36"
            value={rss.sortOrder}
            onChange={event => patch({ sortOrder: event.target.value as RssSortOrder })}
          >
            <option value="newest">{t('rss.sort_newest')}</option>
            <option value="oldest">{t('rss.sort_oldest')}</option>
            <option value="source">{t('rss.sort_source')}</option>
          </Select>
        </SettingRow>
        <SettingRow title={t('rss.settings.density')} description={t('rss.settings.density_desc')}>
          <Segmented
            size="sm"
            value={rss.density}
            onChange={value => patch({ density: value as RssListDensity })}
            options={[
              { value: 'comfortable', label: t('rss.settings.density_comfortable') },
              { value: 'compact', label: t('rss.settings.density_compact') },
            ]}
          />
        </SettingRow>
        <SettingRow title={t('rss.settings.mark_read_scroll')} description={t('rss.settings.mark_read_scroll_desc')}>
          <Switch checked={rss.markReadOnScroll} onChange={markReadOnScroll => patch({ markReadOnScroll })} label={t('rss.settings.mark_read_scroll')} />
        </SettingRow>
        <SettingRow title={t('rss.settings.mark_read')} description={t('rss.settings.mark_read_desc')}>
          <Switch checked={rss.markReadOnOpen} onChange={markReadOnOpen => patch({ markReadOnOpen })} label={t('rss.settings.mark_read')} />
        </SettingRow>
        <SettingRow title={t('rss.settings.thumbnails')} description={t('rss.settings.thumbnails_desc')}>
          <Switch checked={rss.showThumbnails} onChange={showThumbnails => patch({ showThumbnails })} label={t('rss.settings.thumbnails')} />
        </SettingRow>
        <SettingRow title={t('rss.settings.images')} description={t('rss.settings.images_desc')}>
          <Segmented
            size="sm"
            value={rss.images}
            onChange={value => patch({ images: value as typeof rss.images })}
            options={[
              { value: 'relay', label: t('rss.settings.images_relay') },
              { value: 'direct', label: t('rss.settings.images_direct') },
              { value: 'off', label: t('rss.settings.images_off') },
            ]}
          />
        </SettingRow>
      </section>

      <section>
        <SettingRow title={t('rss.theme')} description={t('rss.theme_desc')}>
          <Select
            aria-label={t('rss.theme')}
            className="min-w-36"
            value={rss.readingTheme}
            onChange={event => patch({ readingTheme: event.target.value as RssReadingTheme })}
          >
            {(['auto', 'light', 'paper', 'sage', 'mist', 'dark', 'black'] as const).map(id => (
              <option key={id} value={id}>{t(`rss.theme_${id}`)}</option>
            ))}
          </Select>
        </SettingRow>
        <SettingRow title={t('rss.font')}>
          <Select
            aria-label={t('rss.font')}
            className="min-w-36"
            value={rss.readingFont}
            onChange={event => patch({ readingFont: event.target.value as RssReadingFont })}
          >
            {(['ui', 'serif', 'sans', 'songti', 'kaiti', 'fangsong', 'mono', 'custom'] as const).map(id => (
              <option key={id} value={id}>{t(`rss.font_${id}`)}</option>
            ))}
          </Select>
        </SettingRow>
        {rss.readingFont === 'custom' && (
          <SettingRow title={t('rss.custom_font')} description={t('rss.custom_font_desc')}>
            <Input
              className="w-[180px]"
              value={rss.customFont}
              onChange={event => patch({ customFont: event.target.value.slice(0, 80) })}
              placeholder={t('rss.custom_font_placeholder')}
              aria-label={t('rss.custom_font')}
            />
          </SettingRow>
        )}
        <SettingRow title={t('rss.list_width')} description={`${rss.listWidth}px`}>
          <Slider
            className="w-[180px]"
            value={rss.listWidth}
            min={RSS_LIST_WIDTH_RANGE[0]}
            max={RSS_LIST_WIDTH_RANGE[1]}
            step={10}
            onChange={listWidth => patch({ listWidth })}
            label={t('rss.list_width')}
          />
        </SettingRow>
        <SettingRow title={t('rss.font_size')} description={`${rss.fontSize}px`}>
          <Slider
            className="w-[180px]"
            value={rss.fontSize}
            min={RSS_FONT_SIZE_RANGE[0]}
            max={RSS_FONT_SIZE_RANGE[1]}
            onChange={fontSize => patch({ fontSize })}
            label={t('rss.font_size')}
          />
        </SettingRow>
        <SettingRow title={t('rss.line_height')} description={rss.lineHeight.toFixed(2)}>
          <Slider
            className="w-[180px]"
            value={rss.lineHeight}
            min={RSS_LINE_HEIGHT_RANGE[0]}
            max={RSS_LINE_HEIGHT_RANGE[1]}
            step={0.05}
            onChange={lineHeight => patch({ lineHeight })}
            label={t('rss.line_height')}
          />
        </SettingRow>
        <SettingRow title={t('rss.measure')}>
          <Segmented
            size="sm"
            value={String(rss.columnWidth)}
            onChange={value => patch({ columnWidth: Number(value) as typeof rss.columnWidth })}
            options={RSS_COLUMN_WIDTHS.map(width => ({ value: String(width), label: t('rss.measure_n', { n: width }) }))}
          />
        </SettingRow>
      </section>

      <section>
        <SettingRow title={t('rss.settings.article_folder')} description={t('rss.settings.article_folder_desc')}>
          <Input
            className="w-[180px]"
            value={rss.articleFolder}
            onChange={event => patch({ articleFolder: event.target.value.slice(0, 120) })}
            aria-label={t('rss.settings.article_folder')}
            placeholder="RSS"
          />
        </SettingRow>
        <SettingRow title={t('rss.settings.daily_note')} description={t('rss.settings.daily_note_desc')}>
          <Input
            className="w-[180px]"
            value={rss.dailyNoteTitle}
            onChange={event => patch({ dailyNoteTitle: event.target.value.slice(0, 60) })}
            aria-label={t('rss.settings.daily_note')}
            placeholder="YYYY-MM-DD"
          />
        </SettingRow>
      </section>

      <section>
        <SettingRow title={t('rss.ai.settings')} description={t('rss.ai.settings_hint')}>
          <Switch checked={rss.aiEnabled} onChange={aiEnabled => patch({ aiEnabled })} label={t('rss.ai.enabled')} />
        </SettingRow>
        {rss.aiEnabled && (
          <div className="mt-3 space-y-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
            <Field label={t('rss.ai.base_url')} hint={t('rss.ai.local_only')}>
              <Input
                value={ai?.baseURL ?? ''}
                onChange={event => setAi(current => ({ ...(current ?? EMPTY_AI), baseURL: event.target.value }))}
                placeholder="https://api.deepseek.com"
              />
            </Field>
            <div className="flex flex-wrap gap-3">
              <Field label={t('rss.ai.model')} className="min-w-[180px] flex-1">
                <Input
                  value={ai?.model ?? ''}
                  onChange={event => setAi(current => ({ ...(current ?? EMPTY_AI), model: event.target.value }))}
                  placeholder="deepseek-chat"
                />
              </Field>
              <Field label={t('rss.ai.api_key')} className="min-w-[220px] flex-[2]">
                <Input
                  type="password"
                  value={ai?.apiKey ?? ''}
                  onChange={event => setAi(current => ({ ...(current ?? EMPTY_AI), apiKey: event.target.value }))}
                  autoComplete="off"
                />
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                icon={<PlugZap size={13} />}
                loading={testing}
                disabled={!ai || !aiReady(ai)}
                onClick={() => void test()}
              >
                {t('rss.ai.test')}
              </Button>
              {testResult && (
                <span className="inline-flex min-w-0 items-center gap-1 text-[11.5px] text-[var(--text-secondary)]">
                  {testResult.ok ? <Check size={12} /> : <X size={12} />}
                  <span className="truncate">{testResult.text}</span>
                </span>
              )}
              <Button
                size="sm"
                className="ml-auto"
                disabled={!ai}
                onClick={() => {
                  if (!ai) return
                  void saveAiConfig({ ...ai, provider: providerForBaseUrl(ai.baseURL) })
                  useUi.getState().toast({ title: t('rss.ai.saved'), tone: 'success' })
                }}
              >
                {t('common.save')}
              </Button>
            </div>
            <SettingRow title={t('rss.ai.language')}>
              <Segmented
                size="sm"
                value={rss.aiLanguage}
                onChange={value => patch({ aiLanguage: value as typeof rss.aiLanguage })}
                options={[
                  { value: 'source', label: t('rss.ai.language_source') },
                  { value: 'interface', label: t('rss.ai.language_interface') },
                ]}
              />
            </SettingRow>
          </div>
        )}
      </section>

      <SourceHealth />

      <section>
        <SettingRow
          title={t('rss.settings.cache')}
          description={t('rss.settings.cache_size', { size: formatBytes(cachedBytes) }) + ` · ${t('rss.subscriptions_count', { n: library.feeds.length })} · ${cachedFeeds}`}
        >
          <Button size="sm" variant="danger" icon={<Trash2 size={13} />} onClick={() => void clearCache()}>
            {t('rss.settings.clear_cache')}
          </Button>
        </SettingRow>
      </section>
    </div>
  )
}

const EMPTY_AI: RssAiConfig = { provider: 'deepseek', baseURL: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-chat' }

