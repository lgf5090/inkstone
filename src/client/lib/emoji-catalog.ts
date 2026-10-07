export * from './emoji-catalog-core';

let pending: Promise<typeof import('./emoji-catalog-data')> | null = null;

export function loadEmojiCatalog(): Promise<typeof import('./emoji-catalog-data')> {
    pending ??= import('./emoji-catalog-data').catch(() => null).then((module) => module ?? import('./emoji-catalog-data'));
    return pending;
}
