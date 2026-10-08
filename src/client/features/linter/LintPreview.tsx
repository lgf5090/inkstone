/**
 * The dialog that shows what a run would do before it does it.
 *
 * The reference plugin keeps a dockable diff view; this app has one modal surface per question, so
 * the preview is a dialog over the rows the drive already worked out. The rows arrive as plain data
 * — the diff is computed where the rules are, behind the same dynamic import — which keeps this file
 * light enough to sit in the shell from the first render.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/primitives';
import { Modal } from '../../components/overlay';
import { cn } from '../../lib/cn';
import { t } from '../../lib/i18n';
import type { PreviewDiff, PreviewRow } from '../../lib/linter/preview-rows';

export type LintPreviewRequest = {
    diff: PreviewDiff;
    /** The rules that would change the note, already spelled as the reader names them. */
    rules: string;
};

type Pending = {
    request: LintPreviewRequest;
    resolve: (value: boolean) => void;
};

let enqueue: ((pending: Pending) => void) | null = null;

/** Ask the reader whether the change shown should be applied. False when they say no or dismiss it. */
export function requestLintPreview(request: LintPreviewRequest): Promise<boolean> {
    if (!enqueue) {
        return Promise.resolve(false);
    }

    return new Promise((resolve) => {
        enqueue?.({ request, resolve });
    });
}

const ROW_CLASS: Record<string, string> = {
    context: 'text-[var(--text-tertiary)]',
    added: 'bg-[var(--success)]/10 text-[var(--success)]',
    removed: 'bg-[var(--danger)]/10 text-[var(--danger)]',
};

const HIGHLIGHT: Record<string, string> = {
    removed: 'bg-[var(--danger)]/35',
    added: 'bg-[var(--success)]/35',
};

/**
 * The line, with the characters the run disagrees about set apart. Two rows of spaces are otherwise
 * indistinguishable, and spaces are most of what this linter moves.
 */
function RowText({ row }: { row: PreviewRow }) {
    const span = row.changed;
    if (!span || span.end <= span.start) {
        return <>{row.text}</>;
    }

    return (<>
      {row.text.slice(0, span.start)}
      <span className={cn('rounded-[2px]', HIGHLIGHT[row.kind])}>{row.text.slice(span.start, span.end)}</span>
      {row.text.slice(span.end)}
    </>);
}

export function LintPreviewHost() {
    const [pending, setPending] = useState<Pending | null>(null);
    const [showAll, setShowAll] = useState(false);
    const pendingRef = useRef<Pending | null>(null);

    useEffect(() => {
        enqueue = (next) => {
            if (pendingRef.current) {
                next.resolve(false);
                return;
            }
            pendingRef.current = next;
            setShowAll(false);
            setPending(next);
        };

        return () => {
            enqueue = null;
            pendingRef.current?.resolve(false);
            pendingRef.current = null;
        };
    }, []);

    const finish = useCallback((value: boolean) => {
        const current = pendingRef.current;
        if (!current) {
            return;
        }
        current.resolve(value);
        pendingRef.current = null;
        setPending(null);
    }, []);

    const diff = pending?.request.diff;
    if (!diff) {
        return null;
    }

    const rows = showAll ? diff.rows : diff.rows.slice(0, 240);

    return (<Modal open onClose={() => finish(false)} title={t('linter.preview.title')} description={t('linter.notice_text.diff_summary', {
        LINES_ADDED: diff.linesAdded,
        LINES_REMOVED: diff.linesRemoved,
        CHARS_ADDED: diff.charsAdded,
        CHARS_REMOVED: diff.charsRemoved,
    })} width={720} footer={<>
          <Button variant="ghost" onClick={() => finish(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => finish(true)} data-autofocus>{t('linter.notice_text.apply_lint_preview')}</Button>
        </>}>
      <div className="space-y-3">
        <p className="break-words text-[12px] text-[var(--text-secondary)]">{t('linter.preview.summary', { rules: pending.request.rules })}</p>
        {diff.truncated && !showAll && (<div className="space-y-2">
              <p className="text-[11.5px] text-[var(--text-tertiary)]">{t('linter.notice_text.diff_large_file_warning')}</p>
              <Button size="sm" variant="secondary" onClick={() => setShowAll(true)}>{t('linter.notice_text.show_diff')}</Button>
            </div>)}
        <div className="max-h-[46vh] overflow-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-2 font-mono text-[11.5px] leading-relaxed">
          {rows.map((row, index) => (<div key={index} className={`flex gap-2 whitespace-pre-wrap break-words rounded-[2px] px-1 ${ROW_CLASS[row.kind]}`}>
                <span aria-hidden="true" className="w-4 shrink-0 select-none text-right text-[var(--text-quaternary)]">{row.kind === 'added' ? '+' : row.kind === 'removed' ? '-' : ''}</span>
                <span aria-hidden="true" className="w-10 shrink-0 select-none text-right text-[var(--text-quaternary)]">{row.line}</span>
                <span className="min-w-0 flex-1"><RowText row={row}/></span>
            </div>))}
          {diff.hidden > 0 && (<p className="px-1 pt-1 text-[11px] text-[var(--text-quaternary)]">{t('linter.notice_text.diff_skipped_lines', { COUNT: diff.hidden })}</p>)}
        </div>
      </div>
    </Modal>);
}
