import type { InputHTMLAttributes, ReactNode, Ref } from 'react';
import { useId, useRef } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '../lib/cn';
import { t } from '../lib/i18n';
import type { Query } from '../lib/query-match';
import { IconButton } from './primitives';

interface FilterInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'size'> {
    value: string;
    onChange: (next: string) => void;
    /** The same text `value` holds, compiled: the box says in its own words what a refused expression cost. */
    query: Query;
    label: string;
    /** `panel` is the bordered, full-height box a modal or settings page draws; `sidebar` is the quiet one. */
    size?: 'sidebar' | 'panel';
    /** For the listing that moves the caret back into the box when its last row goes away. */
    inputRef?: Ref<HTMLInputElement>;
    /** A control the listing keeps beside the box, drawn inside it. */
    trailing?: ReactNode;
}

const BOX = {
    sidebar: {
        icon: 'left-2',
        input: 'h-10 pr-7 pl-7 md:h-[28px] md:pr-6',
        border: 'border-transparent focus:border-[var(--accent)]',
        clear: 'right-1',
    },
    panel: {
        icon: 'left-2.5',
        input: 'h-10 pr-8 pl-8',
        border: 'border-[var(--border-default)] focus:border-[var(--accent)]',
        clear: 'right-1.5',
    },
} as const;

/**
 * The filter box every sidebar listing uses: it searches by fuzzily-matched letters, by the reading
 * of a Chinese label, and by a `/regular expression/`, and it is the one place that says so when a
 * pattern is refused.
 */
export function FilterInput({
    value,
    onChange,
    query,
    label,
    size = 'sidebar',
    inputRef,
    trailing,
    className,
    ...rest
}: FilterInputProps) {
    const box = BOX[size];
    const own = useRef<HTMLInputElement | null>(null);
    const hintId = useId();
    const error = query.error;
    const attach = (node: HTMLInputElement | null): void => {
        own.current = node;
        if (typeof inputRef === 'function')
            inputRef(node);
        else if (inputRef && typeof inputRef === 'object')
            inputRef.current = node;
    };
    return (<div className={cn('mt-1', className)}>
      <div className="relative">
        <Search size={13} className={cn('pointer-events-none absolute top-1/2 -translate-y-1/2 text-[var(--text-quaternary)]', box.icon)}/>
        <input
          {...rest}
          type="search"
          ref={attach}
          spellCheck={false}
          autoComplete="off"
          aria-label={label}
          title={t("filter.regex_hint")}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? hintId : undefined}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
                        rest.onKeyDown?.(event);
                        // The box owns its keys: a shortcut that fires while the reader is typing a name would
                        // take the keystroke, and the listing above answers arrows of its own.
                        event.stopPropagation();
                        if (event.defaultPrevented || event.key !== 'Escape')
                            return;
                        if (value)
                            onChange('');
                        else
                            own.current?.blur();
                    }}
          className={cn('w-full rounded-[var(--r-md)] border bg-[var(--bg-inset)] text-[12.5px] text-[var(--text-primary)]', 'placeholder:text-[var(--text-quaternary)]', '[&::-webkit-search-cancel-button]:hidden [&::-webkit-search-results-button]:hidden', 'transition-[border-color,box-shadow] duration-[var(--dur-fast)]', 'focus:shadow-[0_0_0_3px_var(--accent-ring)] focus:outline-none', box.input,
              error ? 'border-[var(--danger)] focus:border-[var(--danger)]' : box.border)}
        />
        {value && (<IconButton label={t("notes.clear_filters")} size="sm" onClick={() => {
                    onChange('');
                    own.current?.focus();
                }} className={cn('absolute top-1/2 -translate-y-1/2', box.clear)}>
          <X size={11}/>
        </IconButton>)}
        {trailing}
      </div>
      {error && (<p id={hintId} role="status" className="px-2 pt-1 text-[10.5px] text-[var(--danger)]">{error === 'syntax' ? t("filter.regex_syntax") : t("filter.regex_unsafe")}</p>)}
    </div>);
}
