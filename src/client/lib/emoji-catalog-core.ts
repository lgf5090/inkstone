export { ICON_MAX_CODE_UNITS, isUsableIconGlyph } from './emoji-glyph';
import { fuzzyFilter } from './fuzzy';
import type { MessageKey } from '@shared/locales/en-US';

export interface EmojiEntry {
    char: string;
    keys: string;
}

export interface EmojiCategory {
    id: string;
    labelKey: MessageKey;
    entries: EmojiEntry[];
}

export const ICON_SEARCH_LIMIT = 60;


export function searchEmojiIn(entries: readonly EmojiEntry[], query: string, limit = ICON_SEARCH_LIMIT): EmojiEntry[] {
    if (!query.trim())
        return [];
    return fuzzyFilter([...entries], query, (entry) => `${entry.char} ${entry.keys}`, limit).map((hit) => hit.item);
}


