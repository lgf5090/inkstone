/**
 * The browser may bundle several pointer samples into one event; `getCoalescedEvents` returns
 * them in the same order they arrived. Older engines expose no method (or an empty result), in
 * which case the event itself is the only sample.
 */
export function coalescedPointerEvents(event: PointerEvent): PointerEvent[] {
    const withCoalesced = event as PointerEvent & { getCoalescedEvents?: () => PointerEvent[] }
    if (typeof withCoalesced.getCoalescedEvents !== 'function') return [event]
    try {
        const samples = withCoalesced.getCoalescedEvents()
        return samples && samples.length > 0 ? samples : [event]
    } catch {
        return [event]
    }
}

/** The standards-based equivalent of an Apple Pencil side-button press in a browser. */
export function isPenBarrelPress(event: PointerEvent): boolean {
    return event.pointerType === 'pen' && (event.button === 2 || (event.buttons & 2) !== 0)
}

export function isMiddleButton(event: PointerEvent): boolean {
    return event.pointerType === 'mouse' && event.button === 1
}
