import { useEffect, useMemo, useState } from 'react';
import { FileText } from 'lucide-react';
import type { NoteSummary } from '@shared/types';
import { Drawer } from '../../components/overlay';
import { DrawerSearchField } from '../../components/DrawerSearchField';
import { t } from '../../lib/i18n';
import { folderPathLabel } from '../../lib/folders';
import { compileQuery, queryKeepsRows, queryMatches } from '../../lib/query-match';
import { usePinyinVersion } from '../../lib/pinyin';
import { useNotes } from '../../store/notes';

const MAX_ROWS = 200;

export interface PickedNote {
    id: string
    title: string
}

/** A row once the vault has been walked: the label to match on and the folder to show under it. */
interface NoteRow {
    note: NoteSummary
    label: string
    path: string
}

const NO_ROWS: NoteRow[] = [];

/**
 * The note a map action is about: the one to link a node to, or the one whose
 * headings become branches.
 *
 * A map is drawn from the whole notebook, so this lists the whole notebook rather
 * than a folder's contents, and it says which folder each title came out of — two
 * notes called "Reading" are only told apart by where they live, and picking the
 * wrong one writes a link nobody notices until it points somewhere unexpected.
 */
export function NotePicker({ open, title, initialQuery, excludeNoteId, filter, onClose, onSelect }: {
    open: boolean;
    title: string;
    /** What the reader had already typed where the list was opened from. */
    initialQuery?: string;
    excludeNoteId?: string;
    /** A surface that cannot render a note type leaves it out of the list entirely. */
    filter?: (note: NoteSummary) => boolean;
    onClose: () => void;
    onSelect: (note: PickedNote) => void;
}) {
    const notes = useNotes((s) => s.notes);
    const folders = useNotes((s) => s.folders);
    const pinyinVersion = usePinyinVersion();
    const [query, setQuery] = useState('');
    const compiled = useMemo(() => compileQuery(query), [query, pinyinVersion]);

    // The characters that opened the list are its first filter: a reader who typed `[[Rea`
    // has already said what they are after, and an empty search box would ask them to type
    // it again. Only on the way in — while the list is up, the box belongs to them.
    useEffect(() => {
        if (open)
            setQuery(initialQuery ?? '');
    }, [open, initialQuery]);

    // The walk and the sort happen once per open, not once per keystroke. Matching a query is
    // the only thing that has to keep up with typing, and paying for the folder chain and the
    // name order on every character is what made a large vault feel the delay.
    const rows = useMemo(() => {
        if (!open)
            return NO_ROWS;
        const matched: NoteRow[] = [];
        for (const note of Object.values(notes)) {
            if (note.deletedAt || note.isArchived || note.id === excludeNoteId)
                continue;
            if (filter && !filter(note))
                continue;
            matched.push({ note, label: note.title || t('common.untitled_note'), path: folderPathLabel(folders, note.folderId) });
        }
        matched.sort((a, b) => (a.note.title || '').localeCompare(b.note.title || ''));
        return matched;
    }, [excludeNoteId, filter, folders, notes, open]);

    const visible = useMemo(() => {
        // Every note is matched, and the cap is taken afterwards: stopping at the first N
        // matches would hide the note the reader was about to type, because the store's order
        // is by recency and this list is ordered by name.
        const found = queryKeepsRows(compiled) ? rows : rows.filter((row) => queryMatches(compiled, row.label) !== null);
        return found.slice(0, MAX_ROWS);
    }, [compiled, pinyinVersion, rows]);

    const close = () => {
        setQuery('');
        onClose();
    };

    return (
      <Drawer open={open} onClose={close} title={title} width={420}>
        <DrawerSearchField
          autoFocus
          value={query}
          onChange={setQuery}
          compiled={compiled}
          placeholder={t('mindmap.search_notes')}
        />
        <div className="space-y-1 p-2">
          {visible.map(({ note, label, path }) => (
            <NoteChoice
              key={note.id}
              label={label}
              path={path}
              onClick={() => {
                                setQuery('');
                                onClose();
                                onSelect({ id: note.id, title: note.title });
                            }}
            />
          ))}
          {visible.length === 0 && <p className="px-3 py-10 text-center text-[length:var(--text-12-5)] text-[var(--text-quaternary)]">{t('folders.no_match')}</p>}
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
          <span className="block truncate text-[length:var(--text-13)] text-[var(--text-primary)]">{label}</span>
          {path && <span className="block truncate text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{path}</span>}
        </span>
      </button>
    );
}
