import { create } from 'zustand';

interface EmojiPickerState {
    open: boolean;
    /** The control the panel hangs from. Null asks for the centred sheet instead. */
    anchor: HTMLElement | null;
    show: (anchor: HTMLElement | null) => void;
    hide: () => void;
}

export const useEmojiPicker = create<EmojiPickerState>((set) => ({
    open: false,
    anchor: null,
    show: (anchor) => set({ open: true, anchor }),
    hide: () => set({ open: false, anchor: null }),
}));

export function openEmojiPicker(anchor: HTMLElement | null = null): void {
    useEmojiPicker.getState().show(anchor);
}

export function closeEmojiPicker(): void {
    useEmojiPicker.getState().hide();
}

export function isEmojiPickerOpen(): boolean {
    return useEmojiPicker.getState().open;
}
