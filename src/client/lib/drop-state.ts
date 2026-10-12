import { useEffect, useState } from 'react';

/**
 * Drop-indicator state that cannot get stuck.
 *
 * A drag that ends outside the window, or one the user cancels with Escape, never fires `drop` on the
 * element that was highlighting itself, so a plain `useState` would leave the ring or the line painted
 * until the next drag. Every surface that shows a drop target needs the same five bail-outs, and a
 * surface that forgets one of them looks like a broken hover rather than a missing listener.
 */
export function useDropState<T>(idle: T) {
    const [state, setState] = useState(idle);
    useEffect(() => {
        if (state === idle)
            return;
        const reset = () => setState(idle);
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape')
                reset();
        };
        const onLeaveWindow = (event: DragEvent) => {
            if (event.target === document.documentElement && !event.relatedTarget)
                reset();
        };
        window.addEventListener('drop', reset, true);
        window.addEventListener('dragend', reset, true);
        window.addEventListener('blur', reset);
        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('dragleave', onLeaveWindow, true);
        return () => {
            window.removeEventListener('drop', reset, true);
            window.removeEventListener('dragend', reset, true);
            window.removeEventListener('blur', reset);
            window.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('dragleave', onLeaveWindow, true);
        };
    }, [state, idle]);
    return [state, setState] as const;
}
