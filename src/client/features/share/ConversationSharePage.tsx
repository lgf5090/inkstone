/**
 * A published conversation, read by somebody with no account.
 *
 * The same promise a shared note makes, for a different thing: the reader sees the turns as they were —
 * who spoke, what was said, and which model answered — and nothing else. There is no composer, no
 * sidebar and no vault behind it: a visitor has no notes to open, so `[[links]]` stay inert, a `![[note]]`
 * is answered by the share page's own markup rule rather than by a read nobody is allowed to make, and
 * the assistant's sources are plain links out.
 *
 * The passcode gate is the note page's, deliberately: a reader who has opened one shared link before
 * should recognise this screen, and the server-side throttle is the same one.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { KeyRound, Lock, Moon, Sun } from 'lucide-react'
import { LIMITS } from '@shared/constants'
import type { PublicConversation } from '@shared/assistant'
import { api, ApiError } from '../../lib/api'
import { fullTime } from '../../lib/time'
import { Avatar, Button, Logo } from '../../components/primitives'
import { Input } from '../../components/form'
import { LoadingBlock } from '../../components/feedback'
import { Tooltip } from '../../components/overlay'
import { MarkdownBody } from '../preview/MarkdownBody'
import { neutralizeShareEmbeds } from './share-markdown'
import { t } from '../../lib/i18n'

export function ConversationSharePage({ slug }: { slug: string }) {
  const [conversation, setConversation] = useState<PublicConversation | null>(null)
  const [needPassword, setNeedPassword] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark')
  const request = useRef<AbortController | null>(null)
  const originalTitle = useRef(document.title)

  const load = useCallback(async (passcode?: string) => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    setError(null)
    try {
      const result = await api.share.readConversation(slug, passcode, controller.signal)
      if (controller.signal.aborted) return
      setConversation(result)
      setNeedPassword(false)
      setPassword('')
      document.title = `${result.title || t('assistant.chat.untitled')} · ${result.site.name}`
    } catch (caught) {
      if (controller.signal.aborted || (caught as Error)?.name === 'AbortError') return
      if (caught instanceof ApiError && caught.status === 401) {
        setConversation(null)
        setNeedPassword(true)
        if (passcode) setError(t('share.incorrect_passcode'))
      } else {
        setNeedPassword(false)
        setError(caught instanceof ApiError ? caught.message : t('share.content_unavailable'))
      }
    } finally {
      if (request.current === controller) {
        request.current = null
        setLoading(false)
      }
    }
  }, [slug])

  useEffect(() => {
    void load()
    return () => {
      request.current?.abort()
      request.current = null
      document.title = originalTitle.current
    }
  }, [load])

  const toggleTheme = () => {
    const next = !dark
    setDark(next)
    document.documentElement.dataset.theme = next ? 'dark' : 'light'
  }

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-[var(--bg-base)]">
      <header className="sticky top-0 z-10 border-b border-[var(--border-subtle)] bg-[var(--bg-base)] pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex h-12 max-w-[760px] items-center gap-3 px-4 md:px-5">
          <span className="flex items-center gap-1.5 text-[var(--accent)]">
            <Logo size={15} />
          </span>
          <span className="text-[length:var(--text-12-5)] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
            {conversation?.site.name ?? 'Inkstone'}
          </span>
          <span className="flex-1" />
          <Tooltip label={t('share.switch_theme')} side="left">
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={t('share.switch_theme')}
              className="inline-flex size-9 items-center justify-center rounded-[var(--r-md)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] md:size-7"
            >
              {dark ? <Sun size={14} /> : <Moon size={14} />}
            </button>
          </Tooltip>
        </div>
      </header>

      <main className="mx-auto max-w-[760px] px-4 pb-[calc(64px+env(safe-area-inset-bottom))] md:px-5 md:pb-24">
        {loading && !needPassword ? (
          <div className="pt-24"><LoadingBlock label={t('share.opening')} /></div>
        ) : needPassword ? (
          <div className="anim-rise mx-auto max-w-[340px] pt-[16vh] text-center">
            <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-[16px] border border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--text-tertiary)]">
              <Lock size={20} />
            </div>
            <h1 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">
              {t('assistant.share.requires_passcode')}
            </h1>
            <p className="mt-1.5 text-[length:var(--text-12-5)] text-[var(--text-tertiary)]">
              {t('assistant.share.ask_for_passcode')}
            </p>
            <form
              className="mt-5 space-y-2.5"
              onSubmit={(event) => {
                event.preventDefault()
                void load(password)
              }}
            >
              <Input
                aria-label={t('common.access_passcode')}
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={t('common.access_passcode')}
                autoComplete="current-password"
                maxLength={LIMITS.passwordMaxLength}
                autoFocus
                leading={<KeyRound size={13} />}
                invalid={Boolean(error)}
              />
              {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
              <Button type="submit" variant="primary" block loading={loading}>{t('share.view_content')}</Button>
            </form>
          </div>
        ) : error ? (
          <div className="mx-auto max-w-[380px] pt-[18vh] text-center">
            <h1 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">{t('share.content_unavailable')}</h1>
            <p role="alert" className="mt-2 text-[length:var(--text-13)] leading-relaxed text-[var(--text-tertiary)]">{error}</p>
          </div>
        ) : conversation ? (
          <article className="pt-7 md:pt-10">
            <header className="mb-6 md:mb-8">
              <h1 className="text-[length:var(--text-26)] leading-[1.25] font-bold tracking-[-0.03em] text-[var(--text-primary)] md:text-[length:var(--text-30)]">
                {conversation.title || t('assistant.chat.untitled')}
              </h1>
              <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[length:var(--text-12)] text-[var(--text-quaternary)]">
                <span className="flex items-center gap-1.5">
                  <Avatar src={conversation.author.avatarUrl} name={conversation.author.name} size={18} />
                  {conversation.author.name}
                </span>
                <span>·</span>
                <span>{fullTime(conversation.updatedAt)}</span>
                <span>·</span>
                <span>{t('assistant.share.turns', { count: conversation.messages.length })}</span>
              </div>
            </header>

            <ol className="flex flex-col gap-5">
              {conversation.messages.map((message) => (
                <li
                  key={`${message.createdAt}-${message.role}`}
                  className={message.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
                >
                  {message.role === 'user' ? (
                    <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-[var(--r-lg)] rounded-br-[var(--r-xs)] bg-[var(--accent-soft)] px-3 py-2 text-[length:var(--text-13-5)] leading-relaxed text-[var(--text-primary)]">
                      {message.content}
                    </div>
                  ) : (
                    <div className="min-w-0 flex-1">
                      {/* The same markup rules the shared note page runs, for the same reason: an answer can
                          name a note, and a reader with no account and no vault is owed one honest sentence
                          about it rather than a box that waits forever. */}
                      {message.content && <MarkdownBody source={message.content} className="ink-chat-prose" transformHtml={neutralizeShareEmbeds} />}
                      {message.sources && message.sources.length > 0 && (
                        <ul aria-label={t('assistant.chat.sources')} className="mt-0.5 flex flex-wrap gap-1">
                          {message.sources.map((source, index) => (
                            <li key={source.url}>
                              <a
                                href={source.url}
                                target="_blank"
                                rel="noreferrer noopener"
                                className="inline-flex max-w-[280px] items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                              >
                                <span className="shrink-0 tabular text-[var(--text-quaternary)]">{index + 1}</span>
                                <span className="min-w-0 truncate">{source.title}</span>
                              </a>
                            </li>
                          ))}
                        </ul>
                      )}
                      {message.modelLabel && (
                        <p className="mt-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{message.modelLabel}</p>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ol>

            <footer className="mt-16 border-t border-[var(--border-subtle)] pt-6 text-center">
              <a href="/" className="inline-flex items-center gap-1.5 text-[length:var(--text-11-5)] text-[var(--text-quaternary)] transition-colors hover:text-[var(--accent)]">
                <Logo size={12} />{t('assistant.share.read_only', { site: conversation.site.name })}
              </a>
            </footer>
          </article>
        ) : null}
      </main>
    </div>
  )
}
