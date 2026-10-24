import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, Lock } from 'lucide-react'
import type { PublicCollection, PublicCollectionNote } from '@shared/share-hub'
import { withChannelParam, collectionChannelToken } from '@shared/share-channel'
import { prepareShareSource } from './share-markdown'
import { ApiError } from '../../lib/api'
import { shareHubApi } from '../../lib/api-share-hub'
import { Input } from '../../components/form'
import { LoadingBlock } from '../../components/feedback'
import { Button } from '../../components/primitives'
import { t } from '../../lib/i18n'

/**
 * A published collection, as its readers see it.
 *
 * The directory is derived from the owner's live links on every request, so this page never holds a
 * roster of its own: what it shows is exactly what the server was willing to answer a moment ago, and
 * a link the owner paused since the last page is simply not here.
 *
 * It reads through the same unauthenticated endpoint a stranger uses, and it is reached from the same
 * address the hub hands out, so the owner's preview cannot show a page the public does not have.
 */
export function CollectionPage({ slug }: { slug: string }) {
  const [page, setPage] = useState<PublicCollection | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'locked' | 'gone'>('loading')
  const [password, setPassword] = useState('')
  const [wrongPasscode, setWrongPasscode] = useState(false)

  const load = useCallback(async (after: string | null, passcode: string) => {
    setState('loading')
    try {
      const result = await shareHubApi.readCollection(slug, passcode || undefined)
      setPage((current) => ({
        title: result.title,
        count: result.count,
        // Paging forward appends; a new gate answer replaces what the reader had.
        notes: after && current ? [...current.notes, ...result.notes] : result.notes,
        nextCursor: result.nextCursor,
        limit: result.limit,
      }))
      setCursor(result.nextCursor)
      setState('ready')
    } catch (error) {
      // A refusal is the passcode's answer, not a broken page: the server gives no directory metadata
      // at all until the gate is passed, and treating that as "gone" would hide the one control that
      // gets the reader in.
      if (error instanceof ApiError && error.status === 401) {
        setState('locked')
        setWrongPasscode(passcode.length > 0)
        return
      }
      setState('gone')
    }
  }, [slug])

  useEffect(() => {
    void load(null, '')
  }, [load])

  if (state === 'gone') {
    return (
      <main className="mx-auto flex min-h-screen max-w-[640px] flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 className="text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]">
          {t('share.collection_page_gone_title')}
        </h1>
        <p className="text-[length:var(--text-13)] text-[var(--text-tertiary)]">
          {t('share.collection_page_gone_desc')}
        </p>
      </main>
    )
  }

  if (state === 'locked') {
    return (
      <main className="mx-auto flex min-h-screen max-w-[420px] flex-col justify-center gap-4 px-6">
        <h1 className="text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]">
          {t('share.collection_page_locked_title')}
        </h1>
        <p className="text-[length:var(--text-13)] text-[var(--text-tertiary)]">
          {t('share.collection_page_locked_desc')}
        </p>
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void load(null, password)
          }}
        >
          <Input
            type="password"
            value={password}
            aria-label={t('share.passcode')}
            autoComplete="current-password"
            invalid={wrongPasscode}
            onChange={(event) => setPassword(event.target.value)}
          />
          {wrongPasscode && (
            <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">
              {t('share.collection_page_wrong_passcode')}
            </p>
          )}
          <Button type="submit" variant="primary" disabled={password.length === 0}>
            {t('share.collection_page_enter')}
          </Button>
        </form>
      </main>
    )
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-[720px] flex-col gap-6 px-5 py-10">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-[length:var(--text-22)] font-semibold text-[var(--text-primary)]">
          {page?.title || t('share.collection_page_untitled')}
        </h1>
        <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {t('share.collection_page_count', { count: page?.count ?? 0, shown: page?.notes.length ?? 0 })}
        </p>
      </header>

      {state === 'loading' && !page?.notes.length && (
        <LoadingBlock label={t('share.collection_page_loading')}/>
      )}

      {!page?.notes.length && state === 'ready' && (
        <p className="text-[length:var(--text-13)] text-[var(--text-tertiary)]">
          {t('share.collection_page_empty')}
        </p>
      )}

      {page && (
        <ul className="flex flex-col gap-2">
          {page.notes.map((note) => (
            <CollectionEntry key={note.slug} note={note} collectionSlug={slug}/>
          ))}
        </ul>
      )}

      {page?.nextCursor && (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            icon={<ChevronRight size={13}/>}
            loading={state === 'loading'}
            onClick={() => {
              void load(cursor, password)
            }}
          >
            {t('share.collection_page_more')}
          </Button>
        </div>
      )}
    </main>
  )
}

/**
 * One link in the directory.
 *
 * The address carries the collection's channel marker, so the owner's dashboard can tell a reader who
 * arrived from a directory apart from one who was handed the link directly — which is the whole reason
 * the marker is minted rather than free text.
 *
 * Title and excerpt go through `prepareShareSource` even though neither is ever rendered as markdown:
 * a directory is a public page, and an author who typed `[[<note id>|label]]` into a title would
 * otherwise hand a stranger a private note's address through the one surface that has no reason to.
 */
function CollectionEntry({ note, collectionSlug }: { note: PublicCollectionNote; collectionSlug: string }) {
  const url = withChannelParam(`/s/${note.slug}`, collectionChannelToken(collectionSlug))
  return (
    <li>
      <a
        href={url}
        className="flex flex-col gap-1 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-4 transition-colors hover:bg-[var(--bg-hover)]"
      >
        <span className="flex items-center gap-2 text-[length:var(--text-14)] font-medium text-[var(--text-primary)]">
          {note.hasPassword && <Lock size={12} className="shrink-0 text-[var(--text-tertiary)]"/>}
          {prepareShareSource(note.title) || t('common.untitled_note')}
        </span>
        {note.excerpt && (
          <span className="line-clamp-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {prepareShareSource(note.excerpt)}
          </span>
        )}
      </a>
    </li>
  )
}
