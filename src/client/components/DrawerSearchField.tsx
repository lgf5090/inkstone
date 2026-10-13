import { useId, useRef } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '../lib/cn';
import { t } from '../lib/i18n';
import type { Query } from '../lib/query-match';
import { IconButton } from './primitives';

/**
 * The search box a drawer puts above its list: the sticky header, the icon, a label the screen
 * reader reads, and the one filter reading every other listing in the app offers.
 *
 * Two drawers that list the whole notebook — the folder picker and the mindmap's note picker —
 * drew this box twice, character for character, and each stopped at the raw matcher instead of
 * {@link compileQuery}. A pattern that worked in every sidebar listing therefore quietly did
 * nothing here, and neither box could say why a refused one had. The compiled query is handed in
 * rather than compiled here so a caller filters with the same object the box is describing.
 *
 * Escape clears a box that is not empty and is swallowed there, so the drawer it sits in stays
 * open; an empty box lets the key through, which is the drawer's own close.
 */
export function DrawerSearchField({
    value,
    onChange,
    compiled,
    placeholder,
    autoFocus,
    trailing,
    className,
}: {
    value: string;
    onChange: (next: string) => void;
    /** The same text `value` holds, compiled: the box says in its own words what a refused expression cost. */
    compiled: Query;
    placeholder: string;
    autoFocus?: boolean;
    trailing?: React.ReactNode;
    className?: string;
}) {
    const own = useRef<HTMLInputElement | null>(null);
    const hintId = useId();
    return (<div className={cn('sticky top-0 z-10 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3', className)}>
      <div className="relative">
        <Search size={14} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[var(--text-quaternary)]"/>
        <label>
          <span className="sr-only">{placeholder}</span>
          <input
            autoFocus={autoFocus}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={placeholder}
            aria-label={placeholder}
            aria-invalid={compiled.error ? true : undefined}
            aria-describedby={compiled.error ? hintId : undefined}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || !value)
                return;
              event.preventDefault();
              event.stopPropagation();
              onChange('');
            }}
            className="h-10 w-full rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-base)] pr-9 pl-9 text-[13px] outline-none focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_var(--accent-ring)]"
          />
        </label>
        {value && (<IconButton label={t('notes.clear_filters')} size="sm" onClick={() => {
          onChange('');
          own.current?.focus();
        }} className="absolute top-1/2 right-2 -translate-y-1/2">
          <X size={12}/>
        </IconButton>)}
        {trailing}
      </div>
      {compiled.error && (<p id={hintId} role="status" className="px-1 pt-1.5 text-[11.5px] text-[var(--danger)]">{compiled.error === 'syntax' ? t('filter.regex_syntax') : t('filter.regex_unsafe')}</p>)}
    </div>);
}
