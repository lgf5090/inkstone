import type { InputHTMLAttributes, KeyboardEvent, ReactNode, Ref } from 'react';
import { useCallback, useEffect, useId, useRef } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '../lib/cn';
import { t } from '../lib/i18n';
import type { Query } from '../lib/query-match';
import { IconButton } from './primitives';

interface FilterInputOptions {
    value: string;
    /** What the box does with an Escape it decided to answer: take the text back out. */
    onClear: () => void;
    /**
     * The compiled text the box holds. Its refusal is what `aria-invalid` and the described-by hint
     * point at, and a box that filters by something other than a compiled query has nothing to refuse.
     */
    query?: Query;
    /**
     * What an Escape on an already-empty box costs. `blur` keeps the reader out of a listing they were
     * not looking at; `release` hands the key to the panel behind the box, which is how a modal or a
     * drawer is dismissed, and is the only reason a caller would rather not draw the box itself.
     */
    escapeWhenEmpty?: 'blur' | 'release';
    /** The listing's own arrows and Enter, asked before the box makes its decision. */
    onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
    /** A ref the listing keeps so it can move the caret back into the box. */
    inputRef?: Ref<HTMLInputElement>;
}

export interface FilterInputBindings {
    ref: (node: HTMLInputElement | null) => void;
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
    'aria-invalid': true | undefined;
    'aria-describedby': string | undefined;
}

/**
 * The keyboard and accessibility contract every filter box in the app answers to, separated from the
 * box's drawing so a listing with arrows and Enter of its own can take the contract without taking the
 * chrome — which is the only reason a box would rather not use {@link FilterInput}.
 *
 * Escape clears a box that has something to clear and swallows the key, so the panel behind it does not
 * close underneath the reader; an empty box does what `escapeWhenEmpty` says. A key that arrives while
 * an input method is composing an answer is not a key the box answers to at all — see `onKeyDown` — so
 * Escape cancels the syllable rather than the query. Every other key is
 * stopped here, because a shortcut that fires while the reader is typing a name would take the
 * keystroke, and the listing above answers arrows of its own. Spread the result onto the `input` and
 * call `clear` from the box's own clear control, which puts the caret back where the reader was.
 */
export function useFilterInput(options: FilterInputOptions): { field: FilterInputBindings, clear: () => void, hintId: string } {
    const live = useRef(options);
    useEffect(() => {
        live.current = options;
    });
    const own = useRef<HTMLInputElement | null>(null);
    const hintId = useId();
    const attach = useCallback((node: HTMLInputElement | null): void => {
        own.current = node;
        const forwarded = live.current.inputRef;
        if (typeof forwarded === 'function')
            forwarded(node);
        else if (forwarded && typeof forwarded === 'object')
            forwarded.current = node;
    }, []);
    const clear = useCallback((): void => {
        live.current.onClear();
        own.current?.focus();
    }, []);
    const onKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>): void => {
        // A pinyin IME answers Escape by dropping the half-built syllable, and it delivers the arrows
        // and Enter a reader presses to pick a candidate as keydowns carrying those same names. Bail
        // while a composition is open so Escape costs the syllable, not the whole query — the guard
        // the tree keyboard, the chat composer, the palette and the omnisearch prompt already answer.
        if (event.nativeEvent.isComposing)
            return;
        live.current.onKeyDown?.(event);
        if (event.defaultPrevented)
            return;
        if (event.key === 'Escape') {
            if (live.current.value) {
                event.preventDefault();
                event.stopPropagation();
                live.current.onClear();
                return;
            }
            if (live.current.escapeWhenEmpty !== 'release') {
                event.stopPropagation();
                own.current?.blur();
            }
            return;
        }
        event.stopPropagation();
    }, []);
    const error = options.query?.error ?? null;
    return {
        field: {
            ref: attach,
            onKeyDown,
            'aria-invalid': error ? true : undefined,
            'aria-describedby': error ? hintId : undefined,
        },
        clear,
        hintId,
    };
}

interface FilterInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'size'> {
    value: string;
    onChange: (next: string) => void;
    /** The same text `value` holds, compiled: the box says in its own words what a refused expression cost. */
    query: Query;
    label: string;
    /**
     * `sidebar` is the quiet box the file and tag rails draw, `panel` the bordered, full-height one a
     * modal or a settings page draws, and `drawer` the large box above the list inside a drawer — three
     * measurements of the same control, because each sits in a row of its own height.
     */
    size?: 'sidebar' | 'panel' | 'drawer';
    /** For the listing that moves the caret back into the box when its last row goes away. */
    inputRef?: Ref<HTMLInputElement>;
    /** A control the listing keeps beside the box, drawn inside it. */
    trailing?: ReactNode;
    /** An Escape on an already-empty box: the box loses focus, or the panel behind it is dismissed. */
    escapeWhenEmpty?: 'blur' | 'release';
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
    drawer: {
        icon: 'left-3',
        input: 'h-10 bg-[var(--bg-base)] px-9 text-[13px]',
        border: 'border-[var(--border-default)] focus:border-[var(--accent)]',
        clear: 'right-2',
    },
} as const;

/**
 * The filter box every listing in the app uses: it searches by fuzzily-matched letters, by the reading
 * of a Chinese label, and by a `/regular expression/`, and it is the one place that says so when a
 * pattern is refused. Its keys and ARIA come from {@link useFilterInput}, so a listing that has to keep
 * its own arrows draws a different box over the same contract instead of writing the contract again.
 */
export function FilterInput({
    value,
    onChange,
    query,
    label,
    size = 'sidebar',
    inputRef,
    trailing,
    escapeWhenEmpty = 'blur',
    className,
    ...rest
}: FilterInputProps) {
    const box = BOX[size];
    const { field, clear, hintId } = useFilterInput({
        value,
        query,
        inputRef,
        escapeWhenEmpty,
        onClear: () => onChange(''),
        onKeyDown: rest.onKeyDown,
    });
    const error = query.error;
    return (<div className={cn('mt-1', className)}>
      <div className="relative">
        <Search size={13} className={cn('pointer-events-none absolute top-1/2 -translate-y-1/2 text-[var(--text-quaternary)]', box.icon)}/>
        <input
          {...rest}
          type="search"
          {...field}
          spellCheck={false}
          autoComplete="off"
          aria-label={label}
          title={t("filter.regex_hint")}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={cn('w-full rounded-[var(--r-md)] border bg-[var(--bg-inset)] text-[12.5px] text-[var(--text-primary)]', 'placeholder:text-[var(--text-quaternary)]', '[&::-webkit-search-cancel-button]:hidden [&::-webkit-search-results-button]:hidden', 'transition-[border-color,box-shadow] duration-[var(--dur-fast)]', 'focus:shadow-[0_0_0_3px_var(--accent-ring)] focus:outline-none', box.input,
              error ? 'border-[var(--danger)] focus:border-[var(--danger)]' : box.border)}
        />
        {value && (<IconButton label={t("notes.clear_filters")} size="sm" onClick={clear} className={cn('absolute top-1/2 -translate-y-1/2', box.clear)}>
          <X size={11}/>
        </IconButton>)}
        {trailing}
      </div>
      {error && (<p id={hintId} role="status" className="px-2 pt-1 text-[10.5px] text-[var(--danger)]">{error === 'syntax' ? t("filter.regex_syntax") : t("filter.regex_unsafe")}</p>)}
    </div>);
}
