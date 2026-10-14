import { useRef } from 'react';
import type { ReactNode } from 'react';
import { splitByRanges } from '../../lib/fuzzy';
import { queryMatches, type Query } from '../../lib/query-match';
import { commitOnEnter } from '../../components/form';
import { t } from '../../lib/i18n';
import { isImeComposing } from '../../lib/ime';

/**
 * A tag name with the letters a filter query reached marked out. Shared by the sidebar tag tree and
 * the manage dialog so the two cannot drift apart on how a hit is drawn. A reading-based hit has no
 * letters in the label to mark, so the name comes back plain rather than underlining the wrong ones.
 */
export function TagNameHighlight({ name, query }: { name: string; query: Query }): ReactNode {
    const match = queryMatches(query, name);
    if (!match)
        return name;
    return splitByRanges(name, match.ranges).map((part, index) => part.hit
        ? <span key={index} className="font-semibold text-[var(--accent)]">{part.text}</span>
        : <span key={index}>{part.text}</span>);
}

/** The one box a tag row draws in place of its name while it is being renamed. */
export const TAG_RENAME_INPUT_CLASS =
    'min-w-0 flex-1 rounded-[var(--r-xs)] border border-[var(--accent)] bg-[var(--bg-surface)] px-1 py-px text-[length:var(--text-12-5)] outline-none';

/**
 * The uncontrolled rename box both tag rows edit in place: it commits once on Enter or blur, drops the
 * edit on Escape, and stops the keystroke from reaching the surrounding tree keyboard.
 */
export function TagRenameField({ initial, onCommit, onCancel }: {
    initial: string;
    onCommit: (value: string) => void;
    onCancel: () => void;
}) {
    const finished = useRef(false);
    const commit = (value: string) => {
        if (finished.current)
            return;
        finished.current = true;
        onCommit(value);
    };
    return (<input aria-label={t('tags.rename')} autoFocus defaultValue={initial} onFocus={() => {
            finished.current = false;
        }} onBlur={(event) => commit(event.currentTarget.value)} onKeyDown={(event) => {
            if (isImeComposing(event))
                return;
            commitOnEnter(event, () => commit(event.currentTarget.value));
            if (event.key === 'Escape') {
                finished.current = true;
                onCancel();
            }
            event.stopPropagation();
        }} className={TAG_RENAME_INPUT_CLASS}/>);
}
