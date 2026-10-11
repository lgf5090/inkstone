import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type RefObject } from 'react';
import { Crosshair, Download, Expand, ImageDown, Keyboard, Minimize, Plus, Shrink, X } from 'lucide-react';
import { IconButton } from '../../components/primitives';
import { Modal, Tooltip, useClickOutside } from '../../components/overlay';
import { t } from '../../lib/i18n';
import type { BlockActionContext } from './block-overlay';

type Tool = 'fit' | 'center' | 'zoom-in' | 'zoom-out' | 'export-svg' | 'export-png' | 'fullscreen';

const SHORTCUT_KEYS = [
    'preview.json_shortcut_navigate',
    'preview.json_shortcut_collapse',
    'preview.json_shortcut_edit',
    'preview.json_shortcut_move',
    'preview.json_shortcut_delete',
    'preview.json_shortcut_zoom',
] as const;

interface JsonViewMount {
    mountJsonMapInto(block: HTMLElement, host: HTMLElement, ctx: BlockActionContext): void
    runJsonBlockTool(action: string, block: HTMLElement, ctx: BlockActionContext, host?: HTMLElement): void
}

/**
 * The lazy module, held in a ref rather than imported.
 *
 * The overlay is only ever opened from a block that already drew a map, so the chunk is warm by the time
 * this mounts — but a static import here would put the document model and the layout engine back on the
 * start-up path of every note, which is the whole reason the views are fetched on demand.
 */
function useJsonViewModule(): JsonViewMount | null {
    const [module, setModule] = useState<JsonViewMount | null>(null);
    useEffect(() => {
        let alive = true;
        import('./json-view-mount').then((loaded) => {
            if (alive)
                setModule(loaded as unknown as JsonViewMount);
        }).catch(() => {
            // The inline block is still on screen and still works; the overlay simply has nothing to show.
            console.warn('[inkstone] JSON view module failed to load');
        });
        return () => {
            alive = false;
        };
    }, []);
    return module;
}

function JsonShortcutCard({ open, onClose, anchor }: {
    open: boolean
    onClose: () => void
    anchor: RefObject<HTMLButtonElement | null>
}) {
    const panelRef = useRef<HTMLElement>(null);
    useClickOutside([panelRef, anchor], open, onClose);
    if (!open)
        return null;
    return (
      <section ref={panelRef} className="json-shortcuts" aria-label={t('preview.json_shortcuts')}>
        <ul>{SHORTCUT_KEYS.map(key => <li key={key}>{t(key)}</li>)}</ul>
      </section>
    );
}

function ToolButton({ label, combo, onClick, children }: {
    label: string
    combo?: string
    onClick: () => void
    children: React.ReactNode
}) {
    return (
      <Tooltip label={combo ? `${label} · ${combo}` : label}>
        <IconButton label={label} size="sm" onClick={onClick}>{children}</IconButton>
      </Tooltip>
    );
}

/**
 * The JSON mind map at the size of the window.
 *
 * It draws into its own host rather than re-parenting the block's, because the preview replaces the
 * block wholesale on every commit — a moved element would be left behind in markup that is no longer on
 * screen. What the two share is the parsed document and the fold state, so a branch folded here is
 * folded there the moment the overlay closes.
 */
export function JsonFullscreen({ block, context, onClose }: {
    block: HTMLElement
    context: () => BlockActionContext
    onClose: () => void
}) {
    const module = useJsonViewModule();
    const hostRef = useRef<HTMLDivElement>(null);
    const shortcutButtonRef = useRef<HTMLButtonElement>(null);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const [, redraw] = useReducer((count: number) => count + 1, 0);
    const tool = useCallback((action: Tool) => {
        const host = hostRef.current;
        if (module && host)
            module.runJsonBlockTool(action, block, context(), host);
        if (action === 'fit' || action === 'center' || action === 'zoom-in' || action === 'zoom-out')
            redraw();
    }, [block, context, module, redraw]);

    useEffect(() => {
        const host = hostRef.current;
        if (!module || !host)
            return;
        module.mountJsonMapInto(block, host, context());
    }, [block, context, module]);

    useEffect(() => {
        const host = hostRef.current;
        if (!host)
            return;
        const onOpenInTree = () => onClose();
        host.addEventListener('jsonmapopen', onOpenInTree);
        return () => host.removeEventListener('jsonmapopen', onOpenInTree);
    }, [onClose]);

    const closeShortcuts = useCallback(() => setShortcutsOpen(false), []);
    const handleClose = useCallback(() => {
        if (shortcutsOpen) {
            closeShortcuts();
            return;
        }
        onClose();
    }, [closeShortcuts, onClose, shortcutsOpen]);

    const header = useMemo(() => (
      <header className="json-fullscreen-head">
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-semibold tracking-[-0.012em] text-[var(--text-primary)]">{t('preview.json')}</h2>
          <p className="text-[12px] text-[var(--text-secondary)]">{t('preview.json_view_map')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ToolButton label={t('preview.json_fit')} onClick={() => tool('fit')}>
            <Expand size={15}/>
          </ToolButton>
          <ToolButton label={t('preview.json_center')} onClick={() => tool('center')}>
            <Crosshair size={15}/>
          </ToolButton>
          <ToolButton label={t('preview.json_zoom_out')} onClick={() => tool('zoom-out')}>
            <Shrink size={15}/>
          </ToolButton>
          <ToolButton label={t('preview.json_zoom_in')} onClick={() => tool('zoom-in')}>
            <Plus size={15}/>
          </ToolButton>
          <ToolButton label={t('preview.json_export_svg')} onClick={() => tool('export-svg')}>
            <Download size={15}/>
          </ToolButton>
          <ToolButton label={t('preview.json_export_png')} onClick={() => tool('export-png')}>
            <ImageDown size={15}/>
          </ToolButton>
          <Tooltip label={t('preview.json_shortcuts')}>
            <IconButton ref={shortcutButtonRef} label={t('preview.json_shortcuts')} size="sm" active={shortcutsOpen} onClick={() => setShortcutsOpen(open => !open)}>
              <Keyboard size={15}/>
            </IconButton>
          </Tooltip>
          <ToolButton label={t('preview.json_exit_fullscreen')} combo="escape" onClick={onClose}>
            <Minimize size={15}/>
          </ToolButton>
        </div>
      </header>
    ), [onClose, shortcutsOpen, tool]);

    return (
      <Modal open onClose={handleClose} variant="fullscreen" ariaLabel={t('preview.json_view_map')} className="json-fullscreen" bodyClassName="json-fullscreen-body">
        {header}
        <div className="json-fullscreen-stage">
          <div ref={hostRef} className="jm-stage json-view"/>
          <JsonShortcutCard open={shortcutsOpen} onClose={closeShortcuts} anchor={shortcutButtonRef}/>
          {!module && (
            <p className="json-view-note">
              {t('preview.json_loading')}
              <X size={12}/>
            </p>
          )}
        </div>
      </Modal>
    );
}
