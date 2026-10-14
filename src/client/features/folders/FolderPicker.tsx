import { useMemo, useState } from 'react';
import { Check, FolderClosed } from 'lucide-react';
import type { Folder } from '@shared/types';
import { Drawer } from '../../components/overlay';
import { DrawerSearchField } from '../../components/DrawerSearchField';
import { cn } from '../../lib/cn';
import { t } from '../../lib/i18n';
import { folderPathLabel } from '../../lib/folders';
import { compileQuery, queryKeeps } from '../../lib/query-match'
import { usePinyinVersion } from '../../lib/pinyin'

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
    const pinyinVersion = usePinyinVersion()
    const compiled = useMemo(() => compileQuery(query), [query, pinyinVersion]);
    const choices = useMemo(() => (folders ?? [])
        .map((folder) => ({ folder, path: folderPathLabel(folders, folder.id) }))
        .filter(({ folder, path }) => !excludedIds?.has(folder.id) && queryKeeps(compiled, path))
        .sort((a, b) => a.path.localeCompare(b.path)), [compiled, excludedIds, folders, pinyinVersion]);
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
      <DrawerSearchField
        autoFocus
        value={query}
        onChange={setQuery}
        compiled={compiled}
        placeholder={t("folders.search")}
      />
      <div className="space-y-1 p-2">
        {allowRoot && !query.trim() && (<FolderChoice label={rootLabel ?? t("folders.top_level")} selected={currentId === null} onClick={() => choose(null)}/>)}
        {choices.map(({ folder, path }) => (<FolderChoice key={folder.id} label={path} icon={folder.icon} color={folder.color} selected={currentId === folder.id} onClick={() => choose(folder.id)}/>))}
        {choices.length === 0 && (query.trim() || !allowRoot) && (<p className="px-3 py-10 text-center text-[length:var(--text-12-5)] text-[var(--text-quaternary)]">{t("folders.no_match")}</p>)}
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
            ? <span className="text-[length:var(--text-15)] leading-none">{icon}</span>
            : <FolderClosed size={16}/>}
      </span>
      <span className="min-w-0 flex-1 break-words text-[length:var(--text-13)]">{label}</span>
      {selected && <Check size={15} className="shrink-0 text-[var(--accent)]"/>}
    </button>);
}
