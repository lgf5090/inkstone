import { useMemo, useState } from 'react';
import { Check, FolderClosed, Search, Settings2 } from 'lucide-react';
import { ORGANIZER_COLORS, organizerColorLabel } from '@shared/organizer-colors';
import { cn } from '../../lib/cn';
import { t, useLocale } from '../../lib/i18n';
import { usePinyinVersion } from '../../lib/pinyin';
import {
    ICON_MAX_CODE_UNITS,
    EMOJI_ICON_CATEGORIES,
    isUsableIconGlyph,
    searchEmoji,
    type EmojiEntry,
} from '../../lib/emoji-catalog';
import { pushRecentIcon, useFolderPreferences } from '../../lib/folder-prefs';

const SWATCH_SIZE = 'size-7';
const TILE_SIZE = 'size-[26px]';
const COLOR_PANEL_WIDTH = 214;
const ICON_PANEL_WIDTH = 258;
const ICON_RESULT_LIMIT = 96;

function firstGrapheme(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed)
        return null;
    const segmented = typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function'
        ? null
        : Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(trimmed), (part) => part.segment);
    return (segmented?.[0] ?? Array.from(trimmed)[0]) ?? null;
}

function MenuPanel({ label, hint, width, children }: {
    label: string;
    hint?: React.ReactNode;
    width: number;
    children: React.ReactNode;
}) {
    return (<div className="rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-2 shadow-[var(--shadow-pop)] outline-none" style={{ width }} onClick={(event) => event.stopPropagation()}>
      <div className="flex min-w-0 items-baseline justify-between gap-2 px-0.5 pt-0.5 pb-2">
        <span className="text-[12px] font-medium text-[var(--text-secondary)]">{label}</span>
        {hint}
      </div>
      {children}
    </div>);
}

function SwatchButton({ active, label, color, onPick, children }: {
    active: boolean;
    label: string;
    color: string | null;
    onPick: () => void;
    children: React.ReactNode;
}) {
    return (<button type="button" aria-label={label} title={label} aria-pressed={active} onClick={onPick} className={cn('flex', SWATCH_SIZE, 'items-center justify-center rounded-full transition-transform hover:scale-110', color === null && 'border bg-[var(--bg-base)]', active
            ? color === null
                ? 'border-[var(--accent)] text-[var(--accent)] ring-2 ring-[var(--accent-ring)]'
                : 'ring-2 ring-[var(--accent-ring)] ring-offset-2 ring-offset-[var(--bg-overlay)]'
            : color === null && 'border-[var(--border-default)] text-[var(--text-quaternary)] hover:text-[var(--text-secondary)]')} style={color ? { backgroundColor: color } : undefined}>
      {children}
    </button>);
}

export function FolderColorMenu({ color, onSelectColor, onManageFolders }: {
    color?: string | null;
    onSelectColor: (color: string | null) => void;
    onManageFolders?: () => void;
}) {
    return (<MenuPanel label={t("folders.color")} width={COLOR_PANEL_WIDTH} hint={color
        ? (<span className="flex min-w-0 items-center gap-1 text-[11px] text-[var(--text-quaternary)]">
              <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden="true"/>
              <span className="truncate">{organizerColorLabel(color, t)}</span>
            </span>)
        : undefined}>
      <div role="group" aria-label={t("folders.color")} className="grid grid-cols-6 gap-1.5 px-0.5">
        <SwatchButton active={!color} label={t("folders.no_color")} color={null} onPick={() => onSelectColor(null)}>
          <FolderClosed size={13}/>
        </SwatchButton>
        {ORGANIZER_COLORS.map((value) => (<SwatchButton key={value} active={color === value} label={organizerColorLabel(value, t)} color={value} onPick={() => onSelectColor(value)}>
            {color === value && <Check size={13} className="text-white"/>}
          </SwatchButton>))}
      </div>
      {onManageFolders && (<>
          <div role="separator" className="my-2 h-px bg-[var(--border-subtle)]"/>
          <button type="button" onClick={onManageFolders} className="flex w-full items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-left text-[12.5px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]">
            <Settings2 size={13} className="shrink-0 text-[var(--text-tertiary)]"/>
            <span className="truncate">{t("folders.manage_folders")}</span>
          </button>
        </>)}
    </MenuPanel>);
}

function IconTile({ char, active, onPick }: {
    char: string;
    active: boolean;
    onPick: (char: string) => void;
}) {
    return (<button type="button" aria-pressed={active} onClick={() => onPick(char)} className={cn('flex', TILE_SIZE, 'items-center justify-center rounded-[var(--r-sm)] text-[15px] leading-none transition-transform hover:scale-[1.18]', active
        ? 'bg-[var(--accent-soft)] ring-1 ring-[var(--accent-ring)]'
        : 'hover:bg-[var(--bg-hover)]')}>
      {char}
    </button>);
}

function IconSection({ title, entries, current, onPick }: {
    title: string;
    entries: readonly EmojiEntry[];
    current: string | null;
    onPick: (char: string) => void;
}) {
    return (<div>
      <div className="sticky top-0 z-10 bg-[var(--bg-overlay)] px-1 py-1 text-[11px] font-medium text-[var(--text-tertiary)]">{title}</div>
      <div role="group" aria-label={title} className="grid grid-cols-8 gap-1 px-1 pb-1">
        {entries.map((entry) => <IconTile key={entry.char} char={entry.char} active={current === entry.char} onPick={onPick}/>)}
      </div>
    </div>);
}

export function FolderIconMenu({ icon, onSelectIcon }: {
    icon?: string | null;
    onSelectIcon: (icon: string | null) => void;
}) {
    const [query, setQuery] = useState('');
    const locale = useLocale();
    const pinyinVersion = usePinyinVersion();
    const { recentIcons } = useFolderPreferences();
    const trimmed = query.trim();
    const typed = useMemo(() => firstGrapheme(query), [query]);
    const typedUsable = typed !== null && isUsableIconGlyph(typed);
    const typedBlocked = typed !== null && !typedUsable
        ? typed.length > ICON_MAX_CODE_UNITS
            ? t("folders.icon_too_long_value0", { value0: ICON_MAX_CODE_UNITS })
            : t("folders.icon_unusable")
        : null;
    const matches = useMemo(() => {
        if (!trimmed)
            return null;
        const lower = trimmed.toLocaleLowerCase();
        const named = EMOJI_ICON_CATEGORIES.filter((category) => {
            const label = t(category.labelKey).toLocaleLowerCase();
            return label === lower || label.startsWith(lower) || label.includes(lower);
        });
        const found = new Map<string, EmojiEntry>();
        for (const category of named) {
            for (const entry of category.entries)
                found.set(entry.char, entry);
        }
        for (const entry of searchEmoji(trimmed))
            found.set(entry.char, entry);
        return [...found.values()].slice(0, ICON_RESULT_LIMIT);
    }, [trimmed, locale, pinyinVersion]);
    const pick = (char: string) => {
        pushRecentIcon(char);
        onSelectIcon(char);
    };
    return (<MenuPanel label={t("folders.icon")} width={ICON_PANEL_WIDTH} hint={icon
        ? (<span className="text-[15px] leading-none" aria-hidden="true">{icon}</span>)
        : undefined}>
      <label className="relative mb-1.5 block">
        <span className="sr-only">{t("folders.icon_search")}</span>
        <Search size={13} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-[var(--text-quaternary)]"/>
        <input type="text" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("folders.icon_search")} autoComplete="off" className="h-7 w-full rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-base)] pr-2 pl-7 text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)] focus:border-[var(--accent)]"/>
      </label>
      <div className="-mx-1 max-h-[226px] overflow-y-auto">
        {matches === null && recentIcons.length > 0 && (<IconSection title={t("folders.icon_recent")} entries={recentIcons.map((char) => ({ char, keys: 'recent' }))} current={icon ?? null} onPick={pick}/>)}
        {matches === null && EMOJI_ICON_CATEGORIES.map((category) => <IconSection key={category.id} title={t(category.labelKey)} entries={category.entries} current={icon ?? null} onPick={pick}/>)}
        {matches !== null && matches.length > 0 && (<IconSection title={t("folders.icon_matches_value0", { value0: matches.length })} entries={matches} current={icon ?? null} onPick={pick}/>)}
        {matches !== null && matches.length === 0 && (<div className="px-2 py-6 text-center">
              <p className="text-[12px] text-[var(--text-tertiary)]">{t("folders.icon_no_match")}</p>
              <p className="mt-1 text-[11px] text-[var(--text-quaternary)]">{typedBlocked ?? t("folders.icon_no_match_hint")}</p>
            </div>)}
      </div>
      <div role="separator" className="my-1.5 h-px bg-[var(--border-subtle)]"/>
      <div className="flex items-center gap-1.5">
        <button type="button" aria-pressed={!icon} onClick={() => onSelectIcon(null)} className={cn('flex h-7 shrink-0 items-center gap-1 rounded-[var(--r-sm)] border px-1.5 text-[11.5px] transition-colors', !icon
            ? 'border-[var(--accent)] text-[var(--accent)]'
            : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-default)] hover:bg-[var(--bg-hover)]')}>
          <FolderClosed size={13}/>
          <span>{t("folders.no_icon")}</span>
        </button>
        {typed !== null && (typedBlocked
            ? (<span className="min-w-0 flex-1 truncate text-right text-[11px] text-[var(--text-quaternary)]">{typedBlocked}</span>)
            : (<button type="button" onClick={() => pick(typed)} className="flex min-w-0 flex-1 items-center justify-end gap-1.5 rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-1.5 text-[11.5px] text-[var(--text-primary)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]">
                  <span className="text-[15px] leading-none">{typed}</span>
                  <span className="truncate">{t("folders.icon_use_typed")}</span>
                </button>))}
      </div>
    </MenuPanel>);
}
