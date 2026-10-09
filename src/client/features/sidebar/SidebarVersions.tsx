import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { NoteVersionMeta } from '@shared/types';
import { formatBytes, fullTime, relativeTime } from '../../lib/time';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';
import { Button, IconButton } from '../../components/primitives';
import { confirm, Tooltip } from '../../components/overlay';
import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';

/**
 * The saved snapshots of the note being read, newest first, with the one action that
 * matters from a narrow column: put one of them back. The diff view lives in the full
 * history panel because two note bodies do not fit side by side here.
 */
export function SidebarVersions() {
    const activeId = useUi((s) => s.activeNoteId);
    const rev = useNotes((s) => (activeId ? s.notes[activeId]?.rev ?? 0 : 0));
    const restoreVersion = useNotes((s) => s.restoreVersion);
    const [versions, setVersions] = useState<NoteVersionMeta[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [reload, setReload] = useState(0);
    const [busyId, setBusyId] = useState<string | null>(null);

    useEffect(() => {
        setVersions(null);
        setError(null);
        if (!activeId)
            return;
        const controller = new AbortController();
        let cancelled = false;
        const timer = window.setTimeout(() => {
            api.notes.versions(activeId, controller.signal)
                .then((res) => {
                    if (!cancelled)
                        setVersions(res.versions);
                })
                .catch((err) => {
                    if (!cancelled && (err as Error)?.name !== 'AbortError')
                        setError(err instanceof Error ? err.message : String(err));
                });
        }, 300);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
            controller.abort();
        };
    }, [activeId, rev, reload]);

    const restore = async (version: NoteVersionMeta) => {
        if (!activeId || busyId)
            return;
        setBusyId(version.id);
        try {
            const full = await api.notes.version(activeId, version.id);
            const ok = await confirm({
                title: t('sidebar.version_restore_title'),
                description: t('sidebar.version_restore_body', { value0: fullTime(version.createdAt) }),
                confirmLabel: t('common.restore'),
                tone: 'danger'
            });
            if (!ok)
                return;
            if (await restoreVersion(activeId, version.id, full.content, full.title))
                setReload((value) => value + 1);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
        finally {
            setBusyId(null);
        }
    };

    if (!activeId)
        return <p className="px-2 py-3 text-[12px] leading-relaxed text-[var(--text-quaternary)]">{t('sidebar.versions_no_note')}</p>;
    return (<>
      {error ? (<div className="flex items-center justify-between gap-2 px-2 py-3 text-[12px] text-[var(--text-quaternary)]"><span>{t('sidebar.versions_error')}</span><Button size="sm" variant="ghost" onClick={() => setReload((value) => value + 1)}>{t('common.retry')}</Button></div>) : versions === null ? (<p className="px-2 py-3 text-[12px] text-[var(--text-quaternary)]">{t('common.loading')}</p>) : versions.length === 0 ? (<p className="px-2 py-3 text-[12px] leading-relaxed text-[var(--text-quaternary)]">{t('sidebar.versions_empty')}</p>) : (<ol className="space-y-px" aria-label={t('sidebar.tab_history')} data-version-list>
          {versions.map((version) => (<li key={version.id} data-version-id={version.id} className="group flex items-center gap-1.5 rounded-[var(--r-md)] px-2 py-1.5 transition-colors hover:bg-[var(--bg-hover)]">
                <span className="min-w-0 flex-1" title={fullTime(version.createdAt)}>
                  <span className="block truncate text-[12.5px] text-[var(--text-primary)]">{relativeTime(version.createdAt)}</span>
                  <span className="block truncate text-[11px] text-[var(--text-quaternary)]">{formatBytes(version.size)}{version.title ? ` · ${version.title}` : ''}</span>
                </span>
                <Tooltip label={t('sidebar.version_restore')}>
                  <IconButton label={t('sidebar.version_restore')} size="sm" disabled={busyId !== null} onClick={() => void restore(version)}>
                    <RotateCcw size={12}/>
                  </IconButton>
                </Tooltip>
              </li>))}
        </ol>)}
    </>);
}

