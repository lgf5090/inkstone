/**
 * The reader: one article, and the things a reader does with it.
 *
 * The body is drawn with the notebook's own prose styles rather than a copy of them, so an article
 * and a note read as one library. The size, measure and spacing the reader picks are written as the
 * three prose custom properties on this container only — a change here is a change to how articles
 * look, not to how the editor looks.
 *
 * Every action in the toolbar is a question about one article, which is why they live here and not
 * on the list rows. The three that touch the notebook (save, add to today, excerpt) go through the
 * notes module, which is where the dedupe rules are; the two that ask a model go through the AI
 * module, which refuses to say anything until the reader has configured a key.
 */
import type { MessageKey } from '@shared/locales/en-US'
import type { RssReadingTheme } from '@shared/types'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  AudioLines,
  EyeOff,
  Focus,
  Bookmark,
  BookOpen,
  Check,
  ExternalLink,
  FileType2,
  Link2,
  NotebookPen,
  PlayCircle,
  RefreshCw,
  Sparkles,
  Star,
  Type,
  Undo2,
} from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { Button, IconButton } from '../../components/primitives'
import { Drawer } from '../../components/overlay'
import { Field, Input, Segmented, Select, Slider } from '../../components/form'
import { fullTime, shortSince } from '../../lib/time'
import { RSS_COLUMN_WIDTHS, RSS_FONT_SIZE_RANGE, RSS_LINE_HEIGHT_RANGE } from '@shared/constants'
import { readingMinutes, wordCount } from './sanitize'
import { channelEntries, channelKey, findFeed, remoteContentKey, stepIndex } from '@shared/rss/reading'
import { api } from '../../lib/api'
import { articleDisplayHtml } from './sanitize'
import { appendToDailyNote, dailyNoteTitle, openSavedNote, savedNoteId, saveArticleAsNote } from './notes'
import { aiReady, loadAiConfig, runArticleAi, type RssAiKind } from './ai'
import { useRss, type RssReadingVersion } from './store'
import { ExcerptPopup } from './ExcerptPopup'
import { reloadEntry } from './rssMenus'
import { playableAudio, videoLinkOf } from './media'

const FONTS = ['ui', 'serif', 'sans', 'songti', 'kaiti', 'fangsong', 'mono', 'custom'] as const
/** [id, paper, ink] — the sample a reader clicks is the colour the page will actually take. */
const THEME_SWATCHES: Array<[RssReadingTheme, string, string]> = [
  ['auto', 'var(--bg-base)', 'var(--text-primary)'],
  ['light', '#ffffff', '#1c1c1c'],
  ['paper', '#f7f1e3', '#33291d'],
  ['sage', '#eef3ea', '#26332a'],
  ['mist', '#eaeef4', '#262d38'],
  ['dark', '#17181a', '#d6d3cd'],
  ['black', '#000000', '#c9c9c9'],
]

export function RssReader({ onBack, focus, onToggleFocus }: { onBack?: () => void, focus?: boolean, onToggleFocus?: () => void }) {
  const library = useRss(state => state.library)
  const articles = useRss(state => state.articles)
  const channel = useRss(state => state.channel)
  const views = useRss(state => state.views)
  const openEntry = useRss(state => state.openEntry)
  const markRead = useRss(state => state.markRead)
  const toggleFavorite = useRss(state => state.toggleFavorite)
  const toggleLater = useRss(state => state.toggleLater)
  const setReaderTop = useRss(state => state.setReaderTop)
  const setVersion = useRss(state => state.setVersion)
  const forgetResult = useRss(state => state.forgetResult)
  const results = useRss(state => state.results)
  const settings = useSession(state => state.settings.rss)
  const hideEntries = useRss(state => state.hideEntries)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const barRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const abortRef = useRef<(() => void) | null>(null)
  const [typography, setTypography] = useState(false)
  const [imagesOn, setImagesOn] = useState(false)
  const [ai, setAi] = useState<{ kind: RssAiKind, text: string, running: boolean, error: string } | null>(null)

  const key = channelKey(channel)
  const view = views[key] ?? { entryId: '', filter: 'all' as const, query: '', sort: 'newest' as const, version: 'original' as const, platform: 'all' as const, listTop: 0, readerTop: 0 }
  const entries = useMemo(() => channelEntries({ library, articles }, channel), [library, articles, channel])
  // The channel list is a filter, and an open article can leave it: marking the only unread article
  // read, unstarring the only starred one, hiding it. That article is still the page the reader is
  // looking at, so it is resolved from what this device holds rather than from what still matches —
  // while previous/next keep stepping through the list the reader was actually browsing.
  const entry = useMemo(() => {
    const listed = entries.find(item => item.id === view.entryId)
    if (listed) return listed
    for (const list of Object.values(articles)) {
      const left = list.find(item => item.id === view.entryId)
      if (left) return left
    }
    return null
  }, [entries, articles, view.entryId])
  const feed = entry ? findFeed(library, entry.feedId) : undefined
  const index = entry ? entries.findIndex(item => item.id === entry.id) : -1
  const read = entry ? library.readIds.includes(entry.id) : false
  const starred = entry ? library.favorites.includes(entry.id) : false
  const later = entry ? library.readLater.includes(entry.id) : false
  const version: RssReadingVersion = view.version
  const stored = entry ? results[entry.id] : undefined

      useEffect(() => {
    abortRef.current?.()
    abortRef.current = null
    setAi(null)
    setImagesOn(false)
    const host = scrollRef.current
    if (host) host.scrollTop = 0
  }, [entry?.id])

  const display = useMemo(() => (entry
    ? articleDisplayHtml(entry.content, {
      images: imagesOn ? 'relay' : settings.images,
      relay: api.rss.relayUrl,
    })
    : ''), [entry, settings.images, imagesOn])

  const step = useCallback((delta: number): void => {
    const next = stepIndex(index, delta, entries.length)
    if (next >= 0) openEntry(entries[next].id)
  }, [entries, index, openEntry])

  const ask = async (kind: RssAiKind): Promise<void> => {
    if (!entry) return
    // Read the key when it is asked for, not when the pane mounted: a reader who has just typed it
    // into the settings dialog expects this button to work, and a snapshot taken before they did
    // would tell them to go configure it again.
    const live = await loadAiConfig()
    if (!aiReady(live)) {
      useUi.getState().toast({ title: t('rss.ai.not_configured'), tone: 'danger' })
      return
    }
    abortRef.current?.()
    const asked = entry
    setAi({ kind, text: '', running: true, error: '' })
    const run = runArticleAi(entry, feed, kind, live, settings.aiLanguage, text => {
      setAi(current => (current ? { ...current, text } : current))
    })
    abortRef.current = run.abort
    run.promise
      .then(text => {
        // Kept against the article that was asked about, not whichever one is on screen now: a
        // reader who moves on mid-stream should still find the answer where they left it.
        useRss.getState().rememberResult(asked.id, kind, text)
        setAi(current => (current ? { ...current, text, running: false } : current))
      })
      .catch((error: unknown) => setAi({
        kind,
        text: '',
        running: false,
        error: error instanceof Error && error.message ? error.message : t('rss.ai.failed'),
      }))
      .finally(() => {
        abortRef.current = null
      })
  }

  if (!entry) {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-[var(--bg-base)] px-6">
        <p className="max-w-xs text-center text-[13px] leading-relaxed text-[var(--text-tertiary)]">
          {entries.length ? t('rss.select_article') : library.feeds.length ? t('rss.no_articles') : t('rss.no_subscriptions')}
        </p>
      </div>
    )
  }

  const save = async (): Promise<void> => {
    const result = await saveArticleAsNote(entry, feed)
    useUi.getState().toast(result.ok
      ? { title: t('rss.saved_note', { title: result.title ?? '' }), tone: 'success' }
      : { title: result.error ?? t('rss.save_failed'), tone: 'danger' })
  }

  // Saving an article twice rewrites the note the first save made, so the reader needs the way back
  // to it as much as the way to it: one remembered id, one button that only exists once there is a
  // note to open.
  const noteId = savedNoteId(library, entry.id)

  const append = async (): Promise<void> => {
    const outcome = await appendToDailyNote(entry, feed)
    useUi.getState().toast(outcome === 'added'
      ? { title: t('rss.appended_daily', { title: dailyNoteTitle(settings.dailyNoteTitle) }), tone: 'success' }
      : outcome === 'already'
        ? { title: t('rss.already_added') }
        : { title: t('rss.daily_note_missing'), tone: 'danger' })
  }

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(entry.link)
      useUi.getState().toast({ title: t('rss.copied'), tone: 'success' })
    }
    catch {
      // A browser that will not hand over the clipboard has already said so in its own words.
    }
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--bg-base)]">
      <header className="flex min-h-11 shrink-0 flex-wrap items-center gap-1 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1">
        {onBack && (
          <IconButton label={t('rss.back')} size="sm" onClick={onBack} className="lg:hidden">
            <ArrowLeft size={15} />
          </IconButton>
        )}
        {/* Nine one-article actions do not fit beside a title on a phone, and a control that is off
            screen is a control that does not exist. So the row wraps instead of scrolling. */}
        <div className="min-w-0 flex-1 basis-40">
          <div className="truncate text-[12.5px] font-medium text-[var(--text-primary)]">{feed?.title || t('rss.source_unknown')}</div>
          <div className="truncate text-[10.5px] text-[var(--text-quaternary)]">
            {entry.publishedTs ? fullTime(entry.publishedTs) : ''}
            {entry.author ? ` · ${entry.author}` : ''}
            {readingMinutes(entry) > 0 ? ` · ${t('rss.read_minutes', { n: readingMinutes(entry) })}` : ''}
            {wordCount(entry) > 0 ? ` · ${t('rss.words', { n: wordCount(entry).toLocaleString() })}` : ''}
          </div>
        </div>
        <IconButton label={starred ? t('rss.unstar') : t('rss.star')} size="sm" active={starred} onClick={() => toggleFavorite(entry.id)}>
          <Star size={15} fill={starred ? 'currentColor' : 'none'} />
        </IconButton>
        <IconButton label={read ? t('rss.mark_unread') : t('rss.mark_read')} size="sm" active={read} onClick={() => markRead([entry.id], !read)}>
          {read ? <Check size={15} /> : <Undo2 size={15} />}
        </IconButton>
        <IconButton label={later ? t('rss.not_later') : t('rss.read_later')} size="sm" active={later} onClick={() => toggleLater(entry.id)}>
          <Bookmark size={15} fill={later ? 'currentColor' : 'none'} />
        </IconButton>
        <IconButton label={t('rss.save_note')} size="sm" onClick={() => void save()}>
          <FileType2 size={15} />
        </IconButton>
        {noteId && (
          <IconButton label={t('rss.open_saved_note')} size="sm" onClick={() => openSavedNote(noteId)}>
            <BookOpen size={15} />
          </IconButton>
        )}
        {settings.dailyNoteTitle.trim() && (
          <IconButton label={t('rss.append_daily')} size="sm" onClick={() => void append()}>
            <NotebookPen size={15} />
          </IconButton>
        )}
        <IconButton
          label={t('rss.hide_article')}
          size="sm"
          onClick={() => {
            hideEntries([entry.id], true)
            useUi.getState().toast({
              title: t('rss.hidden_toast', { n: 1 }),
              action: { label: t('rss.undo'), run: () => hideEntries([entry.id], false) },
            })
            onBack?.()
          }}
        >
          <EyeOff size={15} />
        </IconButton>
        {onToggleFocus && (
          <IconButton label={t('rss.focus_mode')} size="sm" active={focus} onClick={onToggleFocus}>
            <Focus size={15} />
          </IconButton>
        )}
        <IconButton label={t('rss.typography')} size="sm" onClick={() => setTypography(true)}>
          <Type size={15} />
        </IconButton>
        <IconButton label={t('rss.next_article')} size="sm" disabled={index < 0 || index >= entries.length - 1} onClick={() => step(1)}>
          <ArrowLeft size={15} className="rotate-180" />
        </IconButton>
      </header>

      {settings.aiEnabled && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1">
          <Segmented
            size="sm"
            label={t('rss.versions')}
            value={version}
            onChange={value => setVersion(value as RssReadingVersion)}
            options={[
              { value: 'original', label: t('rss.version_original') },
              { value: 'summary', label: t('rss.ai.summary') },
              { value: 'translation', label: t('rss.ai.translation') },
            ]}
          />
        </div>
      )}

      <div
        ref={barRef}
        aria-hidden="true"
        className="h-0.5 shrink-0 bg-[var(--accent)]"
        style={{ width: '0%', transformOrigin: 'left' }}
      />
      <div
        ref={scrollRef}
        className="rss-scroll min-h-0 flex-1 overflow-y-auto"
        data-theme={settings.readingTheme}
        data-focus={focus ? 'true' : undefined}
        onScroll={(event) => {
          const node = event.currentTarget
          setReaderTop(node.scrollTop)
          const span = node.scrollHeight - node.clientHeight
          const bar = barRef.current
          if (bar) bar.style.width = `${span > 0 ? Math.min(100, (node.scrollTop / span) * 100) : 0}%`
        }}
      >
        <article
          className="ink-prose rss-prose px-4 pt-6 pb-10 md:px-8"
          data-font={settings.readingFont}
          style={{
            // The reader picked a size, and it is honoured wherever it fits: on a 360px screen
            // 32px leaves nine characters a line, so the size is clamped to the viewport first.
            '--prose-size': `min(${settings.fontSize}px, max(17px, 4.6vw + 6px))`,
            '--prose-line': String(settings.lineHeight),
            '--prose-width': `${settings.columnWidth}em`,
            '--rss-custom-font': settings.readingFont === 'custom' ? settings.customFont || 'serif' : undefined,
          } as CSSProperties}
        >
          <h1 className="mb-1 text-[1.45em] leading-[1.35] font-semibold text-[var(--text-primary)]">
            {entry.link
              ? <a href={entry.link} target="_blank" rel="noopener noreferrer nofollow">{entry.title || t('rss.untitled')}</a>
              : (entry.title || t('rss.untitled'))}
          </h1>
          <p className="mb-6 text-[0.72em] text-[var(--text-quaternary)]">
            {entry.publishedTs ? shortSince(entry.publishedTs) : ''}
            {feed?.siteUrl ? ` · ${hostOf(feed.siteUrl)}` : ''}
          </p>
          {/* A WeChat article reaches this app through somebody else's bridge, so the reader is
              told whose writing it is and where the real page lives. The reference does the same,
              and it is the least an aggregator can do for the author. */}
          {remoteContentKey(entry.link).startsWith('wx:') && (
            <p className="-mt-4 mb-6 text-[0.7em] leading-[1.6] text-[var(--text-quaternary)]">
              {t('rss.wechat_notice')}
              {' '}
              <a href={entry.link} target="_blank" rel="noopener noreferrer nofollow" className="text-[var(--accent)] hover:underline">
                {t('rss.wechat_original')}
              </a>
            </p>
          )}
          {playableAudio(entry.audioUrl) && (
            <figure className="mb-5">
              <audio controls preload="none" src={api.rss.relayUrl(playableAudio(entry.audioUrl))} className="w-full">
                {t('rss.audio_failed')}
              </audio>
              <figcaption className="mt-1 flex items-center gap-1 text-[0.7em] text-[var(--text-quaternary)]">
                <AudioLines size={12} aria-hidden="true" />
                {t('rss.audio')}
              </figcaption>
            </figure>
          )}
          {!playableAudio(entry.audioUrl) && videoLinkOf(entry.link) && (
            <p className="mb-5">
              <a
                href={videoLinkOf(entry.link)!.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="inline-flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-default)] px-3 py-2 text-[0.78em] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              >
                <PlayCircle size={15} aria-hidden="true" />
                {t('rss.watch_video', { host: videoLinkOf(entry.link)!.host })}
              </a>
            </p>
          )}
          {version === 'original' && (
            <>
              {display
                ? <div ref={bodyRef} dangerouslySetInnerHTML={{ __html: display }} />
                : <p className="text-[0.9em] text-[var(--text-tertiary)]">{entry.summary || t('rss.article_no_content')}</p>}
              {settings.images === 'off' && entry.imageUrl && (
                <button
                  type="button"
                  onClick={() => setImagesOn(true)}
                  className="mt-4 rounded-[var(--r-md)] border border-[var(--border-default)] px-2.5 py-1 text-[0.72em] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                >
                  {t('rss.show_images')}
                </button>
              )}
              {entry.content.length >= 99_000 && (
                <p className="mt-6 text-[0.72em] text-[var(--text-quaternary)]">{t('rss.article_truncated')}</p>
              )}
            </>
          )}
          {/* The other two versions are answers *about* this article, so they take its place rather
              than trailing below it: a reader on the summary tab is deciding whether to read the
              thing, and scrolling past the whole article to get there defeats the question. */}
          {version !== 'original' && (
            <VersionBody
              kind={version}
              answer={stored?.[version] ?? ''}
              generatedAt={stored?.at ?? 0}
              run={ai && ai.kind === version ? ai : null}
              onAsk={() => void ask(version)}
              onStop={() => abortRef.current?.()}
              onForget={() => forgetResult(entry.id, version)}
            />
          )}
        </article>

      </div>

      <footer className="flex shrink-0 flex-wrap items-center gap-1 border-t border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1.5">
        <IconButton label={t('rss.previous_article')} size="sm" disabled={index <= 0} onClick={() => step(-1)}>
          <ArrowLeft size={15} />
        </IconButton>
        <a
          href={entry.link || undefined}
          target="_blank"
          rel="noopener noreferrer nofollow"
          aria-disabled={!entry.link}
          className={cn(
            'inline-flex h-9 items-center gap-1.5 rounded-[var(--r-md)] px-2 text-[12px] font-medium',
            'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
            !entry.link && 'pointer-events-none opacity-45',
          )}
        >
          <ExternalLink size={13} aria-hidden="true" />
          {t('rss.open_original')}
        </a>
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex h-9 items-center gap-1.5 rounded-[var(--r-md)] px-2 text-[12px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        >
          <Link2 size={13} aria-hidden="true" />
          {t('rss.copy_link')}
        </button>
        {!entry.content && (
          <ToolButton label={t('rss.reload_article')} icon={<RefreshCw size={13} aria-hidden="true" />} onClick={() => reloadEntry(entry)} />
        )}
        <div className="flex flex-wrap items-center gap-1">
          {settings.aiEnabled && version === 'original' && (
            <>
              <ToolButton label={t('rss.ai.summarise')} icon={<Sparkles size={13} aria-hidden="true" />} onClick={() => { setVersion('summary'); void ask('summary') }} />
              <ToolButton label={t('rss.ai.translate')} icon={<FileType2 size={13} aria-hidden="true" />} onClick={() => { setVersion('translation'); void ask('translation') }} />
            </>
          )}
        </div>
      </footer>

      <Drawer open={typography} onClose={() => setTypography(false)} title={t('rss.typography')} width={300}>
        <TypographyPanel />
      </Drawer>
      <ExcerptPopup rootRef={bodyRef} />
    </div>
  )
}

function ToolButton({ label, icon, onClick }: { label: string, icon: ReactNode, onClick: () => void }): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-9 items-center gap-1.5 rounded-[var(--r-md)] px-2 text-[12px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
    >
      {icon}
      {label}
    </button>
  )
}

function TypographyPanel(): ReactElement {
  const rss = useSession(state => state.settings.rss)
  const update = useSession(state => state.updateSettings)
  const patch = (next: Partial<typeof rss>): void => update({ rss: next })
  return (
    <div className="space-y-5 p-4">
      <Field label={t('rss.theme')}>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('rss.theme')}>
          {THEME_SWATCHES.map(([id, paper, ink]) => (
            <button
              key={id}
              type="button"
              aria-label={t(`rss.theme_${id}` as MessageKey)}
              aria-pressed={rss.readingTheme === id}
              onClick={() => patch({ readingTheme: id })}
              className={cn(
                'grid h-9 w-12 place-items-center rounded-[var(--r-md)] border transition-shadow',
                rss.readingTheme === id
                  ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]'
                  : 'border-[var(--border-subtle)] hover:border-[var(--border-default)]',
              )}
              style={{ background: paper }}
            >
              <span aria-hidden="true" className="w-7 space-y-[3px]">
                <span className="block h-[2px] rounded-full" style={{ background: ink }} />
                <span className="block h-[2px] w-4/5 rounded-full" style={{ background: ink, opacity: 0.55 }} />
              </span>
            </button>
          ))}
        </div>
      </Field>
      <Field label={t('rss.font')}>
        <Select
          value={rss.readingFont}
          aria-label={t('rss.font')}
          onChange={event => patch({ readingFont: event.target.value as typeof rss.readingFont })}
        >
          {FONTS.map(id => (
            <option key={id} value={id}>{t(`rss.font_${id}` as MessageKey)}</option>
          ))}
        </Select>
      </Field>
      {rss.readingFont === 'custom' && (
        <Field label={t('rss.custom_font')} hint={t('rss.custom_font_desc')}>
          <Input
            value={rss.customFont}
            placeholder={t('rss.custom_font_placeholder')}
            aria-label={t('rss.custom_font')}
            onChange={event => patch({ customFont: event.target.value.slice(0, 80) })}
          />
        </Field>
      )}
      <Field label={`${t('rss.font_size')} · ${rss.fontSize}px`}>
        <Slider
          value={rss.fontSize}
          min={RSS_FONT_SIZE_RANGE[0]}
          max={RSS_FONT_SIZE_RANGE[1]}
          onChange={fontSize => patch({ fontSize })}
          label={t('rss.font_size')}
        />
      </Field>
      <Field label={`${t('rss.line_height')} · ${rss.lineHeight.toFixed(2)}`}>
        <Slider
          value={rss.lineHeight}
          min={RSS_LINE_HEIGHT_RANGE[0]}
          max={RSS_LINE_HEIGHT_RANGE[1]}
          step={0.05}
          onChange={lineHeight => patch({ lineHeight })}
          label={t('rss.line_height')}
        />
      </Field>
      <Field label={t('rss.measure')}>
        <Segmented
          value={String(rss.columnWidth)}
          onChange={value => patch({ columnWidth: Number(value) as typeof rss.columnWidth })}
          options={RSS_COLUMN_WIDTHS.map(width => ({ value: String(width), label: t('rss.measure_n', { n: width }) }))}
        />
      </Field>
      <p className="text-[11.5px] leading-relaxed text-[var(--text-quaternary)]">{t('rss.keys.help')}</p>
    </div>
  )
}

/** One of the two versions that are not the author's own text. */
function VersionBody({ kind, answer, generatedAt, run, onAsk, onStop, onForget }: {
  kind: RssAiKind
  answer: string
  generatedAt: number
  run: { text: string, running: boolean, error: string } | null
  onAsk: () => void
  onStop: () => void
  onForget: () => void
}): ReactElement {
  const streaming = run?.running ?? false
  const text = run && (streaming || run.error) ? run.text : answer
  return (
    <section data-rss-version={kind} className="text-[0.95em]">
      <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] pb-2">
        <Sparkles size={13} className="text-[var(--accent)]" aria-hidden="true" />
        {/* A span, not a heading: the prose sheet sizes every h2 in the article, and this label is
            chrome beside the answer rather than one of the article's own headings. */}
        <span className="text-[12.5px] font-semibold text-[var(--text-primary)]">
          {kind === 'summary' ? t('rss.ai.summary') : t('rss.ai.translation')}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {generatedAt && !streaming && (
            <span className="text-[0.7em] text-[var(--text-quaternary)]">{t('rss.version_generated', { time: shortSince(generatedAt) })}</span>
          )}
          {streaming && (
            <button type="button" onClick={onStop} className="rounded-[var(--r-sm)] px-2 py-0.5 text-[0.72em] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
              {t('rss.ai.stop')}
            </button>
          )}
          {!streaming && text && (
            <button type="button" onClick={onForget} className="rounded-[var(--r-sm)] px-2 py-0.5 text-[0.72em] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
              {t('rss.ai.clear')}
            </button>
          )}
        </div>
      </div>
      {run?.error && <p className="mb-3 text-[0.82em] text-[var(--danger)]">{run.error}</p>}
      {text
        ? <p className="leading-[1.75] whitespace-pre-wrap text-[var(--text-primary)]">{text}</p>
        : streaming
          ? <p className="text-[0.85em] text-[var(--text-tertiary)]">{t('rss.ai.thinking')}</p>
          : (
              <div className="rounded-[var(--r-lg)] border border-dashed border-[var(--border-default)] px-4 py-6 text-center">
                <p className="text-[0.85em] text-[var(--text-tertiary)]">{t('rss.version_not_yet')}</p>
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Sparkles size={13} aria-hidden="true" />}
                  className="mt-3"
                  onClick={onAsk}
                >
                  {kind === 'summary' ? t('rss.ai.summarise') : t('rss.ai.translate')}
                </Button>
              </div>
            )}
      {streaming && text && (
        <p className="mt-3 text-[0.7em] text-[var(--text-quaternary)]">{t('rss.ai.thinking')}</p>
      )}
    </section>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  }
  catch {
    return url
  }
}
