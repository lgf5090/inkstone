import { useEffect, useState } from 'react';
import { ArrowUpRight, Link2, Link as LinkIcon, MessageSquareText, MessagesSquare, Sparkles } from 'lucide-react';
import type { AssistantConversation } from '@shared/assistant';
import type { Backlink } from '@shared/types';
import { api } from '../../lib/api';
import { Button } from '../../components/primitives';
import { useNotes } from '../../store/notes';
import { t } from "../../lib/i18n";
import { relativeTime } from '../../lib/time';
import { openConversationInChat } from '../chat/start-chat';

/** How many of a note's threads the panel asks for. The section is a pointer list, not the chat's own library. */
const CONVERSATIONS_SHOWN = 20;

export function BacklinksPanel({ noteId, fill = false }: {
    noteId: string;
    /** In the sidebar tab the panel owns the column, so it grows instead of taking a slice of the editor. */
    fill?: boolean;
}) {
    const [links, setLinks] = useState<Backlink[] | null>(null);
    const [mentions, setMentions] = useState<Backlink[]>([]);
    /** The conversations that wrote this note, which is the half `[[links]]` cannot answer. */
    const [origins, setOrigins] = useState<{ id: string; title: string; updatedAt: number }[]>([]);
    /** The conversations started from this note — the other direction, and the one a reader asks about. */
    const [about, setAbout] = useState<AssistantConversation[] | null>(null);
    const [aboutError, setAboutError] = useState<string | null>(null);
    const [aboutReload, setAboutReload] = useState(0);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [reload, setReload] = useState(0);
    const [linking, setLinking] = useState<string | null>(null);
    const openNote = useNotes((s) => s.openNote);
    const linkMention = useNotes((s) => s.linkMention);
    const rev = useNotes((s) => s.notes[noteId]?.rev ?? 0);
    useEffect(() => {
        setLinks(null);
        // The thread list describes the note being read, so the previous note's rows go with it: a stale
        // row about another page under this one's heading would be a link the reader did not ask for.
        setAbout(null);
        setAboutError(null);
    }, [noteId]);
    // Which threads were started from this note answers from the conversation's own `note_id`, so it follows
    // the note rather than the keystrokes inside it: no debounce and no revision here, and its own retry so a
    // failed read can be asked again without refetching the note's backlinks.
    useEffect(() => {
        const controller = new AbortController();
        let cancelled = false;
        api.assistant
            .conversations({ noteId, limit: String(CONVERSATIONS_SHOWN) }, controller.signal)
            .then((res) => {
            // Newest first, whatever the list screen's pinned-shortcut order says: this section answers "what
            // have I been talking about here lately", and a pinned thread about something else would lead it.
            if (!cancelled) {
                setAbout([...res.conversations].sort((a, b) => b.updatedAt - a.updatedAt));
                setAboutError(null);
            }
        })
            .catch((error) => {
            // A refused read says so. Left as an empty list it would tell the reader this note started no
            // conversations, which is a fact the request never established.
            if (!cancelled)
                setAboutError(error instanceof Error ? error.message : String(error));
        });
        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [noteId, aboutReload]);
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
            // A second question, asked beside the first: which conversations wrote this note. It is a
            // separate request because the assistant is a separate module — the notes route has no
            // business reading the chat's tables. A failure here leaves the section empty rather than
            // failing the panel: the note's own backlinks are the part the reader came for.
            api.assistant
                .noteWrites(noteId, controller.signal)
                .then((res) => {
                if (!cancelled)
                    setOrigins(res.conversations);
            })
                .catch(() => {
                if (!cancelled)
                    setOrigins([]);
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
              <span className="min-w-0 truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">
                {link.title}
              </span>
              <ArrowUpRight size={11} className="shrink-0 text-[var(--text-quaternary)] opacity-0 transition-opacity group-hover:opacity-100"/>
            </div>
            <p className="truncate-2 mt-0.5 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
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
    /**
     * One thread this note is connected to: its title, when it last moved, and the chat it opens.
     *
     * Both conversation sections use it, because both do the same thing on press — hand the thread to the
     * chat app's own entry point, the one a `![[chat:id]]` embed follows, rather than a second copy of the
     * navigation that would drift from the first.
     */
    const conversationRows = (items: { id: string; title: string; updatedAt: number }[]) => (<ul className="p-2">
      {items.map((item) => (<li key={item.id}>
          <button
            type="button"
            onClick={() => openConversationInChat(item.id)}
            className="flex w-full min-w-0 items-baseline justify-between gap-2 rounded-[var(--r-md)] px-2 py-2 text-left transition-colors hover:bg-[var(--bg-hover)]"
          >
            <span className="min-w-0 truncate text-[length:var(--text-12-5)] text-[var(--text-primary)]">{item.title || t("assistant.chat.untitled")}</span>
            <span className="shrink-0 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{relativeTime(item.updatedAt)}</span>
          </button>
        </li>))}
    </ul>);

    return (<section className={fill ? 'min-h-0' : 'max-h-[36%] shrink-0 overflow-y-auto border-t border-[var(--border-subtle)] bg-[var(--bg-base)]'}>
      {fill
        ? links && links.length > 0 && (<div className="flex items-center justify-center gap-1.5 px-2 pt-1 pb-1 text-[length:var(--text-10-5)] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
            <Link2 size={11} aria-hidden="true"/><span className="tabular">· {links.length}</span>
          </div>)
        : (<div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2 text-[length:var(--text-10-5)] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
            <Link2 size={11}/>{t("common.backlinks")}{links && links.length > 0 && <span className="tabular">· {links.length}</span>}
          </div>)}

      {loadError ? (<div className="flex items-center justify-between gap-3 px-3 py-4 text-[length:var(--text-12)] text-[var(--text-quaternary)]"><span>{t("workspace.could_not_load_backlinks")}</span><Button size="sm" variant="ghost" onClick={() => setReload((value) => value + 1)}>{t("common.retry")}</Button></div>) : links === null ? (<div className="px-3 py-4 text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t("common.loading")}</div>) : links.length === 0 ? (<div className="px-3 py-4 text-[length:var(--text-12)] leading-relaxed text-[var(--text-quaternary)]">{t("workspace.no_notes_link_here_yet_write")}{' '}
        <code className="rounded bg-[var(--bg-inset)] px-1 py-0.5 font-mono text-[length:var(--text-11)]">{t("workspace.title")}</code>{' '}{t("workspace.will_appear_here")}</div>) : rows(links)}

      {links !== null && mentions.length > 0 && (<>
          <div className="sticky top-0 z-10 flex items-center gap-1.5 border-t border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2 text-[length:var(--text-10-5)] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
            <MessageSquareText size={11} aria-hidden="true"/>{t("workspace.mentions_here")}<span className="tabular">· {mentions.length}</span>
          </div>
          {rows(mentions, linkOne)}
        </>)}

      {origins.length > 0 && (<>
          <div className="sticky top-0 z-10 flex items-center gap-1.5 border-t border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2 text-[length:var(--text-10-5)] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
            <Sparkles size={11} aria-hidden="true"/>{t("workspace.from_conversations")}<span className="tabular">· {origins.length}</span>
          </div>
          {conversationRows(origins)}
        </>)}

      {/* The threads started from this note — the direction the reader asks from the page itself, and the
          one `[[links]]` and the write log both leave unanswered. A refused read says so below rather than
          drawing an empty list, because an empty list is a claim about this note that the request never
          established. The row is mirrored here rather than imported from `features/chat`: this file already
          prints its own failure row for the note's backlinks, and the shared one is that app's settings
          screen kit, not a boundary it publishes. */}
      {aboutError !== null && (<div className="flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] px-3 py-4 text-[length:var(--text-12)] text-[var(--text-quaternary)]">
          <span>{t("workspace.could_not_load_conversations")}</span><Button size="sm" variant="ghost" onClick={() => setAboutReload((value) => value + 1)}>{t("common.retry")}</Button>
        </div>)}

      {about !== null && about.length > 0 && aboutError === null && (<>
          <div className="sticky top-0 z-10 flex items-center gap-1.5 border-t border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2 text-[length:var(--text-10-5)] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
            <MessagesSquare size={11} aria-hidden="true"/>{t("workspace.conversations_about")}<span className="tabular">· {about.length}</span>
          </div>
          {conversationRows(about)}
        </>)}
    </section>);
}
