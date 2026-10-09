import { Eraser } from 'lucide-react';
import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';
import { useBreakpoint, useNow } from '../../lib/hooks';
import { t } from '../../lib/i18n';
import { fullTime, shortSince } from '../../lib/time';
import { IconButton } from '../../components/primitives';
import { ExplorerNote } from './ExplorerNote';

/**
 * The notes this device has opened, newest first. The order is the reader's own trail, so
 * nothing re-sorts it: a note that stops existing drops out of the list rather than leaving
 * a hole, and the rest keeps the sequence it was walked in.
 *
 * Each row also says how long ago that note was last written, on a tick clock, so a list read
 * in the morning still says something true in the afternoon.
 */
export function SidebarRecent() {
    const recentIds = useUi((s) => s.recentNoteIds);
    const notes = useNotes((s) => s.notes);
    const clearRecentNotes = useUi((s) => s.clearRecentNotes);
    const canOpenToSide = useBreakpoint() === 'desktop';
    const now = useNow(60_000);
    const visible = recentIds
        .map((id) => notes[id])
        .filter((note) => !!note && !note.deletedAt && !note.isArchived);
    return (<>
      <div className="flex items-center justify-center">
        {visible.length > 0 && (
          <IconButton label={t('sidebar.recent_clear')} size="sm" onClick={clearRecentNotes} data-recent-clear>
            <Eraser size={13}/>
          </IconButton>
        )}
      </div>
      {visible.length === 0 ? (<p className="px-2 py-3 text-[12px] leading-relaxed text-[var(--text-quaternary)]">{t('sidebar.recent_empty')}</p>) : (<div role="tree" aria-label={t('sidebar.tab_recent')} data-recent-list className="space-y-px">
          {visible.map((note) => (<ExplorerNote
            key={note.id}
            note={note}
            depth={0}
            canOpenToSide={canOpenToSide}
            trailing={(<span data-recent-age title={fullTime(note.updatedAt)} className="shrink-0 pr-1 text-[10.5px] tabular text-[var(--text-quaternary)]">
                    {shortSince(note.updatedAt, now)}
                  </span>)}
          />))}
        </div>)}
    </>);
}
