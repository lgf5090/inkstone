import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Modal, useClickOutside, useEscape } from '../../components/overlay';
import { placePanel, usePanelPlacement, type PanelPlacement } from '../../components/popover-placement';
import { getVisibleViewport } from '../../lib/viewport';
import { t } from '../../lib/i18n';
import { pushRecentEmoji } from '../../lib/emoji-prefs';
import { useSession } from '../../store/session';
import { closeEmojiPicker, useEmojiPicker } from '../../store/emoji-picker';
import { EmojiPicker } from './EmojiPicker';
import type { SkinTone } from '@shared/types';
import { insertEmojiText } from './insert-emoji';

const PANEL_WIDTH = 344;
const PANEL_HEIGHT = 380;

export function EmojiPickerHost() {
    const { open, anchor } = useEmojiPicker();
    const editor = useSession((state) => state.settings.editor);
    const update = useSession((state) => state.updateSettings);
    const onInsert = useCallback((glyph: string, code: string | null) => {
        pushRecentEmoji(glyph);
        const text = editor.emojiInsertFormat === 'shortcode' && code ? `:${code}:` : glyph;
        closeEmojiPicker();
        // The centred sheet hands focus back to whatever had it when it opened, so the write has to
        // land after that cleanup or the editor would lose the cursor it was just given.
        requestAnimationFrame(() => {
            void insertEmojiText(text);
        });
    }, [editor.emojiInsertFormat]);
    const onTone = useCallback((tone: SkinTone) => {
        void update({ editor: { emojiSkinTone: tone } });
    }, [update]);
    if (!open)
        return null;
    const body = (<EmojiPicker tone={editor.emojiSkinTone} onTone={onTone} onInsert={onInsert}/>);
    if (anchor?.isConnected)
        return (<AnchoredPanel anchor={anchor} onClose={closeEmojiPicker}>
          {body}
        </AnchoredPanel>);
    return (<Modal open onClose={closeEmojiPicker} title={t('emoji.picker')} width={PANEL_WIDTH + 8} bodyClassName="p-0">
      {body}
    </Modal>);
}

function AnchoredPanel({ anchor, onClose, children }: {
    anchor: HTMLElement;
    onClose: () => void;
    children: ReactNode;
}) {
    const panelRef = useRef<HTMLDivElement>(null);
    const anchorRef = useRef<HTMLElement | null>(anchor);
    anchorRef.current = anchor;
    const size = useMemo(() => ({ width: Math.min(PANEL_WIDTH, window.innerWidth - 16), height: PANEL_HEIGHT }), []);
    const [placement, setPlacement] = useState<PanelPlacement | null>(() => {
        const rect = anchor.getBoundingClientRect();
        return rect.width || rect.height ? placePanel({ anchor: rect, size, viewport: getVisibleViewport(), align: 'end' }) : null;
    });
    const apply = useCallback((next: PanelPlacement) => setPlacement(next), []);
    usePanelPlacement(true, { anchor: anchorRef, size, align: 'end', apply });
    useEscape(true, onClose);
    useClickOutside([panelRef, anchorRef], true, onClose);
    useEffect(() => {
        const remeasure = () => {
            const rect = anchorRef.current?.getBoundingClientRect();
            if (rect)
                apply(placePanel({ anchor: rect, size, viewport: getVisibleViewport(), align: 'end' }));
        };
        window.addEventListener('resize', remeasure);
        window.addEventListener('scroll', remeasure, true);
        return () => {
            window.removeEventListener('resize', remeasure);
            window.removeEventListener('scroll', remeasure, true);
        };
    }, [apply, size]);
    const { style, className } = panelGeometry(placement, size.width);
    return createPortal(<div ref={panelRef} role="dialog" aria-label={t('emoji.picker')} tabIndex={-1} style={style} className={className}>
      {children}
    </div>, document.body);
}

function panelGeometry(placement: PanelPlacement | null, width: number): { style: React.CSSProperties; className: string } {
    const base = 'fixed z-[255] overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] shadow-[var(--shadow-pop)]';
    if (!placement)
        return { style: { width, top: 0, left: -9999 }, className: `${base} invisible` };
    return {
        style: { width, top: placement.top, left: placement.left, transformOrigin: placement.origin },
        className: `${base} anim-pop`,
    };
}
