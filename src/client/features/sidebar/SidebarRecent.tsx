import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';
import { useBreakpoint } from '../../lib/hooks';
import { t } from '../../lib/i18n';
import { SectionLabel } from '../../components/primitives';
import { ExplorerNote } from './ExplorerNote';

/**
 * The notes this device has opened, newest first. The order is the reader's own trail, so
 * nothing re-sorts it: a note that stops existing drops out of the list rather than
 * leaving a hole, and the rest keeps the sequence it was walked in.
 */
export function SidebarRecent() {
    const recentIds = useUi((s) => s.recentNoteIds);
    const notes = useNotes((s) => s.notes);
    const canOpenToSide = useBreakpoint() === 'desktop';
    const visible = recentIds
        .map((id) => notes[id])
        .filter((note) => !!note && !note.deletedAt && !note.isArchived);
    return (<>
      <SectionLabel>{t('sidebar.tab_recent')}</SectionLabel>
      {visible.length === 0 ? (<p className="px-2 py-3 text-[12px] leading-relaxed text-[var(--text-quaternary)]">{t('sidebar.recent_empty')}</p>) : (<div role="tree" aria-label={t('sidebar.tab_recent')} data-recent-list className="space-y-px">
          {visible.map((note) => <ExplorerNote key={note.id} note={note} depth={0} canOpenToSide={canOpenToSide}/>)}
        </div>)}
    </>);
}
