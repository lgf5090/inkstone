import { useSyncExternalStore } from 'react';
import type { MessageKey } from '@shared/locales/en-US';
import { fuzzyMatch } from './fuzzy';

export interface EmojiUnicodeEntry {
    code: string;
    char: string;
    name: string;
    keywords?: string;
    zh?: string;
    aliases?: string[];
    tones?: string[];
}

export interface EmojiUnicodeGroup {
    id: string;
    entries: EmojiUnicodeEntry[];
}

export interface EmojiHit {
    entry: EmojiUnicodeEntry;
    score: number;
}

const RAISED_HAND = 0x270b;

const FIRST_SKIN_MODIFIER = 0x1f3fb;

/** Slot 0 keeps the glyph as drawn; 1-5 are the Fitzpatrick light-to-dark modifiers. */
export const EMOJI_TONE_SLOTS = [0, 1, 2, 3, 4, 5];

export const EMOJI_TONE_LABEL_KEYS: MessageKey[] = [
    'emoji.tone.default',
    'emoji.tone.light',
    'emoji.tone.medium_light',
    'emoji.tone.medium',
    'emoji.tone.medium_dark',
    'emoji.tone.dark',
];

/** The open hand drawn in one tone slot — the control every tone picker shows for that slot. */
export function emojiToneHand(slot: number): string {
    if (slot <= 0)
        return String.fromCodePoint(RAISED_HAND);
    return String.fromCodePoint(RAISED_HAND, FIRST_SKIN_MODIFIER + Math.min(slot, EMOJI_TONE_SLOTS.length - 1) - 1);
}

export const EMOJI_SEARCH_LIMIT = 96;

/** Below this a hit is only the letters of a long name happening to fall in order. */
const MIN_SCORE = 60;

let groups: EmojiUnicodeGroup[] = [];

let entries: EmojiUnicodeEntry[] = [];

let codes = new Map<string, string>();

let byGlyph = new Map<string, EmojiUnicodeEntry>();

let pending: Promise<void> | null = null;

let loaded = false;

let version = 0;

const listeners = new Set<() => void>();

function notify(): void {
    version++;
    for (const listener of [...listeners])
        listener();
}

function index(groupList: EmojiUnicodeGroup[]): void {
    groups = groupList;
    entries = groupList.flatMap((group) => group.entries);
    const next = new Map<string, string>();
    const glyphs = new Map<string, EmojiUnicodeEntry>();
    for (const entry of entries) {
        for (const code of [entry.code, ...(entry.aliases ?? [])]) {
            for (const key of [code, code.replace(/-/g, '_')]) {
                if (!next.has(key))
                    next.set(key, entry.char);
            }
        }
        for (const glyph of [entry.char, ...(entry.tones ?? [])]) {
            if (!glyphs.has(glyph))
                glyphs.set(glyph, entry);
        }
    }
    codes = next;
    byGlyph = glyphs;
}

/** Start the download if it has not started. Resolves once the set can be searched. */
export function loadEmojiUnicode(): Promise<void> {
    // One attempt per session, and a failed one still counts as attempted: a document that speaks in
    // codes asks on every parse, and re-firing a request that just failed would turn that into a storm.
    pending ??= import('./emoji-unicode-data').then((module) => {
        index(module.EMOJI_UNICODE_GROUPS);
        loaded = true;
        notify();
    }, () => undefined);
    return pending;
}

/** Ask for the set without waiting: the answer given now is the one without it. */
export function requestEmojiUnicode(): void {
    void loadEmojiUnicode();
}

export function emojiUnicodeIsLoaded(): boolean {
    return loaded;
}

/** Re-render hook for React surfaces that memoise on the set being present. */
export function useEmojiUnicodeVersion(): number {
    return useSyncExternalStore(subscribe, () => version, () => 0);
}

/** The same signal for a surface that is not React, such as a CodeMirror view plugin. */
export function subscribeEmojiUnicode(listener: () => void): () => void {
    return subscribe(listener);
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function emojiUnicodeGroups(): EmojiUnicodeGroup[] {
    return groups;
}

export function emojiUnicodeEntries(): EmojiUnicodeEntry[] {
    return entries;
}

export function emojiWithTone(entry: EmojiUnicodeEntry, tone: number): string {
    if (tone <= 0 || tone >= EMOJI_TONE_SLOTS.length || !entry.tones)
        return entry.char;
    return entry.tones[tone - 1] ?? entry.char;
}

/** The character a `:code:` stands for, or undefined when the set is not here or the word is not one. */
export function emojiCharForCode(code: string): string | undefined {
    return codes.get(code.toLowerCase());
}

/** Which entry a drawn glyph belongs to, tone included, so a recent row can name itself. */
export function emojiEntryForChar(glyph: string): EmojiUnicodeEntry | undefined {
    return byGlyph.get(glyph);
}

function codeScore(code: string, query: string, base: number): number {
    if (code === query)
        return base + 2000;
    if (code.startsWith(query))
        return base + 1000;
    if (code.includes(query))
        return base + 300;
    return 0;
}

function fieldScore(field: string | undefined, query: string, base: number): number {
    if (!field)
        return 0;
    const match = fuzzyMatch(field, query);
    return match ? match.score + base : 0;
}

function scoreEntry(entry: EmojiUnicodeEntry, query: string): number {
    if (entry.char === query)
        return 12000;
    let best = codeScore(entry.code, query, 8000);
    for (const alias of entry.aliases ?? [])
        best = Math.max(best, codeScore(alias, query, 7000));
    best = Math.max(best, fieldScore(entry.name, query, 400));
    best = Math.max(best, fieldScore(entry.keywords, query, 0));
    best = Math.max(best, fieldScore(entry.zh, query, 300));
    return best;
}

export function searchEmojiUnicode(query: string, limit = EMOJI_SEARCH_LIMIT): EmojiHit[] {
    const needle = query.trim().toLowerCase();
    if (!needle || !loaded)
        return [];
    const words = needle.split(/\s+/).filter(Boolean);
    const hits: EmojiHit[] = [];
    for (const entry of entries) {
        const score = scoreWords(entry, words, needle);
        if (score >= MIN_SCORE)
            hits.push({ entry, score });
    }
    hits.sort((left, right) => right.score - left.score);
    return hits.slice(0, limit);
}

/**
 * A phrase either names the emoji on its own (`smiling eyes` is a substring of one name) or every
 * word has to be true of it, which is what `red heart` and `happy face` mean. A phrase where one
 * word fits and another does not is nobody's answer, so it scores nothing rather than half a list.
 */
function scoreWords(entry: EmojiUnicodeEntry, words: string[], needle: string): number {
    const whole = scoreEntry(entry, needle);
    if (words.length < 2)
        return whole;
    if (whole >= MIN_SCORE)
        return whole;
    let total = 0;
    for (const word of words) {
        const score = scoreEntry(entry, word);
        if (score < MIN_SCORE)
            return 0;
        total += score;
    }
    return Math.floor(total / words.length);
}
