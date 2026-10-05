import { useMemo, useState } from 'react';
import { Check, FolderClosed, Search } from 'lucide-react';
import type { Folder } from '@shared/types';
import { Drawer } from '../../components/overlay';
import { cn } from '../../lib/cn';
import { t } from '../../lib/i18n';
import { folderPathLabel } from '../../lib/folders';

export function FolderPicker({
    open,
    title,
    folders,
    currentId,
    excludedIds,
    allowRoot = true,
    rootLabel,
    onSelect,
    onClose,
}: {
    open: boolean;
    title: string;
    folders: Folder[];
    currentId?: string | null;
    excludedIds?: ReadonlySet<string>;
    allowRoot?: boolean;
    rootLabel?: string;
    onSelect: (folderId: string | null) => void;
    onClose: () => void;
}) {
    const [query, setQuery] = useState('');
    const choices = useMemo(() => {
        const normalized = query.trim().toLocaleLowerCase();
        return (folders ?? [])
            .map((folder) => ({ folder, path: folderPathLabel(folders, folder.id) }))
            .filter(({ folder, path }) => !excludedIds?.has(folder.id) && (!normalized || path.toLocaleLowerCase().includes(normalized)))
            .sort((a, b) => a.path.localeCompare(b.path));
    }, [excludedIds, folders, query]);
    const choose = (folderId: string | null) => {
        if (folderId !== currentId)
            onSelect(folderId);
        setQuery('');
        onClose();
    };
    return (<Drawer open={open} onClose={() => {
        setQuery('');
        onClose();
    }} title={title} width={420}>
      <div className="sticky top-0 z-10 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
        <label className="relative block">
          <Search size={14} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[var(--text-quaternary)]"/>
          <span className="sr-only">{t("folders.search")}</span>
          <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("folders.search")} className="h-10 w-full rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-base)] pr-3 pl-9 text-[13px] outline-none focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_var(--accent-ring)]"/>
        </label>
      </div>
      <div className="space-y-1 p-2">
        {allowRoot && !query.trim() && (<FolderChoice label={rootLabel ?? t("folders.top_level")} selected={currentId === null} onClick={() => choose(null)}/>)}
        {choices.map(({ folder, path }) => (<FolderChoice key={folder.id} label={path} icon={folder.icon} color={folder.color} selected={currentId === folder.id} onClick={() => choose(folder.id)}/>))}
        {choices.length === 0 && (query.trim() || !allowRoot) && (<p className="px-3 py-10 text-center text-[12.5px] text-[var(--text-quaternary)]">{t("folders.no_match")}</p>)}
      </div>
    </Drawer>);
}

function FolderChoice({ label, icon, color, selected, onClick }: {
    label: string;
    icon?: string | null;
    color?: string | null;
    selected: boolean;
    onClick: () => void;
}) {
    return (<button type="button" aria-pressed={selected} onClick={onClick} className={cn('flex min-h-11 w-full items-center gap-3 rounded-[var(--r-md)] px-3 text-left transition-colors', selected ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}>
      <span className="flex size-6 shrink-0 items-center justify-center" style={{ color: color ?? 'var(--text-tertiary)' }}>
        {icon
            ? <span className="text-[15px] leading-none">{icon}</span>
            : <FolderClosed size={16}/>}
      </span>
      <span className="min-w-0 flex-1 break-words text-[13px]">{label}</span>
      {selected && <Check size={15} className="shrink-0 text-[var(--accent)]"/>}
    </button>);
}
