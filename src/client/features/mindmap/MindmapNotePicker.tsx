import { useMemo, useState } from 'react';
import { FileText, Search } from 'lucide-react';
import type { NoteSummary } from '@shared/types';
import { Drawer } from '../../components/overlay';
import { t } from '../../lib/i18n';
import { folderPathLabel } from '../../lib/folders';
import { matchesQuery } from '../../lib/fuzzy';
import { usePinyinVersion } from '../../lib/pinyin';
import { useNotes } from '../../store/notes';

const MAX_ROWS = 200;

export interface PickedNote {
    id: string
    title: string
}

/**
 * The note a map action is about: the one to link a node to, or the one whose
 * headings become branches.
 *
 * A map is drawn from the whole notebook, so this lists the whole notebook rather
 * than a folder's contents, and it says which folder each title came out of — two
 * notes called "Reading" are only told apart by where they live, and picking the
 * wrong one writes a link nobody notices until it points somewhere unexpected.
 */
export function MindmapNotePicker({ open, title, excludeNoteId, onClose, onSelect }: {
    open: boolean;
    title: string;
    excludeNoteId?: string;
    onClose: () => void;
    onSelect: (note: PickedNote) => void;
}) {
    const notes = useNotes((s) => s.notes);
    const folders = useNotes((s) => s.folders);
    const pinyinVersion = usePinyinVersion();
    const [query, setQuery] = useState('');

    const rows = useMemo(() => {
        const text = query.trim();
        // Every note is looked at, and the cap is taken after the sort: stopping at the
        // first N matches would hide the note the reader was about to type, because the
        // store's order is by recency and this list is ordered by name.
        const matched: { note: NoteSummary; path: string }[] = [];
        for (const note of Object.values(notes)) {
            if (note.deletedAt || note.isArchived || note.id === excludeNoteId)
                continue;
            const label = note.title || t('common.untitled_note');
            if (text && !matchesQuery(label, text))
                continue;
            matched.push({ note, path: folderPathLabel(folders, note.folderId) });
        }
        matched.sort((a, b) => (a.note.title || '').localeCompare(b.note.title || ''));
        return matched.slice(0, MAX_ROWS);
    }, [excludeNoteId, folders, notes, pinyinVersion, query]);

    const close = () => {
        setQuery('');
        onClose();
    };

    return (
      <Drawer open={open} onClose={close} title={title} width={420}>
        <div className="sticky top-0 z-10 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
          <label className="relative block">
            <Search size={14} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[var(--text-quaternary)]"/>
            <span className="sr-only">{t('mindmap.search_notes')}</span>
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('mindmap.search_notes')}
              className="h-10 w-full rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-base)] pr-3 pl-9 text-[13px] outline-none focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_var(--accent-ring)]"
            />
          </label>
        </div>
        <div className="space-y-1 p-2">
          {rows.map(({ note, path }) => (
            <NoteChoice
              key={note.id}
              label={note.title || t('common.untitled_note')}
              path={path}
              onClick={() => {
                                setQuery('');
                                onClose();
                                onSelect({ id: note.id, title: note.title });
                            }}
            />
          ))}
          {rows.length === 0 && <p className="px-3 py-10 text-center text-[12.5px] text-[var(--text-quaternary)]">{t('folders.no_match')}</p>}
        </div>
      </Drawer>
    );
}

function NoteChoice({ label, path, onClick }: { label: string; path: string; onClick: () => void }) {
    return (
      <button type="button" onClick={onClick} className="flex min-h-11 w-full items-center gap-3 rounded-[var(--r-md)] px-3 text-left transition-colors hover:bg-[var(--bg-hover)]">
        <span className="flex size-6 shrink-0 items-center justify-center text-[var(--text-tertiary)]">
          <FileText size={16}/>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-[var(--text-primary)]">{label}</span>
          {path && <span className="block truncate text-[11.5px] text-[var(--text-quaternary)]">{path}</span>}
        </span>
      </button>
    );
}
