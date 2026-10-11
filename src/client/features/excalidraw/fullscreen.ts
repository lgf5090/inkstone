export type FullscreenOutcome = 'entered' | 'exited' | 'unsupported' | 'denied';

export async function toggleElementFullscreen(el: HTMLElement | null | undefined): Promise<FullscreenOutcome> {
    if (typeof document === 'undefined' || !el) return 'unsupported';
    if (document.fullscreenElement) {
        if (typeof document.exitFullscreen !== 'function') return 'unsupported';
        try {
            await document.exitFullscreen();
            return 'exited';
        } catch {
            return 'denied';
        }
    }
    if (typeof el.requestFullscreen !== 'function') return 'unsupported';
    try {
        await el.requestFullscreen();
        return 'entered';
    } catch {
        return 'denied';
    }
}

export function lockBodyScroll(): () => void {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    let released = false;
    return () => {
        if (released) return;
        released = true;
        document.body.style.overflow = previous;
    };
}
