import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutTemplate, Star } from 'lucide-react';
import type { NoteTemplate } from '@shared/types';
import { IconButton } from '../../components/primitives';
import { Menu, Tooltip, type MenuItem } from '../../components/overlay';
import { createNoteFromTemplate } from '../../lib/template-notes';
import { APP_SHORTCUTS } from '../../lib/shortcuts';
import { t } from '../../lib/i18n';
import { useSession } from '../../store/session';
import { useUi } from '../../store/ui';
import { useNoteTemplates } from '../../store/note-templates';

const FAVORITES_MENU_WIDTH = 220;

export function favoriteTemplateItems(templates: NoteTemplate[], folderId?: string, loading = false): MenuItem[] {
    const favorites = templates
        .filter((template) => template.isStarred)
        .sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || b.updatedAt - a.updatedAt);
    if (loading && !favorites.length) {
        return [{ id: 'loading', label: t('templates.favorites_loading'), disabled: true }];
    }
    if (!favorites.length) {
        return [
            { id: 'empty', label: t('templates.no_favorite_templates'), disabled: true },
            {
                id: 'open-library',
                label: t('templates.open_template_library'),
                icon: <LayoutTemplate size={13}/>,
                separatorBefore: true,
                onSelect: () => useUi.getState().openPanel('templates'),
            },
        ];
    }
    return favorites.map((template) => ({
        id: template.id,
        label: template.name,
        icon: <LayoutTemplate size={13}/>,
        onSelect: () => void createNoteFromTemplate(template, folderId ? { folderId } : {}),
    }));
}

export function TemplateQuickActions({ folderId, iconSize = 14, className }: {
    folderId?: string;
    iconSize?: number;
    className?: string;
}) {
    const owner = useSession((state) => state.user?.id ?? '');
    const templates = useNoteTemplates((state) => state.templates);
    const hydrate = useNoteTemplates((state) => state.hydrate);
    const hydrated = useNoteTemplates((state) => state.hydrated);
    const [favoritesOpen, setFavoritesOpen] = useState(false);
    const [armed, setArmed] = useState(false);
    const favoritesRef = useRef<HTMLButtonElement>(null);
    const arm = useCallback(() => setArmed(true), []);
    useEffect(() => {
        if (!owner)
            return;
        const idle = (window as unknown as {
            requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
        }).requestIdleCallback;
        const handle = idle
            ? idle(() => setArmed(true), { timeout: 4000 })
            : window.setTimeout(() => setArmed(true), 1500);
        return () => {
            const cancel = (window as unknown as { cancelIdleCallback?: (handle: number) => void }).cancelIdleCallback;
            if (cancel)
                cancel(handle as number);
            else
                window.clearTimeout(handle as number);
        };
    }, [owner]);
    useEffect(() => {
        if (!owner || !armed || hydrated)
            return;
        void hydrate(owner).catch((error: unknown) => {
            console.warn('[templates] the favorites menu could not read the library', error);
        });
    }, [owner, hydrate, armed, hydrated]);
    const items = useMemo(() => favoriteTemplateItems(templates, folderId, !hydrated), [templates, folderId, hydrated]);
    return (<>
        <Tooltip label={t('templates.new_note_from_template')} combo={APP_SHORTCUTS.templates} side="bottom">
            <IconButton label={t('templates.new_note_from_template')} size="sm" className={className} onPointerDown={arm} onFocus={arm} onClick={() => useUi.getState().openPanel('templates')}>
                <LayoutTemplate size={iconSize}/>
            </IconButton>
        </Tooltip>
        <Tooltip label={t('templates.new_note_from_favorites')} side="bottom">
            <IconButton ref={favoritesRef} label={t('templates.new_note_from_favorites')} size="sm" className={className} onPointerDown={arm} onPointerEnter={arm} onFocus={arm} onClick={() => setFavoritesOpen(true)}>
                <Star size={iconSize}/>
            </IconButton>
        </Tooltip>
        <Menu anchor={favoritesRef} open={favoritesOpen} onClose={() => setFavoritesOpen(false)} items={items} align="end" width={FAVORITES_MENU_WIDTH} label={t('templates.new_note_from_favorites')}/>
    </>);
}
