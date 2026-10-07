import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ChevronDown, Clock, Search, X } from 'lucide-react';
import { Tooltip } from '../../components/overlay';
import { cn } from '../../lib/cn';
import { t, useLocale, type MessageKey } from '../../lib/i18n';
import { usePinyinVersion } from '../../lib/pinyin';
import { EMOJI_TONE_LABEL_KEYS, EMOJI_TONE_SLOTS, emojiEntryForChar, emojiToneHand, emojiUnicodeGroups, emojiWithTone, requestEmojiUnicode, searchEmojiUnicode, useEmojiUnicodeVersion, type EmojiUnicodeEntry } from '../../lib/emoji-unicode';
import { useEmojiPreferences } from '../../lib/emoji-prefs';
import type { SkinTone } from '@shared/types';

const COLUMNS = 8;

const GROUP_META: Record<string, { icon: string; labelKey: MessageKey }> = {
    people: { icon: '😀', labelKey: 'emoji.category.people' },
    nature: { icon: '🌿', labelKey: 'emoji.category.nature' },
    foods: { icon: '🍔', labelKey: 'emoji.category.foods' },
    activity: { icon: '⚽', labelKey: 'emoji.category.activity' },
    places: { icon: '✈️', labelKey: 'emoji.category.places' },
    objects: { icon: '💡', labelKey: 'emoji.category.objects' },
    symbols: { icon: '❤️', labelKey: 'emoji.category.symbols' },
    flags: { icon: '🏁', labelKey: 'emoji.category.flags' },
};

const RECENT_GROUP = 'recent';

interface Tile {
    glyph: string;
    entry: EmojiUnicodeEntry | null;
}

function emojiDisplayName(entry: EmojiUnicodeEntry | null, locale: string): string {
    if (!entry)
        return '';
    if (locale === 'zh-CN' && entry.zh)
        return entry.zh.split(' ')[0]!;
    return entry.name;
}

export function EmojiPicker({ tone, onTone, onInsert }: {
    tone: SkinTone;
    onTone: (tone: SkinTone) => void;
    onInsert: (glyph: string, code: string | null) => void;
}) {
    const version = useEmojiUnicodeVersion();
    const pinyinVersion = usePinyinVersion();
    const locale = useLocale();
    const { recentEmojis } = useEmojiPreferences();
    const [query, setQuery] = useState('');
    const [groupId, setGroupId] = useState(RECENT_GROUP);
    const [active, setActive] = useState(0);
    const [hovered, setHovered] = useState<Tile | null>(null);
    const [toneOpen, setToneOpen] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const uid = useId();
    const searching = query.trim().length > 0;

    useEffect(() => {
        requestEmojiUnicode();
    }, []);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    const groups = useMemo(() => (version ? emojiUnicodeGroups() : []), [version]);
    const hits = useMemo(() => (searching ? searchEmojiUnicode(query) : []), [searching, query, version, pinyinVersion]);
    const shownGroup = groupId === RECENT_GROUP && recentEmojis.length === 0 && groups.length ? groups[0]!.id : groupId;
    const tiles = useMemo<Tile[]>(() => {
        if (searching)
            return hits.map((hit) => ({ glyph: emojiWithTone(hit.entry, tone), entry: hit.entry }));
        if (shownGroup === RECENT_GROUP)
            return recentEmojis.map((glyph) => ({ glyph, entry: emojiEntryForChar(glyph) ?? null }));
        const group = groups.find((item) => item.id === shownGroup);
        return (group?.entries ?? []).map((entry) => ({ glyph: emojiWithTone(entry, tone), entry }));
    }, [searching, hits, shownGroup, recentEmojis, groups, tone]);
    const preview = hovered ?? tiles[active] ?? null;

    useEffect(() => {
        setActive(0);
        setHovered(null);
    }, [query, shownGroup, tone, tiles.length]);

    useEffect(() => {
        document.getElementById(`${uid}-${active}`)?.scrollIntoView({ block: 'nearest' });
    }, [active, uid]);

    const step = (delta: number) => {
        setActive((current) => Math.max(0, Math.min(Math.max(0, tiles.length - 1), current + delta)));
    };

    const stepGroup = (delta: number) => {
        const ids = [recentEmojis.length ? RECENT_GROUP : null, ...groups.map((item) => item.id)].filter((id): id is string => id !== null);
        const next = ids[Math.min(ids.length - 1, Math.max(0, ids.indexOf(shownGroup) + delta))];
        if (next)
            setGroupId(next);
    };

    const insert = (tile: Tile) => {
        onInsert(tile.glyph, tile.entry?.code || null);
    };

    const onKeyDown = (event: ReactKeyboardEvent) => {
        const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS };
        const delta = moves[event.key];
        if (delta !== undefined) {
            event.preventDefault();
            step(delta);
            return;
        }
        if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            setActive(event.key === 'Home' ? 0 : Math.max(0, tiles.length - 1));
            return;
        }
        if (event.key === 'PageDown' || event.key === 'PageUp') {
            event.preventDefault();
            stepGroup(event.key === 'PageDown' ? 1 : -1);
            return;
        }
        if (event.key === 'Enter') {
            const tile = tiles[active];
            if (!tile)
                return;
            event.preventDefault();
            insert(tile);
        }
    };

    const navItems = [
        ...(recentEmojis.length ? [{ id: RECENT_GROUP, label: t('emoji.recent'), icon: <Clock size={14}/>, tone: false }] : []),
        ...groups.map((item) => ({
            id: item.id,
            label: t(GROUP_META[item.id]?.labelKey ?? 'emoji.category.people'),
            icon: <span aria-hidden="true" className="text-[14px] leading-none">{GROUP_META[item.id]?.icon ?? '😀'}</span>,
            tone: false,
        })),
    ];

    return (<div className="flex flex-col" onKeyDown={onKeyDown}>
      <div className="flex items-center gap-1.5 px-2 pt-2 pb-1.5">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">{t('emoji.search')}</span>
          <Search size={13} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-[var(--text-quaternary)]"/>
          <input ref={inputRef} type="text" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('emoji.search')} role="combobox" aria-expanded={true} aria-controls="emoji-grid" aria-activedescendant={tiles.length ? `${uid}-${active}` : undefined} autoComplete="off" spellCheck={false} className="h-8 w-full rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] pr-7 pl-7 text-[12.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)] focus:border-[var(--accent)]"/>
          {query && (<button type="button" aria-label={t('emoji.clear_search')} onClick={() => {
                    setQuery('');
                    inputRef.current?.focus();
                }} className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-[var(--text-quaternary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]">
                <X size={11}/>
              </button>)}
        </label>
        <Tooltip label={t('emoji.skin_tone')} side="bottom">
          <button type="button" aria-label={t('emoji.skin_tone')} aria-haspopup="true" aria-expanded={toneOpen} onClick={() => setToneOpen((current) => !current)} className="flex h-8 shrink-0 items-center gap-0.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-1.5 text-[14px] leading-none text-[var(--text-secondary)] transition-colors hover:border-[var(--border-default)] hover:bg-[var(--bg-hover)]">
              {emojiToneHand(tone)}<ChevronDown size={10} className="opacity-60"/>
            </button>
        </Tooltip>
      </div>
      <div className="flex items-center gap-0.5 overflow-x-auto px-2 pb-1.5 no-scrollbar" role="group" aria-label={t('emoji.categories')}>
        {navItems.map((item) => (<button key={item.id} type="button" aria-label={item.label} title={item.label} aria-pressed={!searching && item.id === shownGroup} onMouseDown={(event) => event.preventDefault()} onClick={() => {
                setGroupId(item.id);
                inputRef.current?.focus();
            }} className={cn('flex size-7 shrink-0 items-center justify-center rounded-[var(--r-md)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]', !searching && item.id === shownGroup && 'bg-[var(--accent-soft)] text-[var(--accent)]')}>
              {item.icon}
            </button>))}
      </div>
      {toneOpen && (<div role="group" aria-label={t('emoji.skin_tone')} className="flex items-center gap-1 border-y border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1.5">
          {EMOJI_TONE_SLOTS.map((slot) => (<button key={slot} type="button" aria-label={t(EMOJI_TONE_LABEL_KEYS[slot]!)} title={t(EMOJI_TONE_LABEL_KEYS[slot]!)} aria-pressed={tone === slot} onMouseDown={(event) => event.preventDefault()} onClick={() => {
                    onTone(slot as SkinTone);
                    setToneOpen(false);
                    inputRef.current?.focus();
                }} className={cn('flex size-7 shrink-0 items-center justify-center rounded-[var(--r-md)] text-[15px] leading-none transition-colors hover:bg-[var(--bg-hover)]', tone === slot ? 'bg-[var(--accent-soft)] ring-1 ring-[var(--accent-ring)]' : 'text-[var(--text-secondary)]')}>
                  {emojiToneHand(slot)}
                </button>))}
          <span className="min-w-0 flex-1 truncate text-right text-[11px] text-[var(--text-quaternary)]">{t('emoji.skin_tone_hint')}</span>
        </div>)}
      <div id="emoji-grid" role="listbox" aria-label={t('emoji.results')} onMouseLeave={() => setHovered(null)} className="max-h-[252px] min-h-[188px] overflow-y-auto px-2 pb-1">
        {groups.length === 0 && (<p className="px-1 py-10 text-center text-[12px] text-[var(--text-quaternary)]">{t('emoji.loading')}</p>)}
        {groups.length > 0 && tiles.length === 0 && (<div className="px-2 py-10 text-center">
              <p className="text-[12px] text-[var(--text-tertiary)]">{t('emoji.no_match')}</p>
              <p className="mt-1 text-[11px] text-[var(--text-quaternary)]">{t('emoji.no_match_hint')}</p>
            </div>)}
        {tiles.length > 0 && (<div className="grid grid-cols-8 gap-1">
              {tiles.map((tile, index) => {
                const label = emojiDisplayName(tile.entry, locale);
                return (<button key={`${tile.glyph}-${index}`} id={`${uid}-${index}`} type="button" role="option" aria-selected={index === active} aria-label={label || tile.glyph} title={label || undefined} tabIndex={-1} onMouseEnter={() => setHovered(tile)} onMouseDown={(event) => event.preventDefault()} onClick={() => insert(tile)} className={cn('flex aspect-square items-center justify-center rounded-[var(--r-sm)] text-[17px] leading-none transition-colors', index === active
                            ? 'bg-[var(--bg-hover)] ring-1 ring-[var(--accent-ring)]'
                            : 'hover:bg-[var(--bg-hover)]')}>
                      {tile.glyph}
                    </button>);
            })}
            </div>)}
      </div>
      <div className="flex min-w-0 items-center gap-2 border-t border-[var(--border-subtle)] px-2.5 py-2">
        <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center text-[22px] leading-none">{preview?.glyph}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-primary)]">{preview ? emojiDisplayName(preview.entry, locale) || preview.glyph : t('emoji.hint')}</span>
        {preview?.entry?.code && (<code className="shrink-0 rounded-[var(--r-sm)] bg-[var(--bg-sunken)] px-1.5 py-0.5 text-[11px] text-[var(--text-tertiary)]">:{preview.entry.code}:</code>)}
      </div>
    </div>);
}
