import type { Query } from '../lib/query-match';
import { FilterInput } from './FilterInput';

/**
 * The search box a drawer puts above its list: the sticky header it hangs in, and the one filter every
 * other listing in the app offers — drawn by {@link FilterInput}, because the box, its keys and its
 * refusal message are that component's, and only the header belongs to a drawer.
 *
 * Escape clears a box that is not empty and is swallowed there, so the drawer it sits in stays open;
 * an empty box lets the key through, which is the drawer's own close. The compiled query is handed in
 * rather than compiled here so a caller filters with the same object the box is describing.
 */
export function DrawerSearchField({
    value,
    onChange,
    compiled,
    placeholder,
    autoFocus,
}: {
    value: string;
    onChange: (next: string) => void;
    /** The same text `value` holds, compiled: the box says in its own words what a refused expression cost. */
    compiled: Query;
    placeholder: string;
    autoFocus?: boolean;
}) {
    return (<div className="sticky top-0 z-10 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
      <FilterInput
        size="drawer"
        escapeWhenEmpty="release"
        className="mt-0"
        autoFocus={autoFocus}
        value={value}
        onChange={onChange}
        query={compiled}
        label={placeholder}
      />
    </div>);
}
