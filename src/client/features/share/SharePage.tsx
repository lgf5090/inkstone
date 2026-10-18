import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, Lock, Moon, Sun } from 'lucide-react';
import { LIMITS } from '@shared/constants';
import type { PublicNote } from '@shared/types';
import { api, ApiError } from '../../lib/api';
import { fullTime } from '../../lib/time';
import { readingMinutes, countText } from '@shared/markdown-utils';
import { Avatar, Button, Logo } from '../../components/primitives';
import { Input } from '../../components/form';
import { LoadingBlock } from '../../components/feedback';
import { Tooltip } from '../../components/overlay';
import { AudienceView } from '../presentation/audience-view';
import { MarkdownBody } from '../preview/MarkdownBody';
import { prepareShareMarkup } from './share-markdown';
import { t } from "../../lib/i18n";

export function SharePage({ slug }: {
    slug: string;
}) {
    const [note, setNote] = useState<PublicNote | null>(null);
    const [needPassword, setNeedPassword] = useState(false);
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark');
    // `?present=<token>` is the seat the speaker handed out. It is read once rather than followed:
    // this document has no router, and a show that started mid-read is a different show.
    const [presentToken] = useState(() => new URLSearchParams(window.location.search).get('present'));
    const requestRef = useRef<AbortController | null>(null);
    const originalTitleRef = useRef(document.title);
    const appliedTitleRef = useRef<string | null>(null);
    const load = useCallback(async (pwd?: string) => {
        requestRef.current?.abort();
        const controller = new AbortController();
        requestRef.current = controller;
        setLoading(true);
        setError(null);
        try {
            const result = await api.share.read(slug, pwd, controller.signal);
            if (controller.signal.aborted)
                return;
            setNote(result);
            setNeedPassword(false);
            setPassword('');
            const title = `${result.title || t("common.untitled_note")} · ${result.site.name}`;
            document.title = title;
            appliedTitleRef.current = title;
        }
        catch (err) {
            if (controller.signal.aborted || (err as Error)?.name === 'AbortError')
                return;
            if (err instanceof ApiError && err.status === 401) {
                setNote(null);
                setNeedPassword(true);
                if (pwd)
                    setError(t("share.incorrect_passcode"));
            }
            else {
                setNeedPassword(false);
                setError(err instanceof ApiError ? err.message : t("share.content_unavailable"));
            }
        }
        finally {
            if (requestRef.current === controller) {
                requestRef.current = null;
                setLoading(false);
            }
        }
    }, [slug]);
    useEffect(() => {
        setNote(null);
        setNeedPassword(false);
        setPassword('');
        setError(null);
        void load();
        return () => {
            requestRef.current?.abort();
            requestRef.current = null;
            if (appliedTitleRef.current && document.title === appliedTitleRef.current)
                document.title = originalTitleRef.current;
            appliedTitleRef.current = null;
        };
    }, [load]);
    // The access rules are this note's, and they are a property of the markup rather than of the pass
    // that draws it, so they are folded in before the body is handed over.
    const transformHtml = useCallback((html: string) => addShareAccess(html, slug), [slug]);
    const toggleTheme = () => {
        const next = !dark;
        setDark(next);
        document.documentElement.dataset.theme = next ? 'dark' : 'light';
    };
    const stats = note ? countText(note.content) : null;
    return (<div className="h-full overflow-y-auto overscroll-contain bg-[var(--bg-base)]">
      <header className="sticky top-0 z-10 border-b border-[var(--border-subtle)] bg-[var(--bg-base)] pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex h-12 max-w-[860px] items-center gap-3 px-4 md:px-5">
          <span className="flex items-center gap-1.5 text-[var(--accent)]">
            <Logo size={15}/>
          </span>
          <span className="text-[length:var(--text-12-5)] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
            {note?.site.name ?? 'Inkstone'}
          </span>
          <span className="flex-1"/>
          <Tooltip label={t("share.switch_theme")} side="left">
            <button type="button" onClick={toggleTheme} aria-label={t("share.switch_theme")} className="inline-flex size-9 items-center justify-center rounded-[var(--r-md)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] md:size-7">
              {dark ? <Sun size={14}/> : <Moon size={14}/>}
            </button>
          </Tooltip>
        </div>
      </header>

      <main className={presentToken
        ? 'flex h-dvh min-h-0 max-w-none flex-col px-[var(--sp-2)] pb-[calc(var(--sp-2)+env(safe-area-inset-bottom))] md:px-[var(--sp-4)] md:pb-[var(--sp-4)]'
        : "mx-auto max-w-[860px] px-4 pb-[calc(64px+env(safe-area-inset-bottom))] md:px-5 md:pb-24"}>
        {loading && !needPassword ? (<div className="pt-24">
            <LoadingBlock label={t("share.opening")}/>
          </div>) : needPassword ? (<div className="anim-rise mx-auto max-w-[340px] pt-[16vh] text-center">
            <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-[16px] border border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--text-tertiary)]">
              <Lock size={20}/>
            </div>
            <h1 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">{t("share.this_note_requires_a_password")}</h1>
            <p className="mt-1.5 text-[length:var(--text-12-5)] text-[var(--text-tertiary)]">{t("share.ask_the_person_who_shared_this_note_for_its_passcode")}</p>
            <form className="mt-5 space-y-2.5" onSubmit={(event) => {
                event.preventDefault();
                void load(password);
            }}>
              <Input aria-label={t("common.access_passcode")} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t("common.access_passcode")} autoComplete="current-password" maxLength={LIMITS.passwordMaxLength} autoFocus leading={<KeyRound size={13}/>} invalid={Boolean(error)}/>
              {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
              <Button type="submit" variant="primary" block loading={loading}>{t("share.view_content")}</Button>
            </form>
          </div>) : error ? (<div className="mx-auto max-w-[380px] pt-[18vh] text-center">
            <h1 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">{t("share.content_unavailable")}</h1>
            <p role="alert" className="mt-2 text-[length:var(--text-13)] leading-relaxed text-[var(--text-tertiary)]">{error}</p>
          </div>) : presentToken && note ? (<AudienceView slug={slug} token={presentToken} source={note.content}/>) : note ? (<article className="pt-7 md:pt-10">
            <header className="mb-6 md:mb-8">
              <h1 className="text-[length:var(--text-26)] leading-[1.25] font-bold tracking-[-0.03em] text-[var(--text-primary)] md:text-[length:var(--text-30)]">
                {note.title || t("common.untitled_note")}
              </h1>
              <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[length:var(--text-12)] text-[var(--text-quaternary)]">
                <span className="flex items-center gap-1.5">
                  <Avatar src={note.author.avatarUrl} name={note.author.name} size={18}/>
                  {note.author.name}
                </span>
                <span>·</span>
                <span>{fullTime(note.updatedAt)}</span>
                {stats && (<>
                    <span>·</span>
                    <span>{stats.words}{t("common.words")}</span>
                    <span>·</span>
                    <span>{t("common.about")}{readingMinutes(stats.words)}{t("common.min")}</span>
                  </>)}
              </div>
            </header>

            {/* `--prose-width` is the measure the prose stylesheet reads: a shared note is the whole
                page rather than a document in a column, so this page hands it no ceiling. */}
            <div style={{ '--prose-width': 'none' } as React.CSSProperties}>
              <MarkdownBody source={note.content} transformHtml={transformHtml}/>
            </div>

            <footer className="mt-16 border-t border-[var(--border-subtle)] pt-6 text-center">
              <a href="/" className="inline-flex items-center gap-1.5 text-[length:var(--text-11-5)] text-[var(--text-quaternary)] transition-colors hover:text-[var(--accent)]">
                <Logo size={12}/>{t("share.shared_via_site", { site: note.site.name })}</a>
            </footer>
          </article>) : null}
      </main>
    </div>);
}
function addShareAccess(html: string, slug: string): string {
    const template = document.createElement('template');
    template.innerHTML = prepareShareMarkup(html);
    for (const task of template.content.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox')) {
        task.disabled = true;
        task.removeAttribute('data-task-line');
        task.setAttribute('aria-label', t("share.tasks_in_public_shares_are_read_only"));
    }
    for (const element of template.content.querySelectorAll<HTMLImageElement | HTMLAnchorElement>('img[src], a[href]')) {
        const attr = element instanceof HTMLImageElement ? 'src' : 'href';
        const raw = element.getAttribute(attr);
        if (!raw)
            continue;
        try {
            const url = new URL(raw, window.location.origin);
            if (url.origin !== window.location.origin ||
                !/^\/api\/files\/[0-9a-hjkmnp-tv-z]{26}$/i.test(url.pathname)) {
                continue;
            }
            url.searchParams.set('share', slug);
            element.setAttribute(attr, `${url.pathname}${url.search}`);
        }
        catch {
        }
    }
    return template.innerHTML;
}
