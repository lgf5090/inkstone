import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { StickyNote } from 'lucide-react'
import { MEMOS_MESSAGE_KEYS } from '@shared/memos/keys'
import type { Memo, MemoListResponse } from '@shared/memos/types'
import type { PublicUser } from '@shared/types'
import { Empty, LoadingBlock } from '../../components/feedback'
import { Avatar, Button } from '../../components/primitives'
import { ApiError } from '../../lib/api'
import { t, type MessageKey } from '../../lib/i18n'
import { memosApi } from './api'
import { applyShareToken, MemoPublicArticle, MemoPublicCard } from './components/MemoPublicCard'
import { memoErrorMessage, memoIsAbortError } from './errors'
import type { MemoPublicView } from './public-route'

const SECTION_TITLES: Record<MemoPublicView['kind'], MessageKey> = {
  share: 'memos.public.share_title',
  profile: 'memos.public.profile_title',
  profileMemo: 'memos.public.memo_title',
  explore: 'memos.public.explore_title',
}

type PublicStatus = 'loading' | 'ready' | 'error'

interface PublicResource<T> {
  data: T | null
  status: PublicStatus
  error: string | null
  missing: boolean
  reload: () => void
}

function usePublicResource<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): PublicResource<T> {
  const loaderRef = useRef(loader)
  loaderRef.current = loader
  const [ticket, setTicket] = useState(0)
  const [state, setState] = useState<Omit<PublicResource<T>, 'reload'>>({
    data: null,
    status: 'loading',
    error: null,
    missing: false,
  })

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setState({ data: null, status: 'loading', error: null, missing: false })
    loaderRef.current(controller.signal)
      .then((data) => {
        if (active) setState({ data, status: 'ready', error: null, missing: false })
      })
      .catch((error: unknown) => {
        if (!active || memoIsAbortError(error)) return
        setState({
          data: null,
          status: 'error',
          error: memoErrorMessage(error),
          missing: error instanceof ApiError && error.status === 404,
        })
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [...deps, ticket])

  return { ...state, reload: () => setTicket((value) => value + 1) }
}

function PublicLoading(): ReactElement {
  return <LoadingBlock label={t('memos.common.loading')} />
}

function PublicFailure({ missing, message, onRetry }: {
  missing: boolean
  message: string | null
  onRetry: () => void
}): ReactElement {
  if (missing) {
    return (
      <Empty
        art="search"
        title={t('memos.public.not_found_title')}
        description={t('memos.public.not_found_description')}
      />
    )
  }
  return (
    <Empty
      art="search"
      title={t('memos.public.error_title')}
      description={message ?? t('memos.public.error_description')}
      action={<Button size="sm" onClick={onRetry}>{t('memos.common.retry')}</Button>}
    />
  )
}

function ProfileHeader({ username, creator }: { username: string; creator: PublicUser | null }): ReactElement {
  const heading = creator ? creator.name.trim() || creator.username : t('memos.public.handle', { username })
  return (
    <header className="mb-4 flex items-center gap-2.5 border-b border-[var(--border-subtle)] pb-3">
      <Avatar
        src={creator?.avatarUrl}
        name={creator ? creator.name.trim() || creator.username : username}
        size={36}
      />
      <div className="min-w-0">
        <h2 className="truncate text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">{heading}</h2>
        {creator ? (
          <p className="truncate text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
            {t('memos.public.handle', { username: creator.username })}
          </p>
        ) : null}
      </div>
    </header>
  )
}

type PublicListProps = { kind: 'profile'; username: string } | { kind: 'explore' }

function PublicMemoListPage(props: PublicListProps): ReactElement {
  const username = props.kind === 'profile' ? props.username : null
  const resource = usePublicResource<MemoListResponse>(
    (signal) => props.kind === 'profile'
      ? memosApi.publicMemos.userMemos(props.username, {}, signal)
      : memosApi.publicMemos.explore({}, signal),
    [props.kind, username],
  )
  const [more, setMore] = useState<{ items: Memo[]; cursor: string | null; attempted: boolean }>({
    items: [],
    cursor: null,
    attempted: false,
  })
  const [moreStatus, setMoreStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [moreError, setMoreError] = useState<string | null>(null)
  const moreController = useRef<AbortController | null>(null)

  useEffect(() => () => {
    moreController.current?.abort()
  }, [])

  const items = [...(resource.data?.items ?? []), ...more.items]
  const nextCursor = more.attempted ? more.cursor : resource.data?.nextCursor ?? null
  const creator = props.kind === 'profile' ? items[0]?.creator ?? null : null

  const loadMore = (): void => {
    if (!nextCursor || moreStatus === 'loading') return
    moreController.current?.abort()
    const controller = new AbortController()
    moreController.current = controller
    setMoreStatus('loading')
    setMoreError(null)
    const request = props.kind === 'profile'
      ? memosApi.publicMemos.userMemos(props.username, { cursor: nextCursor }, controller.signal)
      : memosApi.publicMemos.explore({ cursor: nextCursor }, controller.signal)
    request
      .then((page) => {
        if (controller.signal.aborted) return
        setMore((current) => ({
          items: [...current.items, ...page.items],
          cursor: page.nextCursor,
          attempted: true,
        }))
        setMoreStatus('idle')
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || memoIsAbortError(error)) return
        setMoreStatus('error')
        setMoreError(memoErrorMessage(error))
      })
  }

  let body: ReactNode
  if (resource.status === 'loading') {
    body = <PublicLoading />
  } else if (resource.status === 'error') {
    body = <PublicFailure missing={resource.missing} message={resource.error} onRetry={resource.reload} />
  } else if (items.length === 0) {
    body = (
      <Empty
        art="notes"
        title={t('memos.public.empty_title')}
        description={t('memos.public.empty_description')}
      />
    )
  } else {
    body = (
      <>
        <div className="space-y-3">
          {items.map((memo) => {
            const handle = memo.creator?.username ?? username
            return (
              <MemoPublicCard
                key={memo.id}
                memo={memo}
                href={handle ? `/memos/u/${encodeURIComponent(handle)}/m/${encodeURIComponent(memo.id)}` : undefined}
              />
            )
          })}
        </div>
        {nextCursor ? (
          <div className="mt-4 flex flex-col items-center gap-2">
            {moreStatus === 'error' ? (
              <p role="alert" className="text-[length:var(--text-11-5)] text-[var(--danger)]">
                {moreError ?? t('memos.public.error_description')}
              </p>
            ) : null}
            <Button size="sm" variant="secondary" loading={moreStatus === 'loading'} onClick={loadMore}>
              {moreStatus === 'loading' ? t('memos.public.loading_more') : t('memos.public.load_more')}
            </Button>
          </div>
        ) : null}
      </>
    )
  }

  return (
    <>
      {props.kind === 'profile' ? (
        <ProfileHeader username={props.username} creator={creator} />
      ) : (
        <div className="mb-4">
          <h2 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">
            {t('memos.public.explore_title')}
          </h2>
          <p className="mt-1 text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">
            {t('memos.public.explore_description')}
          </p>
        </div>
      )}
      {body}
    </>
  )
}

type PublicMemoProps =
  | { kind: 'share'; token: string }
  | { kind: 'profileMemo'; username: string; id: string }

function PublicMemoPage(props: PublicMemoProps): ReactElement {
  const resource = usePublicResource<Memo>(
    (signal) => props.kind === 'share'
      ? memosApi.publicMemos.share(props.token, signal)
      : memosApi.publicMemos.userMemo(props.username, props.id, signal),
    [props.kind, props.kind === 'share' ? props.token : props.username, props.kind === 'profileMemo' ? props.id : null],
  )

  if (resource.status === 'loading') return <PublicLoading />
  if (resource.status === 'error') {
    return <PublicFailure missing={resource.missing} message={resource.error} onRetry={resource.reload} />
  }
  if (!resource.data) {
    return (
      <Empty
        art="search"
        title={t('memos.public.not_found_title')}
        description={t('memos.public.not_found_description')}
      />
    )
  }
  const memo = props.kind === 'share' ? applyShareToken(resource.data, props.token) : resource.data
  return (
    <MemoPublicArticle
      memo={memo}
      shareToken={props.kind === 'share' ? props.token : undefined}
      backHref={props.kind === 'profileMemo' ? `/memos/u/${encodeURIComponent(props.username)}` : undefined}
      backLabel={props.kind === 'profileMemo' ? t('memos.public.back_to_profile') : undefined}
    />
  )
}

function publicContent(route: MemoPublicView): ReactElement {
  switch (route.kind) {
    case 'share':
      return <PublicMemoPage key={`share:${route.token}`} kind="share" token={route.token} />
    case 'profile':
      return <PublicMemoListPage key={`profile:${route.username}`} kind="profile" username={route.username} />
    case 'profileMemo':
      return (
        <PublicMemoPage
          key={`profile-memo:${route.username}:${route.id}`}
          kind="profileMemo"
          username={route.username}
          id={route.id}
        />
      )
    case 'explore':
      return <PublicMemoListPage key="explore" kind="explore" />
  }
}

export function MemosPublicApp({ route }: { route: MemoPublicView }): ReactElement {
  return (
    <section className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]" data-memos-public={route.kind}>
      <header
        data-print="hide"
        className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3"
      >
        <StickyNote size={15} className="shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
        <h1 className="min-w-0 shrink truncate text-[length:var(--text-13-5)] font-semibold text-[var(--text-primary)]">
          {t(MEMOS_MESSAGE_KEYS.appTab)}
        </h1>
        <span className="hidden min-w-0 truncate text-[length:var(--text-11-5)] text-[var(--text-quaternary)] sm:inline">
          {t(SECTION_TITLES[route.kind])}
        </span>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[var(--memo-reading-width)] px-4 py-4 md:px-5 md:py-5">
          {publicContent(route)}
        </div>
      </main>
    </section>
  )
}
