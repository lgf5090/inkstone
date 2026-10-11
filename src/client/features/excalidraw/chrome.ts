const DEFAULT_ATTEMPTS = 40
const DEFAULT_DELAY_MS = 50

/**
 * The engine's own footer owns the undo row, and the main-menu trigger ships in the top-left island,
 * so the app moves it down beside them. Doing it from a MutationObserver on the canvas subtree meant a
 * `querySelector` pass (including a `:has()` match) on *every* DOM change the engine makes while a
 * shape is being dragged or the viewport panned. The two islands render within a frame or two of mount
 * and never reorder themselves afterwards, so a short bounded poll replaces the observer outright.
 *
 * The poll stops the moment it has moved the trigger, so a surface that owns the footer pays one or two
 * ticks. The fence block inside a note does not: there the engine renders no `layer-ui__wrapper` at all
 * (measured on the real page - the block's canvas is 536x486 and its own trigger sits at 1047,227), so
 * polling there ran all forty ticks, roughly two hundred selector queries per mount, and could never
 * succeed. That call site is gone; this one stays because the whole-page editor does have the footer.
 *
 * Returns the cancel function; callers must run it on cleanup.
 */
export function reparentMainMenuIntoFooter(
    host: HTMLElement,
    attempts: number = DEFAULT_ATTEMPTS,
    delayMs: number = DEFAULT_DELAY_MS,
): () => void {
    let cancelled = false
    let timer: number | undefined
    let left = attempts

    const run = () => {
        if (cancelled) return
        const trigger = host.querySelector<HTMLElement>('.main-menu-trigger')
        const movable = trigger?.closest('.dropdown-menu-event-wrapper') ?? trigger
        const undoRow = host.querySelector<HTMLElement>('.undo-redo-buttons')
        const footerSection = host.querySelector<HTMLElement>('.layer-ui__wrapper__footer-left section')
        const target = undoRow ?? footerSection

        if (movable && target) {
            if (!target.contains(movable)) target.prepend(movable)
            return
        }
        if (--left <= 0) return
        timer = window.setTimeout(run, delayMs)
    }

    run()

    return () => {
        cancelled = true
        if (timer !== undefined) window.clearTimeout(timer)
    }
}
