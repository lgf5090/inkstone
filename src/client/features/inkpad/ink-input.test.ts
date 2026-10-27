import { describe, expect, it } from 'vitest'
import { coalescedPointerEvents, isMiddleButton, isPenBarrelPress } from './ink-input'

function pointer(overrides: Partial<PointerEvent> = {}): PointerEvent {
    return { pointerType: 'pen', button: 0, buttons: 0, ...overrides } as PointerEvent
}

describe('coalescedPointerEvents', () => {
    it('returns the coalesced samples when the browser provides them', () => {
        const samples = [pointer(), pointer()]
        const event = pointer({ getCoalescedEvents: () => samples } as Partial<PointerEvent>)
        expect(coalescedPointerEvents(event)).toBe(samples)
    })

    it('falls back to the event when the list is empty or throws', () => {
        const empty = pointer({ getCoalescedEvents: () => [] } as Partial<PointerEvent>)
        expect(coalescedPointerEvents(empty)).toEqual([empty])
        const throws = pointer({ getCoalescedEvents: () => { throw new Error('nope') } } as Partial<PointerEvent>)
        expect(coalescedPointerEvents(throws)).toEqual([throws])
        const missing = pointer()
        expect(coalescedPointerEvents(missing)).toEqual([missing])
    })
})

describe('pointer kinds', () => {
    it('recognises a pen barrel press', () => {
        expect(isPenBarrelPress(pointer({ button: 2 }))).toBe(true)
        expect(isPenBarrelPress(pointer({ buttons: 2 }))).toBe(true)
        expect(isPenBarrelPress(pointer({ pointerType: 'mouse', button: 2 }))).toBe(false)
    })

    it('recognises a middle mouse button', () => {
        expect(isMiddleButton(pointer({ pointerType: 'mouse', button: 1 }))).toBe(true)
        expect(isMiddleButton(pointer({ pointerType: 'pen', button: 1 }))).toBe(false)
    })
})
