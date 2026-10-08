import { memo, useRef, useState } from 'react';
import { Archive, Columns2, FileText, FolderInput, MoreHorizontal, Star, Trash2 } from 'lucide-react';
import type { Folder, NoteSummary } from '@shared/types';
import { numericCollator } from '../../lib/collator';
import { cn } from '../../lib/cn';
import { t } from '../../lib/i18n';
import { IconButton } from '../../components/primitives';
import { Menu, useContextMenu, type MenuItem } from '../../components/overlay';
import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';
import { FolderPicker } from '../folders/FolderPicker';
import { writeNoteDrag } from '../../lib/note-drag';
import { collapseOrLeave, moveTreeFocus } from './tree-keyboard';
import { noteFolderOwner } from '../../lib/folders';

export function groupExplorerNotes(notes: Record<string, NoteSummary>, folders: Folder[], locale: string): Map<string | null, NoteSummary[]> {
    const folderIds = new Set(folders.map((folder) => folder.id));
    const groups = new Map<string | null, NoteSummary[]>();
    for (const note of Object.values(notes)) {
        if (note.deletedAt || note.isArchived) continue;
        const parent = noteFolderOwner(note, folderIds);
        const siblings = groups.get(parent) ?? [];
        siblings.push(note);
        groups.set(parent, siblings);
    }
    for (const siblings of groups.values()) {
        const collator = numericCollator(locale);
        siblings.sort((a, b) => collator.compare(a.title, b.title) || a.id.localeCompare(b.id));
    }
    return groups;
}

export const ExplorerNote = memo(ExplorerNoteRow);

// Every explorer row subscribes to several store slices; without memoising the row, a note
// change re-renders every visible row in the explorer.
function ExplorerNoteRow({ note, depth, canOpenToSide, trailing }: { note: NoteSummary; depth: number; canOpenToSide: boolean; trailing?: React.ReactNode }) {
    const active = useUi((s) => s.activeNoteId === note.id);
    const openNote = useNotes((s) => s.openNote);
    const patchNote = useNotes((s) => s.patchNote);
    const deleteNote = useNotes((s) => s.deleteNote);
    const folders = useNotes((s) => s.folders);
    const anchor = useRef<HTMLDivElement>(null);
    const contextMenu = useContextMenu();
    const [menuOpen, setMenuOpen] = useState(false);
    const [moving, setMoving] = useState(false);
    const open = (side = false) => {
        useUi.getState().openExplorer(folders.some((folder) => folder.id === note.folderId) ? note.folderId : null);
        void openNote(note.id, side ? { pane: 'secondary' } : undefined);
    };
    const items: MenuItem[] = [
        ...(canOpenToSide ? [{ id: 'side', label: t('notes.open_to_side'), icon: <Columns2 size={13}/>, onSelect: () => open(true) }] : []),
        { id: 'star', label: note.isStarred ? t('common.remove_from_favorites') : t('navigation.favorites'), icon: <Star size={13}/>, onSelect: () => void patchNote(note.id, { isStarred: !note.isStarred }) },
        { id: 'move', label: t('notes.move_to_folder'), icon: <FolderInput size={13}/>, onSelect: () => setMoving(true) },
        { id: 'archive', label: t('navigation.archive'), icon: <Archive size={13}/>, onSelect: () => void patchNote(note.id, { isArchived: true }) },
        { id: 'delete', label: t('common.move_to_trash'), icon: <Trash2 size={13}/>, separatorBefore: true, tone: 'danger', onSelect: () => void deleteNote(note.id) },
    ];
    return <div role="treeitem" aria-level={depth + 1} aria-selected={active} data-tree-note-id={note.id}>
        <div ref={anchor} draggable onDragStart={(event) => {
            const selected = useUi.getState().selectedIds;
            writeNoteDrag(event, selected.length > 1 && selected.includes(note.id) ? selected : [note.id]);
        }} onContextMenu={(event) => { setMenuOpen(false); contextMenu.onContextMenu(event); }} className={cn('group relative flex h-11 items-center gap-1 rounded-[var(--r-md)] pr-1 md:h-[30px]', active ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')} style={{ paddingLeft: 6 + depth * 13 }}>
            <span className="w-8 shrink-0 md:w-4"/>
            <FileText size={14} className={cn('shrink-0', active ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]')}/>
            <button type="button" data-tree-note-open data-tree-row data-navigation-item aria-current={active ? 'page' : undefined} title={note.title || t('common.untitled_note')} onClick={() => open()} onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    if (moveTreeFocus(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1)) event.preventDefault();
                    return;
                }
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    if (collapseOrLeave(event.currentTarget)) event.preventDefault();
                }
            }} className="h-full min-w-0 flex-1 truncate pl-1 text-left text-[12.5px]">
                {note.title || t('common.untitled_note')}
            </button>
            {trailing}
            <IconButton label={t('common.more_actions')} size="sm" onClick={() => { contextMenu.close(); setMenuOpen(true); }} className="shrink-0 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"><MoreHorizontal size={13}/></IconButton>
        </div>
        <Menu anchor={anchor} open={menuOpen} onClose={() => setMenuOpen(false)} items={items}/>
        {contextMenu.point && <Menu anchor={contextMenu.point} open onClose={contextMenu.close} items={items}/>}
        <FolderPicker open={moving} title={t('notes.move_to_folder')} folders={folders} currentId={note.folderId} onSelect={(folderId) => void patchNote(note.id, { folderId })} onClose={() => setMoving(false)}/>
    </div>;
}
