const collators = new Map<string, Intl.Collator>()

/** Cached Intl collator; constructing one per comparison dominates note-list sorting. */
export function numericCollator(locale: string): Intl.Collator {
    let collator = collators.get(locale);
    if (!collator) {
        collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
        collators.set(locale, collator);
    }
    return collator;
}
