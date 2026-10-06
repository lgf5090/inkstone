import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject, type SetStateAction, } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight, X } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button, IconButton, Kbd } from './primitives';
import { FIELD_BASE } from './form';
import { t } from "../lib/i18n";
import { getVisibleViewport } from '../lib/viewport';


const escStack: (() => void)[] = [];
/**
 * A field that gives Escape its own meaning — cancelling a rename should not be the gesture that
 * closes the panel holding it. Such a field marks itself and the overlay layers stand aside.
 */
function ownsEscape(target: EventTarget | null): boolean {
    return target instanceof Element && Boolean(target.closest('[data-owns-escape]'));
}
export function useEscape(active: boolean, onEscape: () => void): void {
    const callbackRef = useRef(onEscape);
    callbackRef.current = onEscape;
    useEffect(() => {
        if (!active)
            return;
        const handler = () => callbackRef.current();
        escStack.push(handler);
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.isComposing || event.repeat || event.defaultPrevented)
                return;
            if (ownsEscape(event.target))
                return;
            const top = escStack[escStack.length - 1];
            if (top !== handler)
                return;
            event.preventDefault();
            event.stopPropagation();
            handler();
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
            window.removeEventListener('keydown', onKeyDown, true);
            const index = escStack.indexOf(handler);
            if (index >= 0)
                escStack.splice(index, 1);
        };
    }, [active]);
}
export function useClickOutside(refs: RefObject<HTMLElement | null>[], active: boolean, onOutside: () => void): void {
    const refsRef = useRef(refs);
    const callbackRef = useRef(onOutside);
    refsRef.current = refs;
    callbackRef.current = onOutside;
    useEffect(() => {
        if (!active)
            return;
        const handler = (event: MouseEvent) => {
            const target = event.target as Node;
            if (refsRef.current.some((ref) => ref.current?.contains(target)))
                return;
            callbackRef.current();
        };

        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [active]);
}
let scrollLockCount = 0;
let unlockedBodyOverflow = '';
export function useLockScroll(active: boolean): void {
    useLayoutEffect(() => {
        if (!active)
            return;
        if (scrollLockCount === 0)
            unlockedBodyOverflow = document.body.style.overflow;
        scrollLockCount++;
        document.body.style.overflow = 'hidden';
        return () => {
            scrollLockCount = Math.max(0, scrollLockCount - 1);
            if (scrollLockCount === 0)
                document.body.style.overflow = unlockedBodyOverflow;
        };
    }, [active]);
}
const dialogStack: symbol[] = [];
const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"]):not([disabled])',
].join(',');

export function useDialogFocus<T extends HTMLElement>(active: boolean, panelRef: RefObject<T | null>, initialFocusRef?: RefObject<HTMLElement | null>): void {
    useEffect(() => {
        if (!active)
            return;
        const token = Symbol('dialog');
        const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        dialogStack.push(token);
        const panel = panelRef.current;
        const requestedInitial = initialFocusRef?.current ??
            panel?.querySelector<HTMLElement>('[data-autofocus]');
        const initial = requestedInitial && isAvailableFocusTarget(requestedInitial)
            ? requestedInitial
            : [...(panel?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])]
                .find(isAvailableFocusTarget);
        (initial ?? panel)?.focus({ preventScroll: true });
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Tab' || dialogStack[dialogStack.length - 1] !== token)
                return;
            const currentPanel = panelRef.current;
            if (!currentPanel)
                return;
            const focusable = [...currentPanel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
                .filter(isAvailableFocusTarget);
            if (focusable.length === 0) {
                event.preventDefault();
                currentPanel.focus({ preventScroll: true });
                return;
            }
            const current = document.activeElement as HTMLElement | null;
            if (current?.closest('[role="menu"]'))
                return;
            const index = current ? focusable.indexOf(current) : -1;
            if (event.shiftKey && index <= 0) {
                event.preventDefault();
                focusable[focusable.length - 1]?.focus({ preventScroll: true });
            }
            else if (!event.shiftKey && (index < 0 || index === focusable.length - 1)) {
                event.preventDefault();
                focusable[0]?.focus({ preventScroll: true });
            }
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => {
            document.removeEventListener('keydown', onKeyDown, true);
            const index = dialogStack.indexOf(token);
            if (index >= 0)
                dialogStack.splice(index, 1);
            if (previousFocus?.isConnected)
                previousFocus.focus({ preventScroll: true });
        };
    }, [active, initialFocusRef, panelRef]);
}

function isAvailableFocusTarget(element: HTMLElement): boolean {
    return !element.matches(':disabled') && !element.closest('[hidden], [aria-hidden="true"]');
}

export function Modal({ open, onClose, title, description, children, footer, width = 560, className, bodyClassName, variant = 'dialog', ariaLabel, }: {
    open: boolean;
    onClose: () => void;
    title?: ReactNode;
    description?: ReactNode;
    children: ReactNode;
    footer?: ReactNode;
    width?: number;
    className?: string;
    bodyClassName?: string;
    /** `fullscreen` fills the viewport and hands the body to a single surface (e.g. a mind map). */
    variant?: 'dialog' | 'fullscreen';
    /** Accessible name for a surface that renders its own heading instead of using `title`. */
    ariaLabel?: string;
}) {
    const fullscreen = variant === 'fullscreen';
    const panelRef = useRef<HTMLDivElement>(null);
    const titleId = useId();
    const descriptionId = useId();
    useEscape(open, onClose);
    useLockScroll(open);
    useDialogFocus(open, panelRef);
    if (!open)
        return null;
    return createPortal(


    <div className={cn('app-viewport-fixed fixed z-[250] flex items-end justify-center overflow-hidden md:items-start md:overflow-y-auto md:p-8', fullscreen && 'md:overflow-hidden md:p-0')}>
      <div className="anim-fade absolute inset-0 bg-[var(--scrim)]" onClick={onClose} aria-hidden="true"/>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={title ? titleId : undefined} aria-describedby={description ? descriptionId : undefined} aria-label={title ? undefined : (ariaLabel ?? t("overlay.dialog"))} tabIndex={-1} className={cn('anim-pop relative flex w-full flex-col outline-none', fullscreen
        ? 'h-[100dvh] max-h-none border-0 md:h-[100dvh] md:my-0 md:rounded-none'
        : 'max-h-[calc(var(--app-viewport-height,100dvh)-env(safe-area-inset-top))] rounded-t-[var(--r-2xl)] border border-b-0 border-[var(--border-default)] bg-[var(--bg-overlay)] shadow-[var(--shadow-modal)] md:my-auto md:rounded-[var(--r-2xl)] md:border-b', className)} style={fullscreen ? undefined : { maxWidth: width }}>
        {(title || description) && (<div className="flex shrink-0 items-start justify-between gap-4 px-4 pt-4 pb-3 md:px-5">
            <div className="min-w-0">
              {title && (<h2 id={titleId} className="text-[15px] font-semibold tracking-[-0.012em] text-[var(--text-primary)]">
                  {title}
                </h2>)}
              {description && (<p id={descriptionId} className="mt-1 text-[12.5px] leading-relaxed text-[var(--text-tertiary)]">
                  {description}
                </p>)}
            </div>
            <Tooltip label={t("common.close")} combo="escape" side="left">
              <IconButton label={t("common.close")} size="sm" onClick={onClose} className="-mr-1 -mt-0.5">
                <X size={15}/>
              </IconButton>
            </Tooltip>
          </div>)}
        <div className={cn('min-h-0 overflow-y-auto px-4 pb-4 md:px-5 md:pb-5', fullscreen && 'flex min-h-0 flex-1 flex-col overflow-hidden p-0 md:p-0', bodyClassName)}>{children}</div>
        {footer && (<div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--border-subtle)] px-4 pt-3 pb-[calc(12px+env(safe-area-inset-bottom))] md:px-5 md:py-3">
            {footer}
          </div>)}
      </div>
    </div>, document.body);
}

interface ConfirmOptions {
    title: string;
    description?: ReactNode;
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: 'default' | 'danger';
}
interface ConfirmRequest {
    options: ConfirmOptions;
    resolve: (value: boolean) => void;
}
let enqueueConfirm: ((request: ConfirmRequest) => void) | null = null;

export function confirm(options: ConfirmOptions): Promise<boolean> {
    // With no host mounted there is no dialog to show, so the only answer we may give is the
    // cancelling one. Falling back to `window.confirm` would reintroduce a native prompt.
    if (!enqueueConfirm)
        return Promise.resolve(false);
    return new Promise((resolve) => {
        enqueueConfirm?.({ options, resolve });
    });
}
export function ConfirmHost() {
    const [current, setCurrent] = useState<ConfirmRequest | null>(null);
    const currentRef = useRef<ConfirmRequest | null>(null);
    const queueRef = useRef<ConfirmRequest[]>([]);
    useEffect(() => {
        enqueueConfirm = (request) => {
            if (currentRef.current) {
                queueRef.current.push(request);
                return;
            }
            currentRef.current = request;
            setCurrent(request);
        };
        return () => {
            enqueueConfirm = null;
            currentRef.current?.resolve(false);
            for (const request of queueRef.current)
                request.resolve(false);
            currentRef.current = null;
            queueRef.current = [];
        };
    }, []);
    const finish = useCallback((request: ConfirmRequest | null, value: boolean) => {
        if (!request || currentRef.current !== request)
            return;
        request.resolve(value);
        const next = queueRef.current.shift() ?? null;
        currentRef.current = next;
        setCurrent(next);
    }, []);
    const options = current?.options;
    const danger = options?.tone === 'danger';
    return (<Modal open={Boolean(current)} onClose={() => finish(current, false)} title={options?.title} description={options?.description} width={440} footer={<>
          <Button variant="ghost" onClick={() => finish(current, false)} data-autofocus={danger ? true : undefined}>
            {options?.cancelLabel ?? t("common.cancel")}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={() => finish(current, true)} data-autofocus={danger ? undefined : true}>
            {options?.confirmLabel ?? t("overlay.confirm")}
          </Button>
        </>}>
      <div />
    </Modal>);
}

export interface PromptOptions {
    title: string;
    description?: ReactNode;
    placeholder?: string;
    defaultValue?: string;
    confirmLabel?: string;
    cancelLabel?: string;
}
interface PromptRequest {
    options: PromptOptions;
    resolve: (value: string | null) => void;
}
let enqueuePrompt: ((request: PromptRequest) => void) | null = null;

export function prompt(options: PromptOptions): Promise<string | null> {
    // Same contract as `confirm`: with no host mounted there is no dialog to show, and falling back
    // to `window.prompt` would reintroduce a native prompt.
    if (!enqueuePrompt)
        return Promise.resolve(null);
    return new Promise((resolve) => {
        enqueuePrompt?.({ options, resolve });
    });
}

export function PromptHost() {
    const [current, setCurrent] = useState<PromptRequest | null>(null);
    const currentRef = useRef<PromptRequest | null>(null);
    const queueRef = useRef<PromptRequest[]>([]);
    useEffect(() => {
        enqueuePrompt = (request) => {
            if (currentRef.current) {
                queueRef.current.push(request);
                return;
            }
            currentRef.current = request;
            setCurrent(request);
        };
        return () => {
            enqueuePrompt = null;
            currentRef.current?.resolve(null);
            for (const request of queueRef.current)
                request.resolve(null);
            currentRef.current = null;
            queueRef.current = [];
        };
    }, []);
    const finish = useCallback((request: PromptRequest | null, value: string | null) => {
        if (!request || currentRef.current !== request)
            return;
        request.resolve(value);
        const next = queueRef.current.shift() ?? null;
        currentRef.current = next;
        setCurrent(next);
    }, []);
    // Keyed on the request, so a second prompt in the queue cannot inherit the text typed for the
    // first one — the dialog's own state is what holds it.
    return current ? <PromptDialog request={current} finish={finish}/> : null;
}

function PromptDialog({ request, finish }: { request: PromptRequest; finish: (request: PromptRequest | null, value: string | null) => void }) {
    const [value, setValue] = useState(request.options.defaultValue ?? '');
    useEffect(() => {
        setValue(request.options.defaultValue ?? '');
    }, [request]);
    const submit = value.trim();
    return (<Modal open onClose={() => finish(request, null)} title={request.options.title} description={request.options.description} width={420} footer={<>
          <Button variant="ghost" onClick={() => finish(request, null)}>
            {request.options.cancelLabel ?? t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={!submit} onClick={() => finish(request, submit)}>
            {request.options.confirmLabel ?? t("overlay.confirm")}
          </Button>
        </>}>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (submit)
            finish(request, submit);
    }} className="mt-[var(--sp-2)]">
        <input data-autofocus type="text" className={`${FIELD_BASE} h-9`} value={value} placeholder={request.options.placeholder} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => {
        // Enter has to be cancelled before it commits: committing opens the next dialog in the
        // queue, and the browser runs this keydown's default action after the handler returns.
        if (event.key === 'Enter') {
            event.preventDefault();
            if (submit)
                finish(request, submit);
            return;
        }
        if (event.key === 'Escape')
            finish(request, null);
    }}/>
      </form>
    </Modal>);
}

export interface MenuSubmenuContext {
    closeMenu: () => void;
}
export interface MenuItem {
    id: string;
    label: string;
    icon?: ReactNode;
    combo?: string;
    tone?: 'default' | 'danger';
    disabled?: boolean;
    checked?: boolean;
    onSelect?: () => void;
    separatorBefore?: boolean;
    submenu?: ReactNode | ((context: MenuSubmenuContext) => ReactNode);
}
interface OpenSubmenu {
    id: string;
    rect: DOMRect;
    focus: boolean;
}
const SUBMENU_VIEWPORT_MARGIN = 8;
const SUBMENU_GAP = 2;
export function Menu({ anchor, open, onClose, items, align = 'start', width = 208, zIndex = 260, label = t("overlay.menu"), panelId, }: {
    anchor: RefObject<HTMLElement | null> | {
        x: number;
        y: number;
    };
    open: boolean;
    onClose: () => void;
    items: MenuItem[];
    align?: 'start' | 'end';
    width?: number;
    zIndex?: number;
    label?: string;
    /** The id a caller already points its trigger's `aria-controls` at. */
    panelId?: string;
}) {
    const menuRef = useRef<HTMLDivElement>(null);
    const submenuRef = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState<{
        top: number;
        left: number;
        origin: string;
    }>({
        top: 0,
        left: 0,
        origin: 'top left',
    });
    const [cursor, setCursor] = useState(0);
    const [submenu, setSubmenu] = useState<OpenSubmenu | null>(null);
    const [submenuPosition, setSubmenuPosition] = useState<{
        top: number;
        left: number;
    } | null>(null);
    const anchorRef = 'current' in anchor ? anchor : null;
    const point = 'current' in anchor ? null : anchor;
    const menuWidth = Math.min(width, Math.max(0, innerWidth - 16));
    const submenuIndex = submenu ? items.findIndex((item) => item.id === submenu.id) : -1;
    const submenuItem = submenuIndex >= 0 ? items[submenuIndex] : undefined;
    useLayoutEffect(() => {
        if (!open)
            return;
        const margin = 8;
        const itemHeight = innerWidth < 768 ? 40 : 30;
        const height = Math.min(items.length * itemHeight + 12, 420);
        let top: number;
        let left: number;
        if (point) {
            top = point.y;
            left = point.x;
        }
        else {
            const rect = anchorRef?.current?.getBoundingClientRect();
            if (!rect)
                return;
            top = rect.bottom + 5;
            left = align === 'end' ? rect.right - menuWidth : rect.left;
        }
        const viewport = getVisibleViewport();
        const flipUp = top + height > viewport.bottom - margin;
        if (flipUp)
            top = Math.max(viewport.top + margin, (point ? point.y : (anchorRef?.current?.getBoundingClientRect().top ?? top)) - height - 5);
        left = Math.min(Math.max(viewport.left + margin, left), viewport.right - menuWidth - margin);
        setPosition({ top, left, origin: `${flipUp ? 'bottom' : 'top'} ${align === 'end' ? 'right' : 'left'}` });
        setCursor(items.findIndex((i) => !i.disabled));
    }, [open, items, align, menuWidth, anchorRef, point]);
    useEffect(() => {
        if (!open)
            setSubmenu(null);
    }, [open]);
    useLayoutEffect(() => {
        if (!submenu) {
            setSubmenuPosition(null);
            return;
        }
        const panel = submenuRef.current;
        if (!panel)
            return;
        const box = panel.getBoundingClientRect();
        const viewport = getVisibleViewport();
        const menuLeft = menuRef.current?.getBoundingClientRect().left ?? submenu.rect.left;
        let left = submenu.rect.right + SUBMENU_GAP;
        if (left + box.width > viewport.right - SUBMENU_VIEWPORT_MARGIN)
            left = menuLeft - box.width - SUBMENU_GAP;
        if (left < viewport.left + SUBMENU_VIEWPORT_MARGIN)
            left = Math.max(viewport.left + SUBMENU_VIEWPORT_MARGIN, viewport.right - SUBMENU_VIEWPORT_MARGIN - box.width);
        const maxTop = Math.max(viewport.top + SUBMENU_VIEWPORT_MARGIN, viewport.bottom - SUBMENU_VIEWPORT_MARGIN - box.height);
        setSubmenuPosition({
            top: Math.min(Math.max(viewport.top + SUBMENU_VIEWPORT_MARGIN, submenu.rect.top - 4), maxTop),
            left,
        });
    }, [submenu]);
    useEffect(() => {
        if (submenu?.focus)
            submenuRef.current?.focus({ preventScroll: true });
    }, [submenu]);
    useEscape(open, () => {
        if (submenu) {
            setSubmenu(null);
            return;
        }
        onClose();
    });
    useClickOutside(anchorRef ? [menuRef, submenuRef, anchorRef] : [menuRef, submenuRef], open, onClose);
    useEffect(() => {
        if (!open)
            return;
        const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        return () => {
            if (previousFocus?.isConnected)
                previousFocus.focus({ preventScroll: true });
        };
    }, [open]);
    useEffect(() => {
        if (!open)
            return;
        if (cursor < 0) {
            menuRef.current?.focus({ preventScroll: true });
            return;
        }
        if (submenu?.focus)
            return;
        menuRef.current
            ?.querySelector<HTMLElement>(`[data-menu-index="${cursor}"]`)
            ?.focus({ preventScroll: true });
    }, [open, cursor, submenu]);
    const openSubmenuFor = (index: number, focus: boolean) => {
        const row = menuRef.current?.querySelector<HTMLElement>(`[data-menu-index="${index}"]`);
        const item = items[index];
        if (!row || !item?.submenu)
            return;
        setSubmenu((current) => current?.id === item.id && current.focus === focus
            ? current
            : { id: item.id, rect: row.getBoundingClientRect(), focus });
    };
    const moveCursor = (step: number) => {
        let next = cursor;
        for (let i = 0; i < items.length; i++) {
            next = (next + step + items.length) % items.length;
            if (!items[next]?.disabled)
                break;
        }
        setCursor(next);
        if (items[next]?.submenu)
            openSubmenuFor(next, submenu !== null);
        else
            setSubmenu(null);
    };
    useEffect(() => {
        if (!open)
            return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)
                return;
            const target = event.target instanceof HTMLElement ? event.target : null;
            const insideSubmenu = Boolean(target && submenuRef.current?.contains(target));
            if (insideSubmenu) {
                const editable = target?.closest('input, textarea, [contenteditable="true"]');
                if (editable || event.key !== 'ArrowLeft')
                    return;
                event.preventDefault();
                setSubmenu(null);
                menuRef.current
                    ?.querySelector<HTMLElement>(`[data-menu-index="${cursor}"]`)
                    ?.focus({ preventScroll: true });
                return;
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                moveCursor(event.key === 'ArrowDown' ? 1 : -1);
            }
            else if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault();
                const indexes = items
                    .map((item, index) => item.disabled ? -1 : index)
                    .filter((index) => index >= 0);
                const next = event.key === 'Home' ? (indexes[0] ?? -1) : (indexes[indexes.length - 1] ?? -1);
                setCursor(next);
                if (items[next]?.submenu)
                    openSubmenuFor(next, submenu !== null);
                else
                    setSubmenu(null);
            }
            else if (event.key === 'ArrowRight') {
                const item = items[cursor];
                if (!item?.submenu)
                    return;
                event.preventDefault();
                openSubmenuFor(cursor, true);
            }
            else if (event.key === 'ArrowLeft') {
                if (!submenu)
                    return;
                event.preventDefault();
                setSubmenu(null);
            }
            else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                const item = items[cursor];
                if (!item || item.disabled)
                    return;
                if (item.submenu) {
                    openSubmenuFor(cursor, true);
                    return;
                }
                item.onSelect?.();
                onClose();
            }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [open, items, cursor, submenu, onClose]);
    if (!open)
        return null;
    return (<>{createPortal(<div ref={menuRef} {...(panelId ? { id: panelId } : {})} role="menu" aria-label={label} tabIndex={-1} onScroll={() => setSubmenu(null)} className="anim-pop fixed max-h-[420px] overflow-y-auto rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-1 shadow-[var(--shadow-pop)] outline-none" style={{ top: position.top, left: position.left, width: menuWidth, transformOrigin: position.origin, zIndex }}>
      {items.map((item, index) => (<div key={item.id}>
          {item.separatorBefore && <div role="separator" className="my-1 h-px bg-[var(--border-subtle)]"/>}
          <button type="button" role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={item.checked === undefined ? undefined : item.checked} aria-haspopup={item.submenu ? 'menu' : undefined} aria-expanded={item.submenu ? submenu?.id === item.id : undefined} tabIndex={index === cursor ? 0 : -1} data-menu-index={index} disabled={item.disabled} onMouseEnter={() => {
                if (item.disabled)
                    return;
                setCursor(index);
                if (item.submenu)
                    openSubmenuFor(index, false);
                else
                    setSubmenu(null);
            }} onClick={() => {
                if (item.submenu) {
                    openSubmenuFor(index, true);
                    return;
                }
                item.onSelect?.();
                onClose();
            }} className={cn('flex h-10 w-full items-center gap-2.5 rounded-[var(--r-sm)] px-2 text-left text-[12.5px] md:h-[30px]', 'transition-colors duration-[80ms] disabled:pointer-events-none disabled:opacity-40', index === cursor ? 'bg-[var(--bg-hover)]' : '', item.tone === 'danger'
                ? 'text-[var(--danger)]'
                : index === cursor
                    ? 'text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)]')}>
            {item.icon && (<span className="flex size-4 shrink-0 items-center justify-center opacity-85">
                {item.icon}
              </span>)}
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.checked && <Check size={13} aria-hidden="true" className="shrink-0 text-[var(--accent)]"/>}
            {item.submenu && <ChevronRight size={13} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]"/>}
            {item.combo && <Kbd combo={item.combo}/>}
          </button>
        </div>))}
    </div>, document.body)}
      {submenuItem?.submenu && createPortal(<div ref={submenuRef} role="group" aria-label={submenuItem.label} tabIndex={-1} className="anim-pop fixed outline-none" style={{
        top: submenuPosition?.top ?? 0,
        left: submenuPosition?.left ?? 0,
        visibility: submenuPosition ? 'visible' : 'hidden',
        zIndex: zIndex + 5,
      }}>
          {typeof submenuItem.submenu === 'function'
            ? submenuItem.submenu({ closeMenu: onClose })
            : submenuItem.submenu}
        </div>, document.body)}
    </>);
}
export function useContextMenu() {
    const [point, setPoint] = useState<{
        x: number;
        y: number;
    } | null>(null);
    return {
        point,
        close: () => setPoint(null),
        onContextMenu: (event: React.MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            setPoint({ x: event.clientX, y: event.clientY });
        },
    };
}
export function Tooltip({ label, combo, children, side = 'bottom', delay = 420, }: {
    label: ReactNode;
    combo?: string;
    children: ReactNode;
    side?: 'top' | 'bottom' | 'left' | 'right';
    delay?: number;
}) {
    const holderRef = useRef<HTMLSpanElement>(null);
    const tooltipRef = useRef<HTMLDivElement>(null);
    const timerRef = useRef<number>(0);
    const [rect, setRect] = useState<DOMRect | null>(null);
    const [position, setPosition] = useState<TooltipPosition | null>(null);
    const measureAnchor = useCallback(() => {
        const anchor = holderRef.current?.firstElementChild;
        if (!(anchor instanceof Element))
            return null;
        const next = anchor.getBoundingClientRect();
        return next.width || next.height ? next : null;
    }, []);
    const show = () => {
        window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => {
            const next = measureAnchor();
            if (next) {
                setPosition(null);
                setRect(next);
            }
        }, delay);
    };
    const hide = () => {
        window.clearTimeout(timerRef.current);
        setPosition(null);
        setRect(null);
    };
    useEffect(() => () => window.clearTimeout(timerRef.current), []);
    useLayoutEffect(() => {
        const tooltip = tooltipRef.current;
        if (!rect || !tooltip)
            return;
        setPosition(placeTooltip(rect, tooltip.getBoundingClientRect(), side));
    }, [combo, label, rect, side]);
    useEffect(() => {
        if (!rect)
            return;
        const update = () => {
            const next = measureAnchor();
            if (next)
                setRect(next);
            else {
                setPosition(null);
                setRect(null);
            }
        };
        window.addEventListener('resize', update);
        window.addEventListener('scroll', update, true);
        return () => {
            window.removeEventListener('resize', update);
            window.removeEventListener('scroll', update, true);
        };
    }, [measureAnchor, rect]);
    const style: React.CSSProperties = position
        ? { top: position.top, left: position.left, visibility: 'visible' }
        : { top: 0, left: 0, visibility: 'hidden' };
    return (<>
      <span ref={holderRef} onMouseEnter={() => {
            if (typeof window.matchMedia !== 'function' || window.matchMedia('(hover: hover) and (pointer: fine)').matches)
                show();
        }} onMouseLeave={hide} onFocus={(event) => {
            if ((event.target as HTMLElement).matches(':focus-visible'))
                show();
        }} onBlur={hide} className="contents">
        {children}
      </span>
      {rect &&
            createPortal(<div ref={tooltipRef} role="tooltip" data-side={position?.side} className="anim-fade pointer-events-none fixed z-[500] flex max-w-[calc(100vw-16px)] items-center gap-1.5 rounded-[var(--r-sm)] border border-[var(--border-default)] bg-[var(--bg-overlay)] px-2 py-1 text-[11.5px] whitespace-nowrap text-[var(--text-secondary)] shadow-[var(--shadow-pop)]" style={style}>
            {label}
            {combo && <Kbd combo={combo}/>}
          </div>, document.body)}
    </>);
}
type TooltipSide = 'top' | 'bottom' | 'left' | 'right';
interface TooltipPosition {
    top: number;
    left: number;
    side: TooltipSide;
}
function placeTooltip(anchor: DOMRect, tooltip: DOMRect, preferred: TooltipSide): TooltipPosition {
    const gap = 7;
    const padding = 8;
    const viewport = getVisibleViewport();
    const viewportLeft = viewport.left;
    const viewportTop = viewport.top;
    const viewportRight = viewport.right;
    const viewportBottom = viewport.bottom;
    let side = preferred;
    if (preferred === 'bottom' && anchor.bottom + gap + tooltip.height > viewportBottom - padding &&
        (anchor.top - gap - tooltip.height >= viewportTop + padding || anchor.top - viewportTop > viewportBottom - anchor.bottom)) {
        side = 'top';
    }
    else if (preferred === 'top' && anchor.top - gap - tooltip.height < viewportTop + padding &&
        (anchor.bottom + gap + tooltip.height <= viewportBottom - padding || viewportBottom - anchor.bottom > anchor.top - viewportTop)) {
        side = 'bottom';
    }
    else if (preferred === 'right' && anchor.right + gap + tooltip.width > viewportRight - padding &&
        (anchor.left - gap - tooltip.width >= viewportLeft + padding || anchor.left - viewportLeft > viewportRight - anchor.right)) {
        side = 'left';
    }
    else if (preferred === 'left' && anchor.left - gap - tooltip.width < viewportLeft + padding &&
        (anchor.right + gap + tooltip.width <= viewportRight - padding || viewportRight - anchor.right > anchor.left - viewportLeft)) {
        side = 'right';
    }
    const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
    if (side === 'top' || side === 'bottom') {
        return {
            side,
            top: side === 'bottom' ? anchor.bottom + gap : anchor.top - gap - tooltip.height,
            left: clamp(anchor.left + anchor.width / 2 - tooltip.width / 2, viewportLeft + padding, viewportRight - tooltip.width - padding),
        };
    }
    return {
        side,
        top: clamp(anchor.top + anchor.height / 2 - tooltip.height / 2, viewportTop + padding, viewportBottom - tooltip.height - padding),
        left: side === 'right' ? anchor.right + gap : anchor.left - gap - tooltip.width,
    };
}
export function Drawer({ open, onClose, side = 'right', width = 380, children, title, zIndex = 190, ariaLabel, }: {
    open: boolean;
    onClose: () => void;
    side?: 'left' | 'right';
    width?: number;
    children: ReactNode;
    title?: ReactNode;
    zIndex?: number;
    /** Names the panel when it has no visible title; without one it would be the generic side panel. */
    ariaLabel?: string;
}) {
    const panelRef = useRef<HTMLElement>(null);
    const titleId = useId();
    useEscape(open, onClose);
    useLockScroll(open);
    useDialogFocus(open, panelRef);
    if (!open)
        return null;
    return createPortal(<div className="app-viewport-fixed fixed" style={{ zIndex }}>
      <div className="anim-fade absolute inset-0 bg-[var(--scrim)]" onClick={onClose} aria-hidden="true"/>
      <aside ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={title ? titleId : undefined} aria-label={title ? undefined : ariaLabel ?? t("overlay.side_panel")} tabIndex={-1} data-surface="drawer" className={cn('absolute top-0 bottom-0 flex flex-col border-[var(--border-default)] bg-[var(--bg-surface)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-[var(--shadow-modal)] outline-none md:py-0', side === 'right' ? 'right-0 border-l' : 'left-0 border-r')} style={{
            width: Math.min(width, window.innerWidth < 768 ? window.innerWidth : window.innerWidth - 32),
            animation: `ink-slide-in-${side} var(--dur-slow) var(--ease-out) both`,
        }}>
        {title && (<header className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-3">
            <span id={titleId} className="text-[13px] font-semibold">{title}</span>
            <Tooltip label={t("common.close")} combo="escape" side="left">
              <IconButton label={t("common.close")} size="sm" onClick={onClose}>
                <X size={15}/>
              </IconButton>
            </Tooltip>
          </header>)}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </aside>
    </div>, document.body);
}

/** The gap a nested panel leaves beside the row that opened it. */
const NESTED_GAP = 2;
/** What a panel keeps clear of the viewport's edges. */
const NESTED_MARGIN = 8;
/** A row that opens a panel steps into it on these keys, rather than only opening it. */
const STEP_IN_KEYS = ['Enter', ' ', 'ArrowRight'];
/** The keys that move the focus along one list, and the ends they jump to. */
const STEP_KEYS: Record<string, 1 | -1 | 'first' | 'last'> = {
    ArrowDown: 1,
    ArrowUp: -1,
    Home: 'first',
    End: 'last',
};

interface OpenRow {
    id: string;
    focus: boolean;
}

/**
 * A submenu written as data rather than as markup, so a caller that already has a `MenuItem[]` —
 * the board's overflow menu, its batch bar — hands the same list to `Menu` at any depth.
 */
export function submenuFor(items: MenuItem[], width = 180) {
    return ({ closeMenu }: { closeMenu: () => void }) => (<SubmenuList items={items} closeMenu={closeMenu} width={width}/>);
}

/**
 * The content of a submenu — and of the panel a row inside it opens: one component renders both, so
 * a menu nests as deep as its items do.
 *
 * A nested panel is placed beside its row but stays inside this list's own DOM subtree.
 * `position: fixed` is what gets it clear of the list's scroll box; being a descendant is what keeps
 * the `Menu` that owns this submenu from reading a press inside it as a press outside — that
 * mousedown lands before the row's own click, so a portaled panel would dismiss the menu with the
 * row's action never run.
 */
export function SubmenuList({ items, closeMenu, width = 180, label = t('overlay.submenu'), }: {
    items: MenuItem[];
    closeMenu: () => void;
    width?: number;
    /** The panel's accessible name; a nested panel is named after the row that opened it. */
    label?: string;
}) {
    const [openRow, setOpenRow] = useState<OpenRow | null>(null);
    const listRef = useRef<HTMLDivElement>(null);
    return (<div ref={listRef} role="menu" aria-label={label} style={{ width }} onScroll={() => setOpenRow(null)} onClick={(event) => event.stopPropagation()} className="max-h-[380px] overflow-y-auto rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-1 shadow-[var(--shadow-pop)] outline-none">
      {items.map((item) => (<SubmenuRow key={item.id} item={item} openRow={openRow} setOpenRow={setOpenRow} closeMenu={closeMenu} listRef={listRef}/>))}
    </div>);
}

/** The rows of one list in DOM order — never those of a panel nested inside it. */
function rowsOf(list: HTMLElement | null): HTMLButtonElement[] {
    if (!list)
        return [];
    const rows: HTMLButtonElement[] = [];
    for (const child of list.children) {
        const row = child.querySelector<HTMLButtonElement>('[data-submenu-row]');
        // A panel's own rows are one level deeper: they belong to the panel, not to this list.
        if (row && row.parentElement === child)
            rows.push(row);
    }
    return rows;
}

/**
 * Where a key takes the focus inside one list: the neighbouring enabled row, wrapping at the ends,
 * or the first or last of them.
 */
function stepFocus(list: HTMLElement | null, from: HTMLElement, step: 1 | -1 | 'first' | 'last'): void {
    const rows = rowsOf(list).filter((row) => !row.disabled);
    if (rows.length === 0)
        return;
    const index = rows.indexOf(from as HTMLButtonElement);
    if (step === 'first' || (step === 1 && index < 0)) {
        rows[0]?.focus({ preventScroll: true });
        return;
    }
    if (step === 'last' || (step === -1 && index < 0)) {
        rows[rows.length - 1]?.focus({ preventScroll: true });
        return;
    }
    rows[(index + step + rows.length) % rows.length]?.focus({ preventScroll: true });
}

/** What the keys do on one row: step into a panel, move along the list, or step back out of it. */
function rowKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, row: {
    item: MenuItem;
    list: HTMLElement | null;
    openPanel: (focus: boolean) => void;
    leavePanel: (() => void) | null;
}): void {
    const { item, list, openPanel, leavePanel } = row;
    if (item.submenu && STEP_IN_KEYS.includes(event.key)) {
        event.preventDefault();
        openPanel(true);
        return;
    }
    const step = STEP_KEYS[event.key];
    if (step) {
        event.preventDefault();
        stepFocus(list, event.currentTarget, step);
        return;
    }
    if (event.key === 'ArrowLeft' && leavePanel) {
        event.preventDefault();
        leavePanel();
    }
}

/** Closes a row's panel and hands the focus back to the row that opened it. */
function closeRowPanel(list: HTMLElement | null, id: string, setOpenRow: Dispatch<SetStateAction<OpenRow | null>>): void {
    setOpenRow(null);
    list?.querySelector<HTMLElement>(`[data-submenu-row="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
}

function rowElementOf(list: HTMLElement | null, id: string): HTMLElement | null {
    return list?.querySelector<HTMLElement>(`[data-submenu-row="${CSS.escape(id)}"]`) ?? null;
}

/**
 * Where a panel goes: beside the row that opened it, flipped to the other side and clamped when the
 * near edge of the viewport is closer than the panel is wide.
 */
function panelPosition(rowElement: HTMLElement, panel: HTMLElement): { top: number, left: number } {
    const rect = rowElement.getBoundingClientRect();
    const viewport = getVisibleViewport();
    let left = rect.right - NESTED_GAP;
    if (left + panel.offsetWidth > viewport.right - NESTED_MARGIN)
        left = Math.max(viewport.left + NESTED_MARGIN, rect.left - panel.offsetWidth + NESTED_GAP);
    let top = rect.top - NESTED_GAP * 2;
    if (top + panel.offsetHeight > viewport.bottom - NESTED_MARGIN)
        top = Math.max(viewport.top + NESTED_MARGIN, viewport.bottom - panel.offsetHeight - NESTED_MARGIN);
    const origin = containingBlockOrigin(panel);
    return { top: top - origin.y, left: left - origin.x };
}

/**
 * Where a `fixed` box inside `element` is placed from: the viewport, unless an ancestor establishes
 * a containing block of its own — and the menu's own pop-in animation does. `anim-pop` fills
 * forwards, so the transform it settles on is the identity matrix rather than `none`, which still
 * counts; a panel that read the row's box as viewport coordinates was then drawn a whole submenu
 * down and to the right of it, off screen.
 *
 * A blurred ancestor would join this list, but the blur budget guard keeps that property out of the
 * app entirely, so there is nothing here to test for.
 */
function containingBlockOrigin(element: HTMLElement): { x: number, y: number } {
    for (let node = element.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        const isContainingBlock = style.transform !== 'none' || style.perspective !== 'none' || style.filter !== 'none' || style.willChange.includes('transform');
        if (!isContainingBlock)
            continue;
        const rect = node.getBoundingClientRect();
        // The block such a box is placed in is the ancestor's padding box, which starts inside its border.
        return { x: rect.left + node.clientLeft, y: rect.top + node.clientTop };
    }
    return { x: 0, y: 0 };
}

/** The way out of the panel a list sits in, told to the rows rather than walked off the DOM. */
const ClosePanelContext = createContext<(() => void) | null>(null);

function SubmenuRow({ item, openRow, setOpenRow, closeMenu, listRef }: {
    item: MenuItem;
    openRow: OpenRow | null;
    setOpenRow: Dispatch<SetStateAction<OpenRow | null>>;
    closeMenu: () => void;
    listRef: RefObject<HTMLDivElement | null>;
}) {
    const open = openRow?.id === item.id;
    const closePanel = useContext(ClosePanelContext);
    const panelId = useId();
    return (<div>
      {item.separatorBefore && <div role="separator" className="my-1 h-px bg-[var(--border-subtle)]"/>}
      <button type="button" role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={item.checked === undefined ? undefined : item.checked} aria-haspopup={item.submenu ? 'menu' : undefined} aria-expanded={item.submenu ? open : undefined} {...(open && item.submenu ? { 'aria-controls': panelId } : {})} data-submenu-row={item.id} disabled={item.disabled} onMouseEnter={() => setOpenRow(item.submenu ? { id: item.id, focus: false } : null)} onKeyDown={(event) => rowKeyDown(event, {
        item,
        list: listRef.current,
        openPanel: (focus) => setOpenRow(item.submenu ? { id: item.id, focus } : null),
        leavePanel: closePanel,
      })} onClick={() => {
        if (item.submenu) {
            setOpenRow({ id: item.id, focus: false });
            return;
        }
        item.onSelect?.();
        closeMenu();
      }} className={cn('flex h-[30px] w-full items-center gap-2.5 rounded-[var(--r-sm)] px-2 text-left text-[12.5px] transition-colors duration-[80ms] disabled:pointer-events-none disabled:opacity-40', 'hover:bg-[var(--bg-hover)]', item.tone === 'danger' ? 'text-[var(--danger)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}>
        {item.icon && <span className="flex size-4 shrink-0 items-center justify-center opacity-85">{item.icon}</span>}
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {item.checked && <Check size={13} className="shrink-0 text-[var(--accent)]"/>}
        {item.submenu && <ChevronRight size={13} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]"/>}
      </button>
      {open && item.submenu && (<NestedPanel id={panelId} listRef={listRef} row={openRow!} label={item.label} onClose={() => closeRowPanel(listRef.current, item.id, setOpenRow)}>
          {typeof item.submenu === 'function' ? item.submenu({ closeMenu }) : item.submenu}
        </NestedPanel>)}
    </div>);
}

/**
 * One level further in. It is a DOM child of the list it belongs to (see `SubmenuList`), so its box
 * is read from `fixed` coordinates taken off the row's own — shifted back into whatever block
 * `fixed` really resolves against — and its content is whatever the row's `submenu` renders, a
 * `SubmenuList` of its own when the items nest again.
 */
function NestedPanel({ id, listRef, row, label, children, onClose }: {
    id: string;
    listRef: RefObject<HTMLDivElement | null>;
    row: OpenRow;
    label: string;
    children: ReactNode;
    onClose: () => void;
}) {
    const panelRef = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState<{ top: number, left: number } | null>(null);
    // useEscape runs the top of its stack and nothing else, so the panel takes Escape before the
    // menu that owns it does and the levels close one at a time.
    useEscape(true, onClose);

    const measure = useCallback(() => {
        const rowElement = rowElementOf(listRef.current, row.id);
        const panel = panelRef.current;
        if (!rowElement || !panel)
            return;
        setPosition(panelPosition(rowElement, panel));
    }, [listRef, row.id]);

    useLayoutEffect(() => {
        measure();
    }, [measure]);

    // Re-measured while open: the panel hangs off its row's box, so anything that moves that box —
    // the window resizing, the page scrolling under it — would otherwise leave it behind.
    useEffect(() => {
        window.addEventListener('resize', measure);
        window.addEventListener('scroll', measure, true);
        return () => {
            window.removeEventListener('resize', measure);
            window.removeEventListener('scroll', measure, true);
        };
    }, [measure]);

    // Only a keyboard opening steps in: the pointer is already where it wants to be, and taking the
    // focus out of the list under it would be a surprise.
    useEffect(() => {
        if (!row.focus)
            return;
        panelRef.current?.querySelector<HTMLElement>('button:not([disabled]), input, [href]')?.focus({ preventScroll: true });
    }, [row.focus, row.id]);

    return (<div ref={panelRef} id={id} role="menu" aria-label={label} style={{ top: position?.top ?? 0, left: position?.left ?? 0 }} className={cn('anim-pop fixed outline-none', !position && 'invisible')} onClick={(event) => event.stopPropagation()}>
      <ClosePanelContext.Provider value={onClose}>{children}</ClosePanelContext.Provider>
    </div>);
}
