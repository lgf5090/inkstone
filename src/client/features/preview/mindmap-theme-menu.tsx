/**
 * The palette menu the mind map block's header button opens. It is a React overlay over
 * the prose for the same reason the hover card is: the block's markup is re-rendered
 * wholesale from the note, so the menu's own state has to live outside it. The prose
 * whitelist keeps form controls out, which is why the control is a button and the
 * options are a menu rather than a `<select>`.
 */
import { useEffect, useMemo } from 'react';
import { Menu, type MenuItem } from '../../components/overlay';
import { t } from '../../lib/i18n';
import {
    mindmapThemeButton,
    mindmapThemeLabel,
    mindmapThemeMenuPicks,
    pickMindmapTheme,
    setMindmapThemeMenuOpen,
    type MindmapThemeMenuState,
} from '../../lib/markdown/mindmap';

/** Wide enough for the longest palette name beside its check mark. */
const MENU_WIDTH_PX = 196;

export function MindmapThemeMenu({ state, onClose }: { state: MindmapThemeMenuState; onClose: () => void }) {
    const { node, choice } = state;
    // The menu hangs off the header's own control, not off the block: the block is the map,
    // hundreds of pixels tall, so anchoring to it would drop the menu below the drawing
    // area instead of under the button that was just pressed. A ref-shaped anchor is what
    // the menu positions against, and both elements come from the prose, so the object is
    // memoized rather than rebuilt per render.
    const anchor = useMemo(() => ({ current: mindmapThemeButton(node) ?? node }), [node]);

    // The menu is what says the button is expanded, and the markup it sits on is re-rendered
    // from the note, so the state is asserted here rather than left to the renderer.
    useEffect(() => {
        setMindmapThemeMenuOpen(node, true);
        return () => setMindmapThemeMenuOpen(node, false);
    }, [node]);

    const items: MenuItem[] = useMemo(() => mindmapThemeMenuPicks(choice).map((pick) => ({
        id: pick,
        label: mindmapThemeLabel(pick),
        checked: (choice.kind === 'app' ? 'auto' : choice.kind) === pick,
        onSelect: pick === 'custom'
            ? onClose
            : () => {
                pickMindmapTheme(node, pick);
                onClose();
            },
    })), [choice, node, onClose]);

    return <Menu anchor={anchor} open onClose={onClose} items={items} align="end" width={MENU_WIDTH_PX} label={t('preview.mindmap_theme')}/>;
}
