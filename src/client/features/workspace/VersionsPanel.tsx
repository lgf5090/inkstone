import { useEffect, useMemo, useRef, useState } from 'react';
import { History, RotateCcw } from 'lucide-react';
import type { NoteVersionMeta } from '@shared/types';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { formatBytes, fullTime } from '../../lib/time';
import { useRelativeTime } from '../../lib/hooks';
import { Button } from '../../components/primitives';
import { Modal, confirm } from '../../components/overlay';
import { Empty, LoadingBlock } from '../../components/feedback';
import { useUi } from '../../store/ui';
import { useActiveNote, useNotes } from '../../store/notes';
import { t } from "../../lib/i18n";
export function VersionsPanel({ onClose }: {
    onClose: () => void;
}) {
    const { note, content } = useActiveNote();
    const toast = useUi((s) => s.toast);
    const restoreVersion = useNotes((s) => s.restoreVersion);
    const [versions, setVersions] = useState<NoteVersionMeta[] | null>(null);
    const [versionsError, setVersionsError] = useState<string | null>(null);
    const [versionsReload, setVersionsReload] = useState(0);
    const [selected, setSelected] = useState<{ noteId: string; versionId: string } | null>(null);
    const [preview, setPreview] = useState<string | null>(null);
    const [previewError, setPreviewError] = useState<string | null>(null);
    const [previewReload, setPreviewReload] = useState(0);
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    const noteIdRef = useRef(note?.id);
    const restoreEpoch = useRef(0);
    noteIdRef.current = note?.id;
    const selectedId = selected && selected.noteId === note?.id ? selected.versionId : null;
    useEffect(() => {
        restoreEpoch.current += 1;
        busyRef.current = false;
        setBusy(false);
        setVersions(null);
        setVersionsError(null);
        setSelected(null);
        setPreview(null);
        setPreviewError(null);
        if (!note)
            return;
        const controller = new AbortController();
        let cancelled = false;
        api.notes
            .versions(note.id, controller.signal)
            .then((res) => {
            if (cancelled)
                return;
            setVersions(res.versions);
            setSelected(res.versions[0] ? { noteId: note.id, versionId: res.versions[0].id } : null);
        })
            .catch((error) => {
            if (!cancelled)
                setVersionsError(error instanceof Error ? error.message : String(error));
        });
        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [note?.id, versionsReload]);
    useEffect(() => () => {
        restoreEpoch.current += 1;
        busyRef.current = false;
    }, []);
    useEffect(() => {
        setPreview(null);
        setPreviewError(null);
        if (!note || !selectedId)
            return;
        const controller = new AbortController();
        let cancelled = false;
        api.notes
            .version(note.id, selectedId, controller.signal)
            .then((v) => {
            if (!cancelled)
                setPreview(v.content);
        })
            .catch((error) => {
            if (!cancelled)
                setPreviewError(error instanceof Error ? error.message : String(error));
        });
        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [note?.id, selectedId, previewReload]);
    const diff = useMemo(() => preview === null ? null : computeLineDiff(preview, content), [preview, content]);
    const restore = async () => {
        if (!note || !selectedId || preview === null || previewError || busyRef.current)
            return;
        const noteId = note.id;
        const versionId = selectedId;
        const epoch = ++restoreEpoch.current;
        busyRef.current = true;
        setBusy(true);
        try {
            const ok = await confirm({
                title: t("workspace.restore_this_version"),
                description: t("workspace.the_current_content_will_be_automatically_saved_as_a_new_version_first_a"),
                confirmLabel: t("common.restore"),
            });
            if (!ok || restoreEpoch.current !== epoch || noteIdRef.current !== noteId)
                return;
            const versionTitle = versions?.find((version) => version.id === versionId)?.title;
            void restoreVersion(noteId, versionId, preview, versionTitle);
            onClose();
        }
        catch (err) {
            if (restoreEpoch.current === epoch && noteIdRef.current === noteId)
                toast({ title: t("common.restore_failed"), description: err instanceof Error ? err.message : String(err), tone: 'danger' });
        }
        finally {
            if (restoreEpoch.current === epoch && noteIdRef.current === noteId) {
                busyRef.current = false;
                setBusy(false);
            }
        }
    };
    return (<Modal open onClose={onClose} title={t("common.version_history")} description={note ? t("workspace.autosave_for_value0", { value0: note.title }) : undefined} width={880} footer={<>
          <Button variant="ghost" onClick={onClose}>{t("common.close")}</Button>
          <Button variant="primary" icon={<RotateCcw size={13}/>} disabled={!selectedId || preview === null || Boolean(previewError) || busy} loading={busy} onClick={() => void restore()}>{t("workspace.restore_this_version_da5169")}</Button>
        </>}>
      {versionsError ? (<Empty art="notes" compact title={t("workspace.could_not_load_version_history")} description={versionsError} action={<Button size="sm" variant="secondary" onClick={() => setVersionsReload((value) => value + 1)}>{t("common.retry")}</Button>}/>) : versions === null ? (<LoadingBlock />) : versions.length === 0 ? (<Empty art="notes" compact title={t("workspace.no_version_history_yet")} description={t("workspace.a_snapshot_is_saved_every_few_minutes_or_after_larger_edits")}/>) : (<div className="flex h-[min(68dvh,560px)] min-h-0 flex-col gap-3 md:h-[440px] md:flex-row">
          <ul className="flex w-full shrink-0 gap-1 overflow-x-auto border-b border-[var(--border-subtle)] pb-2 md:block md:w-[210px] md:space-y-px md:overflow-y-auto md:border-r md:border-b-0 md:pr-2 md:pb-0">
            {versions.map((version, index) => (<li key={version.id} className="w-[188px] shrink-0 md:w-auto">
                <button type="button" aria-pressed={selectedId === version.id} onClick={() => setSelected({ noteId: note!.id, versionId: version.id })} className={cn('w-full rounded-[var(--r-md)] px-2 py-2 text-left transition-colors', selectedId === version.id
                    ? 'bg-[var(--accent-soft)]'
                    : 'hover:bg-[var(--bg-hover)]')}>
                  <div className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-primary)]">
                    <History size={11} className="shrink-0 text-[var(--text-quaternary)]"/>
                    {index === 0 ? t("workspace.latest") : <VersionAge timestamp={version.createdAt}/>}
                  </div>
                  <div className="mt-0.5 pl-4 text-[10.5px] text-[var(--text-quaternary)]">
                    {fullTime(version.createdAt)} · {formatBytes(version.size)}
                  </div>
                </button>
              </li>))}
          </ul>

          <div className="min-w-0 flex-1 overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)]">
            {previewError ? (<Empty art="notes" compact title={t("workspace.could_not_load_version")} description={previewError} action={<Button size="sm" variant="secondary" onClick={() => setPreviewReload((value) => value + 1)}>{t("common.retry")}</Button>}/>) : preview === null || !diff ? (<LoadingBlock />) : (<><div className="sticky top-0 flex items-center gap-3 border-b border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-1.5 text-[10.5px] text-[var(--text-quaternary)]">
              <span>{t("workspace.differences_from_current_content")}</span>
              <span className="text-[var(--success)]">+{diff.added}</span>
              <span className="text-[var(--danger)]">-{diff.removed}</span>
              {diff.simplified && <span>{t("workspace.large_content_using_a_faster_comparison")}</span>}
            </div>
            <pre className="p-3 font-mono text-[11.5px] leading-[1.65] whitespace-pre-wrap">
              {diff.lines.map((line, i) => (<div key={i} className={cn('px-1', line.kind === 'add' && 'bg-[color-mix(in_oklab,var(--success)_14%,transparent)]', line.kind === 'remove' && 'bg-[color-mix(in_oklab,var(--danger)_14%,transparent)]', line.kind === 'same' && 'text-[var(--text-tertiary)]')}>
                  <span className="mr-2 inline-block w-2 text-[var(--text-quaternary)]">
                    {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}
                  </span>
                  {line.text || ' '}
                </div>))}
            </pre></>)}
          </div>
        </div>)}
    </Modal>);
}
function VersionAge({ timestamp }: {
    timestamp: number;
}) {
    return useRelativeTime(timestamp);
}
interface DiffLine {
    kind: 'same' | 'add' | 'remove';
    text: string;
}
export interface DiffResult {
    lines: DiffLine[];
    added: number;
    removed: number;
    simplified: boolean;
}
const MAX_LCS_CELLS = 600000;
export const MAX_RENDERED_DIFF_LINES = 4000;


export function computeLineDiff(before: string, after: string): DiffResult {
    const a = before.split('\n');
    const b = after.split('\n');
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix])
        prefix++;
    let suffix = 0;
    while (suffix < a.length - prefix &&
        suffix < b.length - prefix &&
        a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
        suffix++;
    }
    const beforeMiddle = a.slice(prefix, a.length - suffix);
    const afterMiddle = b.slice(prefix, b.length - suffix);
    const cells = beforeMiddle.length * afterMiddle.length;
    const simplified = cells > MAX_LCS_CELLS;
    // The middle is only materialized when the LCS actually needs it; the unchanged head and
    // tail used to cost one object per line of the whole file (60k) before being truncated.
    const middle = simplified ? null : computeMiddleLcs(beforeMiddle, afterMiddle);
    let added = 0;
    let removed = 0;
    if (middle) {
        for (const line of middle) {
            if (line.kind === 'add')
                added++;
            else if (line.kind === 'remove')
                removed++;
        }
    }
    else {
        removed = beforeMiddle.length;
        added = afterMiddle.length;
    }
    const middleLength = middle ? middle.length : beforeMiddle.length + afterMiddle.length;
    const total = prefix + middleLength + suffix;
    const lineAt = (index: number): DiffLine => {
        if (index < prefix)
            return { kind: 'same', text: a[index]! };
        const rest = index - prefix;
        if (rest < middleLength) {
            if (middle) return middle[rest]!;
            return rest < beforeMiddle.length
                ? { kind: 'remove', text: beforeMiddle[rest]! }
                : { kind: 'add', text: afterMiddle[rest - beforeMiddle.length]! };
        }
        return { kind: 'same', text: a[a.length - suffix + (rest - middleLength)]! };
    };
    if (total <= MAX_RENDERED_DIFF_LINES) {
        const lines: DiffLine[] = [];
        for (let index = 0; index < total; index++) lines.push(lineAt(index));
        return { lines, added, removed, simplified };
    }
    const headKeep = Math.floor((MAX_RENDERED_DIFF_LINES - 1) / 2);
    const tailKeep = MAX_RENDERED_DIFF_LINES - headKeep - 1;
    const lines: DiffLine[] = [];
    for (let index = 0; index < headKeep; index++) lines.push(lineAt(index));
    lines.push({
        kind: 'same',
        text: t("workspace.value0_unchanged_lines_hidden", { value0: total - headKeep - tailKeep }),
    });
    for (let index = total - tailKeep; index < total; index++) lines.push(lineAt(index));
    return { lines, added, removed, simplified };
}
function computeMiddleLcs(a: string[], b: string[]): DiffLine[] {
    const width = b.length + 1;
    const table = new Uint16Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) {
        const row = i * width;
        const nextRow = (i + 1) * width;
        for (let j = b.length - 1; j >= 0; j--) {
            table[row + j] =
                a[i] === b[j]
                    ? table[nextRow + j + 1]! + 1
                    : Math.max(table[nextRow + j]!, table[row + j + 1]!);
        }
    }
    const lines: DiffLine[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            lines.push({ kind: 'same', text: a[i]! });
            i++;
            j++;
        }
        else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
            lines.push({ kind: 'remove', text: a[i]! });
            i++;
        }
        else {
            lines.push({ kind: 'add', text: b[j]! });
            j++;
        }
    }
    while (i < a.length) {
        lines.push({ kind: 'remove', text: a[i++]! });
    }
    while (j < b.length) {
        lines.push({ kind: 'add', text: b[j++]! });
    }
    return lines;
}
