import { useEffect, useState } from 'react';
import { ArrowUpRight, Link2, Link as LinkIcon, MessageSquareText } from 'lucide-react';
import type { Backlink } from '@shared/types';
import { api } from '../../lib/api';
import { Button } from '../../components/primitives';
import { useNotes } from '../../store/notes';
import { t } from "../../lib/i18n";

export function BacklinksPanel({ noteId, fill = false }: {
    noteId: string;
    /** In the sidebar tab the panel owns the column, so it grows instead of taking a slice of the editor. */
    fill?: boolean;
}) {
    const [links, setLinks] = useState<Backlink[] | null>(null);
    const [mentions, setMentions] = useState<Backlink[]>([]);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [reload, setReload] = useState(0);
    const [linking, setLinking] = useState<string | null>(null);
    const openNote = useNotes((s) => s.openNote);
    const linkMention = useNotes((s) => s.linkMention);
    const rev = useNotes((s) => s.notes[noteId]?.rev ?? 0);
    useEffect(() => {
        setLinks(null);
    }, [noteId]);
    useEffect(() => {
        const controller = new AbortController();
        let cancelled = false;
        // Debounced refresh on note revision changes; unrelated sync traffic
        // (cursor) no longer refetches, and stale links stay visible until the
        // fresh payload arrives.
        const timer = window.setTimeout(() => {
            api.notes
                .backlinks(noteId, controller.signal)
                .then((res) => {
                if (!cancelled) {
                    setLinks(res.backlinks);
                    setMentions(res.unlinked ?? []);
                    setLoadError(null);
                }
            })
                .catch((error) => {
                if (!cancelled)
                    setLoadError(error instanceof Error ? error.message : String(error));
            });
        }, 500);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
            controller.abort();
        };
    }, [noteId, rev, reload]);
    const linkOne = (link: Backlink) => {
        if (linking)
            return;
        setLinking(link.id);
        void linkMention(noteId, link.id)
            .then((outcome) => {
                if (outcome !== 'error')
                    setReload((value) => value + 1);
            })
            .finally(() => setLinking(null));
    };
    const rows = (items: Backlink[], onLink?: (link: Backlink) => void) => (<ul className="p-2">
      {items.map((link) => (<li key={link.id} className="group flex items-center gap-1">
          <button type="button" onClick={() => void openNote(link.id)} className="min-w-0 flex-1 rounded-[var(--r-md)] px-2 py-2 text-left transition-colors hover:bg-[var(--bg-hover)]">
            <div className="flex items-center gap-1.5">
              <span className="min-w-0 truncate text-[12.5px] font-medium text-[var(--text-primary)]">
                {link.title}
              </span>
              <ArrowUpRight size={11} className="shrink-0 text-[var(--text-quaternary)] opacity-0 transition-opacity group-hover:opacity-100"/>
            </div>
            <p className="truncate-2 mt-0.5 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">
              {link.context}
            </p>
          </button>
          {onLink && (
            <button
              type="button"
              onClick={() => onLink(link)}
              disabled={linking !== null}
              title={t("workspace.link_the_mention")}
              aria-label={`${t("workspace.link_the_mention")}: ${link.title}`}
              className="shrink-0 rounded-[var(--r-md)] p-1.5 text-[var(--text-quaternary)] opacity-0 transition-opacity hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:!opacity-100 disabled:opacity-40"
            >
              <LinkIcon size={13} aria-hidden="true"/>
            </button>
          )}
        </li>))}
    </ul>);

    return (<section className={fill ? 'min-h-0' : 'max-h-[36%] shrink-0 overflow-y-auto border-t border-[var(--border-subtle)] bg-[var(--bg-base)]'}>
      <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2 text-[10.5px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
        <Link2 size={11}/>{t("common.backlinks")}{links && links.length > 0 && <span className="tabular">· {links.length}</span>}
      </div>

      {loadError ? (<div className="flex items-center justify-between gap-3 px-3 py-4 text-[12px] text-[var(--text-quaternary)]"><span>{t("workspace.could_not_load_backlinks")}</span><Button size="sm" variant="ghost" onClick={() => setReload((value) => value + 1)}>{t("common.retry")}</Button></div>) : links === null ? (<div className="px-3 py-4 text-[12px] text-[var(--text-quaternary)]">{t("common.loading")}</div>) : links.length === 0 ? (<div className="px-3 py-4 text-[12px] leading-relaxed text-[var(--text-quaternary)]">{t("workspace.no_notes_link_here_yet_write")}{' '}
        <code className="rounded bg-[var(--bg-inset)] px-1 py-0.5 font-mono text-[11px]">{t("workspace.title")}</code>{' '}{t("workspace.will_appear_here")}</div>) : rows(links)}

      {links !== null && mentions.length > 0 && (<>
          <div className="sticky top-0 z-10 flex items-center gap-1.5 border-t border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2 text-[10.5px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
            <MessageSquareText size={11} aria-hidden="true"/>{t("workspace.mentions_here")}<span className="tabular">· {mentions.length}</span>
          </div>
          {rows(mentions, linkOne)}
        </>)}
    </section>);
}
