import { useEffect, useMemo, useRef } from 'react';
import { Link, Link2 } from 'lucide-react';
import type { NoteSummary } from '@shared/types';
import { extractWikiLinks, normalizeLinkKey } from '@shared/markdown-utils';
import { t } from '../../lib/i18n';
import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';

interface Outbound {
    note: NoteSummary;
    alias: string | null;
}

/**
 * The links the note itself points at, read off its own text rather than the server's
 * link table: the table is rebuilt on save, so a link typed a moment ago is already
 * here while the backlink on the other side is not. A target that resolves to no note
 * is kept and shown apart — that is the list a reader uses to find the titles they
 * mis-typed.
 */
export function SidebarOutlinks() {
    const activeId = useUi((s) => s.activeNoteId);
    const notes = useNotes((s) => s.notes);
    const content = useNotes((s) => (activeId ? s.contents[activeId] : undefined));
    const openNote = useNotes((s) => s.openNote);
    const requested = useRef<string | null>(null);

    useEffect(() => {
        if (!activeId || content !== undefined || requested.current === activeId)
            return;
        requested.current = activeId;
        void openNote(activeId);
    }, [activeId, content, openNote]);

    const byKey = useMemo(() => {
        const map = new Map<string, NoteSummary>();
        for (const note of Object.values(notes)) {
            if (note.deletedAt || note.id === activeId)
                continue;
            if (!map.has(normalizeLinkKey(note.title)))
                map.set(normalizeLinkKey(note.title), note);
        }
        return map;
    }, [notes, activeId]);

    const { linked, missing } = useMemo(() => {
        if (!activeId || content === undefined)
            return { linked: [] as Outbound[], missing: [] as string[] };
        const found: Outbound[] = [];
        const gaps: string[] = [];
        for (const link of extractWikiLinks(content)) {
            const note = byKey.get(link.key);
            if (note) {
                if (!found.some((item) => item.note.id === note.id))
                    found.push({ note, alias: link.alias });
            }
            else if (!gaps.includes(link.target)) {
                gaps.push(link.target);
            }
        }
        return { linked: found, missing: gaps };
    }, [activeId, content, byKey]);

    if (!activeId)
        return <p className="px-2 py-3 text-[12px] leading-relaxed text-[var(--text-quaternary)]">{t('sidebar.links_no_note')}</p>;
    if (content === undefined)
        return <p className="px-2 py-3 text-[12px] text-[var(--text-quaternary)]">{t('common.loading')}</p>;
    return (<>
      {linked.length === 0 && missing.length === 0 ? (<p className="px-2 py-3 text-[12px] leading-relaxed text-[var(--text-quaternary)]">{t('sidebar.outlinks_empty')}</p>) : null}
      {linked.length > 0 && (<div role="list" aria-label={t('sidebar.tab_outlinks')} data-outlink-list className="space-y-px">
        {linked.map(({ note, alias }) => (<button key={note.id} type="button" role="listitem" data-outlink-id={note.id} onClick={() => void openNote(note.id)} className="flex w-full items-center gap-2 rounded-[var(--r-md)] px-2 py-1.5 text-left text-[12.5px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]">
              <Link size={12} className="shrink-0 text-[var(--text-quaternary)]"/>
              <span className="min-w-0 flex-1 truncate">{note.title || t('common.untitled_note')}</span>
              {alias && <span className="shrink-0 truncate text-[11px] text-[var(--text-quaternary)]">{alias}</span>}
            </button>))}
      </div>)}
      {missing.length > 0 && (<>
          <div className="mt-2 flex items-center gap-1.5 px-2 pt-1 text-[10.5px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
            <Link2 size={11}/>{t('sidebar.outlinks_unresolved')}<span className="tabular">· {missing.length}</span>
          </div>
          <div role="list" aria-label={t('sidebar.outlinks_unresolved')} data-unresolved-list>
            {missing.map((target) => (<p key={target} role="listitem" className="truncate px-2 py-1 text-[12px] text-[var(--text-quaternary)]">{target}</p>))}
          </div>
        </>)}
    </>);
}
