/**
 * The RSS container: the app that answers at `/rss`.
 *
 * It owns the frame the placeholder used to draw — same header height, same tokens — and the
 * responsive decision the other containers make too: three panes when there is room for three, one
 * pane and a back button when there is not. The rail is the only pane that can be hidden on a wide
 * screen, because it is the only one whose contents are reachable another way (the channel name in
 * the header opens the same list).
 *
 * Loading is deliberately on mount rather than at boot. A reader who never opens this tab should not
 * pay for a library they will not read, and the Worker should not answer for it either.
 */
import { useEffect, useState, type ReactElement } from 'react'
import { CircleHelp, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, Rss, Search, Settings } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { IS_DEMO_MODE } from '../../lib/runtime'
import { useSession } from '../../store/session'
import { useNotes } from '../../store/notes'
import { Button, IconButton } from '../../components/primitives'
import { Modal, Tooltip } from '../../components/overlay'
import { channelKey } from '@shared/rss/reading'
import { takeRssSection } from './rss-commands'
import { useRss } from './store'
import { RssChannelRail } from './RssChannelRail'
import { RssArticleList } from './RssArticleList'
import { RssReader } from './RssReader'
import { SubscriptionCenter } from './SubscriptionCenter'
import { RssSearchPanel } from './RssSearchPanel'
import { RssKeys } from './RssKeys'
import { RssSettings } from '../settings/RssSettings'

type Pane = 'rail' | 'list' | 'reader'

export function RssApp(): ReactElement {
  const status = useRss(state => state.status)
  const saveError = useRss(state => state.saveError)
  const library = useRss(state => state.library)
  const channel = useRss(state => state.channel)
  const refreshing = useRss(state => state.refreshing)
  const progress = useRss(state => state.progress)
  const refresh = useRss(state => state.refresh)
  const retrySave = useRss(state => state.retrySave)
  const userId = useSession(state => state.user?.id)
  const [pane, setPane] = useState<Pane>('list')
  const [railHidden, setRailHidden] = useState(false)
  const [center, setCenter] = useState<'manage' | 'add' | 'discover' | null>(null)
  const [preferences, setPreferences] = useState(false)
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches)

  useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)')
    const onChange = (): void => setWide(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  // Below the three-pane breakpoint the rail is a pane of its own — a full screen on a phone, a
  // floating drawer on a tablet — so the same gesture has to drive `pane`. Above it the rail is in
  // flow and only `railHidden` means anything. One handler, because the reader presses the same
  // button either way and a control that does nothing on a phone is a control that is broken.
  const railOpen = wide ? !railHidden : pane === 'rail'
  const toggleRail = (): void => {
    if (wide) {
      setRailHidden(hidden => !hidden)
      return
    }
    setPane(current => (current === 'rail' ? 'list' : 'rail'))
  }
  const [focus, setFocus] = useState(false)
  const [search, setSearch] = useState(false)
  const [keys, setKeys] = useState(false)

  useEffect(() => {
    void useRss.getState().load()
  }, [userId])

  // A screen asked for from the palette or an automation step. The ask arrives before this
  // container exists — it is a lazy chunk the notebook navigates to — so it is taken here rather
  // than passed down, and taking it is what keeps the back button from reopening the dialog.
  useEffect(() => {
    const section = takeRssSection()
    if (section === 'manage' || section === 'add' || section === 'discover') setCenter(section)
    else if (section === 'health') setPreferences(true)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return
      if (event.key === '[') {
        event.preventDefault()
        toggleRail()
        return
      }
      if (event.key === 'f') {
        event.preventDefault()
        setFocus(on => !on)
        return
      }
      if (event.key === '/') {
        event.preventDefault()
        setSearch(true)
        return
      }
      if (event.key === '?') {
        event.preventDefault()
        setKeys(true)
        return
      }
      // A dialog claims Escape for itself and stops the event before it gets here, so this is
      // only ever the reading surface answering: leave focus mode.
      if (event.key === 'Escape' && focus) {
        event.preventDefault()
        setFocus(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [focus])

  const title = channelTitle(library, channel)

  return (
    <section className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]">
      <header data-print="hide" className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3">
        <IconButton
          label={railOpen ? t('rss.collapse') : t('rss.expand')}
          size="sm"
          onClick={toggleRail}
        >
          {railOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
        </IconButton>
        <Rss size={15} className="shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
        <h1 className="min-w-0 truncate text-[13.5px] font-semibold text-[var(--text-primary)]">{title}</h1>
        {progress && (
          <span className="shrink-0 text-[11px] text-[var(--text-quaternary)]">
            {t('rss.refreshing', { done: progress.done, total: progress.total })}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {saveError && (
            <button
              type="button"
              onClick={retrySave}
              className="h-7 rounded-[var(--r-md)] px-2 text-[11.5px] text-[var(--danger)] hover:bg-[var(--bg-hover)]"
            >
              {t('rss.error.save_pending')}
            </button>
          )}
          <Tooltip label={t('rss.search_all')} side="bottom">
            <IconButton label={t('rss.search_all')} size="sm" onClick={() => setSearch(true)}>
              <Search size={15} />
            </IconButton>
          </Tooltip>
          <Tooltip label={t('rss.keys_title')} side="bottom">
            <IconButton label={t('rss.keys_title')} size="sm" onClick={() => setKeys(true)}>
              <CircleHelp size={15} />
            </IconButton>
          </Tooltip>
          <Tooltip label={t('rss.refresh_all')} side="bottom">
            <IconButton
              label={t('rss.refresh_all')}
              size="sm"
              disabled={refreshing.length > 0}
              aria-busy={refreshing.length > 0}
              onClick={() => void refresh(undefined, { force: true })}
            >
              <RefreshCw size={15} className={refreshing.length > 0 ? 'animate-spin' : undefined} />
            </IconButton>
          </Tooltip>
          <Tooltip label={t('settings.rss')} side="bottom">
            <IconButton label={t('settings.rss')} size="sm" onClick={() => setPreferences(true)}>
              <Settings size={15} />
            </IconButton>
          </Tooltip>
          <Tooltip label={t('rss.add_subscription')} side="bottom">
            <IconButton label={t('rss.add_subscription')} size="sm" onClick={() => setCenter('add')}>
              <Plus size={16} />
            </IconButton>
          </Tooltip>
        </div>
      </header>

      {IS_DEMO_MODE
        ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6">
              <div className="max-w-sm text-center">
                <p className="text-[13px] font-medium text-[var(--text-primary)]">{t('app.tabs.rss')}</p>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--text-tertiary)]">{t('rss.demo_notice')}</p>
              </div>
            </div>
          )
        : (
            <div className="relative flex min-h-0 flex-1">
              {!railHidden && !focus && (
                <div data-print="hide" className={cn(
                  'min-h-0',
                  pane === 'rail'
                    // A phone gets the rail as its one pane; a tablet gets it laid over the list it
                    // is already showing, because 768px is wide enough for two and not for three.
                    ? 'z-40 block w-full md:absolute md:inset-y-0 md:left-0 md:w-60 md:shadow-[var(--shadow-pop)] lg:static lg:w-auto lg:shadow-none'
                    : 'hidden lg:block',
                )}>
                  <RssChannelRail onPick={() => setPane('list')} />
                </div>
              )}
              {!focus && (
                <div data-print="hide" className={cn('min-h-0 flex-1 md:flex-none lg:flex-none', pane === 'list' ? 'block' : 'hidden md:block')}>
                  <RssArticleList
                    onOpen={() => setPane('reader')}
                    onManage={() => setCenter('manage')}
                  />
                </div>
              )}
              <div className={cn('min-w-0 flex-1', pane === 'reader' ? 'flex' : 'hidden md:flex')}>
                <RssReader
                  onBack={() => setPane('list')}
                  focus={focus}
                  onToggleFocus={() => setFocus(on => !on)}
                />
              </div>
            </div>
          )}

      {preferences && (
        <Modal open onClose={() => setPreferences(false)} title={t('settings.rss')} width={720} bodyClassName="px-4">
          <RssSettings />
        </Modal>
      )}
      {center && (
        <SubscriptionCenter
          adding={center === 'add'}
          tab={center === 'discover' ? 'discover' : 'manage'}
          onClose={() => setCenter(null)}
        />
      )}
      <RssSearchPanel
        open={search}
        onClose={() => setSearch(false)}
        onPick={entry => {
          const state = useRss.getState()
          void state.open({ kind: 'feed', feedId: entry.feedId }).then(() => {
            state.openEntry(entry.id)
            setPane('reader')
          })
        }}
      />
      <RssKeys open={keys} onClose={() => setKeys(false)} />
      {status === 'error' && (
        <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--danger)]">{saveError ?? t('rss.error.load_failed')}</span>
          <Button size="sm" onClick={() => void useRss.getState().load()}>{t('rss.retry')}</Button>
        </div>
      )}
    </section>
  )
}

function channelTitle(library: ReturnType<typeof useRss.getState>['library'], channel: ReturnType<typeof useRss.getState>['channel']): string {
  const key = channelKey(channel)
  if (key === 'all') return t('rss.channel_all')
  if (key === 'starred') return t('rss.channel_starred')
  if (key === 'later') return t('rss.channel_later')
  if (channel.kind === 'feed') return library.feeds.find(feed => feed.id === channel.feedId)?.title ?? t('rss.subscriptions')
  if (channel.kind === 'group') return library.groups.find(group => group.id === channel.groupId)?.name ?? t('rss.subscriptions')
  if (channel.kind === 'tag') return channel.tag
  if (channel.kind === 'vault') {
    const folder = useNotes.getState().folders.find(item => item.id === channel.folderId)
    return folder?.name ?? t('rss.vault_channels')
  }
  if (channel.kind === 'unread') return t('rss.channel_unread')
  if (channel.kind === 'recent') return t('rss.channel_recent')
  if (channel.kind === 'starred') return t('rss.channel_starred')
  if (channel.kind === 'later') return t('rss.channel_later')
  return t('app.tabs.rss')
}
