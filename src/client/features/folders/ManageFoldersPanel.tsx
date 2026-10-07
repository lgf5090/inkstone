import { useMemo, useState } from 'react';
import { FolderOpen, Inbox, Palette, Plus, Search, Smile, Trash2, Eraser, Pencil } from 'lucide-react';
import type { Folder, NoteSummary } from '@shared/types';
import { Button, IconButton } from '../../components/primitives';
import { Input } from '../../components/form';
import { Empty } from '../../components/feedback';
import { Modal, Tooltip, confirm } from '../../components/overlay';
import { folderPathLabel, openFolderView } from '../../lib/folders';
import { setInboxFolderId, useFolderPreferences } from '../../lib/folder-prefs';
import { t } from '../../lib/i18n';
import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';
import { FolderColorMenu, FolderIconMenu } from './FolderAppearanceMenus';
import { matchesQuery } from '../../lib/fuzzy'
import { usePinyinVersion } from '../../lib/pinyin'

interface FolderChoice {
    folder: Folder;
    path: string;
}

function directNoteCounts(notes: Record<string, NoteSummary>): Map<string, number> {
    const counts = new Map<string, number>();
    for (const note of Object.values(notes)) {
        if (!note.folderId || note.deletedAt || note.isArchived)
            continue;
        counts.set(note.folderId, (counts.get(note.folderId) ?? 0) + 1);
    }
    return counts;
}

function isRemovable(folder: Folder, counts: ReadonlyMap<string, number>, folders: Folder[]): boolean {
    return (counts.get(folder.id) ?? 0) === 0 && !folders.some((child) => child.parentId === folder.id);
}

export function ManageFoldersPanel({ onClose }: { onClose: () => void }) {
    const folders = useNotes((s) => s.folders);
    const notes = useNotes((s) => s.notes);
    const createFolder = useNotes((s) => s.createFolder);
    const patchFolder = useNotes((s) => s.patchFolder);
    const deleteFolder = useNotes((s) => s.deleteFolder);
    const toast = useUi((s) => s.toast);
    const { inboxFolderId } = useFolderPreferences();
    const [query, setQuery] = useState('');
    const [creating, setCreating] = useState(false);
    const [draftName, setDraftName] = useState('');
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const [colorPickerId, setColorPickerId] = useState<string | null>(null);
    const [iconPickerId, setIconPickerId] = useState<string | null>(null);
    const counts = useMemo(() => directNoteCounts(notes), [notes]);
    const pinyinVersion = usePinyinVersion()
    const choices = useMemo<FolderChoice[]>(() => {
        const normalized = query.trim();
        return folders
            .map((folder) => ({ folder, path: folderPathLabel(folders, folder.id) }))
            .filter(({ path }) => !normalized || matchesQuery(path, normalized))
            .sort((a, b) => a.path.localeCompare(b.path));
    }, [folders, query, pinyinVersion]);
    const emptyFolders = useMemo(() => folders.filter((folder) => isRemovable(folder, counts, folders)), [counts, folders]);
    const submitDraft = () => {
        const name = draftName.trim();
        setDraftName('');
        setCreating(false);
        if (!name)
            return;
        if (createFolder({ name }))
            toast({ title: t("notes.created"), tone: 'success' });
    };
    const commitRename = (folder: Folder) => {
        const name = renameValue.trim();
        setRenamingId(null);
        if (name && name !== folder.name)
            patchFolder(folder.id, { name });
    };
    const toggleInbox = (folder: Folder) => {
        if (inboxFolderId === folder.id) {
            setInboxFolderId(null);
            toast({ title: t("folders.inbox_cleared_toast"), tone: 'default' });
            return;
        }
        setInboxFolderId(folder.id);
        toast({ title: t("folders.inbox_set_toast", { value0: folder.name }), tone: 'success' });
    };
    const remove = async (folder: Folder) => {
        const direct = counts.get(folder.id) ?? 0;
        const children = folders.filter((child) => child.parentId === folder.id).length;
        const ok = await confirm({
            title: t("sidebar.delete_folder_value0", { value0: folder.name }),
            description: direct || children
                ? t("folders.delete_contents_move_up", { value0: direct, value1: children })
                : t("sidebar.this_folder_is_empty"),
            confirmLabel: t("common.delete"),
            tone: 'danger',
        });
        if (ok)
            deleteFolder(folder.id);
    };
    const cleanEmpty = async () => {
        if (emptyFolders.length === 0) {
            toast({ title: t("folders.clean_empty_none"), tone: 'default' });
            return;
        }
        const ok = await confirm({
            title: t("folders.clean_empty"),
            description: t("folders.clean_empty_confirm_value0", { value0: emptyFolders.length }),
            confirmLabel: t("common.delete"),
            tone: 'danger',
        });
        if (!ok)
            return;
        for (const folder of emptyFolders)
            deleteFolder(folder.id);
        toast({ title: t("folders.clean_empty_success", { value0: emptyFolders.length }), tone: 'success' });
    };
    return (<Modal open onClose={onClose} title={t("folders.manage_folders")} description={t("folders.manage_description")} width={680}>
      <div className="space-y-3 pt-1">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-[180px] flex-1">
            <span className="sr-only">{t("folders.search")}</span>
            <Input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("folders.search")} leading={<Search size={14} aria-hidden="true"/>}/>
          </label>
          <Button icon={<Plus size={13}/>} onClick={() => {
            setCreating((value) => !value);
            setDraftName('');
          }}>
            {t("common.new_folder")}
          </Button>
          <Button variant="ghost" icon={<Eraser size={13}/>} disabled={emptyFolders.length === 0} onClick={() => void cleanEmpty()}>
            {t("folders.clean_empty_value0", { value0: emptyFolders.length })}
          </Button>
        </div>
        {creating && (<form className="flex items-center gap-2" onSubmit={(event) => {
            event.preventDefault();
            submitDraft();
        }}>
          <span className="sr-only">{t("common.new_folder")}</span>
          <Input autoFocus value={draftName} onChange={(event) => setDraftName(event.target.value)} placeholder={t("common.new_folder")}/>
          <Button type="submit" variant="primary" disabled={!draftName.trim()}>{t("common.new_folder")}</Button>
          <Button variant="ghost" onClick={() => {
            setCreating(false);
            setDraftName('');
          }}>{t("common.cancel")}</Button>
        </form>)}
        {choices.length === 0
          ? <Empty compact title={t("folders.no_folders")}/>
          : (<ul className="space-y-1">
            {choices.map(({ folder, path }) => (<li key={folder.id} className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-1.5">
              <div className="flex items-center gap-2">
                <span className="flex size-6 shrink-0 items-center justify-center text-[15px] leading-none" style={{ color: folder.color ?? 'var(--text-tertiary)' }}>
                  {folder.icon || <FolderOpen size={15}/>}
                </span>
                {renamingId === folder.id
                  ? (<form className="min-w-0 flex-1" onSubmit={(event) => {
                    event.preventDefault();
                    commitRename(folder);
                }}>
                  <span className="sr-only">{t("sidebar.rename")}</span>
                  <Input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onBlur={() => commitRename(folder)} onKeyDown={(event) => {
                    if (event.key === 'Escape')
                        setRenamingId(null);
                    event.stopPropagation();
                }} aria-label={t("sidebar.rename")}/>
                </form>)
                  : (<button type="button" onClick={() => {
                    openFolderView(folders, folder.id);
                    onClose();
                }} className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-[12.5px] font-medium text-[var(--text-primary)]">{folder.name}</span>
                    <span className="block truncate text-[11px] text-[var(--text-quaternary)]">{path}</span>
                  </button>)}
                <span className="shrink-0 text-[11px] tabular text-[var(--text-quaternary)]">{t("folders.notes_count", { value0: counts.get(folder.id) ?? 0 })}</span>
                <span className="flex shrink-0 items-center gap-0.5">
                  <Tooltip label={inboxFolderId === folder.id ? t("folders.unset_inbox") : t("folders.set_as_inbox")} side="left">
                    <IconButton label={inboxFolderId === folder.id ? t("folders.unset_inbox") : t("folders.set_as_inbox")} size="sm" active={inboxFolderId === folder.id} onClick={() => toggleInbox(folder)}>
                      <Inbox size={13}/>
                    </IconButton>
                  </Tooltip>
                  <Tooltip label={t("folders.color")} side="left">
                    <IconButton label={t("folders.color")} size="sm" active={colorPickerId === folder.id} onClick={() => {
                    setColorPickerId((current) => current === folder.id ? null : folder.id);
                    setIconPickerId(null);
                }}>
                      <Palette size={13}/>
                    </IconButton>
                  </Tooltip>
                  <Tooltip label={t("folders.icon")} side="left">
                    <IconButton label={t("folders.icon")} size="sm" active={iconPickerId === folder.id} onClick={() => {
                    setIconPickerId((current) => current === folder.id ? null : folder.id);
                    setColorPickerId(null);
                }}>
                      <Smile size={13}/>
                    </IconButton>
                  </Tooltip>
                  <Tooltip label={t("sidebar.rename")} side="left">
                    <IconButton label={t("sidebar.rename")} size="sm" onClick={() => {
                    setRenamingId(folder.id);
                    setRenameValue(folder.name);
                }}>
                      <Pencil size={13}/>
                    </IconButton>
                  </Tooltip>
                  <Tooltip label={t("sidebar.delete_folder")} side="left">
                    <IconButton label={t("sidebar.delete_folder")} size="sm" onClick={() => void remove(folder)} className="text-[var(--danger)]">
                      <Trash2 size={13}/>
                    </IconButton>
                  </Tooltip>
                </span>
              </div>
              {colorPickerId === folder.id && (<div className="pt-2">
                <FolderColorMenu color={folder.color} onSelectColor={(color) => {
                patchFolder(folder.id, { color });
                setColorPickerId(null);
            }}/>
              </div>)}
              {iconPickerId === folder.id && (<div className="pt-2">
                <FolderIconMenu icon={folder.icon} onSelectIcon={(icon, source) => {
                patchFolder(folder.id, { icon });
                if (source === 'grid')
                    setIconPickerId(null);
            }}/>
              </div>)}
            </li>))}
          </ul>)}
      </div>
    </Modal>);
}
