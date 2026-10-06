import { CornerDownRight, EyeOff, FileText, Palette, Pencil, Pin, Search, SearchCheck, SearchX, Settings2, Trash2 } from 'lucide-react';
import { t } from '../../lib/i18n';
import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';
import type { MenuItem } from '../../components/overlay';
import type { Tag } from '@shared/types';
import { TagColorMenu } from './TagAppearanceMenus';
import { deleteTag, findTagPageIn, openTagPage, searchTag, setTagColor, setTagPinned } from './tagMutations';
import { tagNamesEqual } from '@shared/markdown-utils';

export interface TagMenuOptions {
    excluded?: boolean;
    onStartRename?: () => void;
    onCreateChild?: (parent: string) => void;
    onManage?: () => void;
}

const MISSING_TAG: Tag = { id: '', name: '', color: null, count: 0, createdAt: 0 };

/**
 * One tag menu, four entrances: the sidebar row, an inline `#tag` in the preview, a hashtag in the
 * editor, and a pill in the properties panel. A name that is not in the facet list yet (a tag typed
 * into a note that has not been saved) still gets the read-only half, so nothing here can be clicked
 * against a row that no longer exists.
 */
export function useTagMenuItems(name: string, options: TagMenuOptions = {}): MenuItem[] {
    const stored = useNotes((state) => state.tags.find((tag) => tagNamesEqual(tag.name, name)));
    const hasPage = useNotes((state) => findTagPageIn(state.notes, name) !== null);
    const excludedTags = useUi((state) => state.excludedTags);
    const toggleTagExclusion = useUi((state) => state.toggleTagExclusion);
    const tag = stored ?? { ...MISSING_TAG, name };
    const known = Boolean(stored);
    const excluded = options.excluded ?? excludedTags.some((item) => tagNamesEqual(item, name));
    const items: MenuItem[] = [];
    if (known) {
        items.push({ id: 'pin', label: tag.isPinned ? t('tags.unpin') : t('tags.pin'), icon: <Pin size={13}/>, disabled: !known, onSelect: () => void setTagPinned(tag, !tag.isPinned) });
    }
    items.push({ id: 'exclude', label: excluded ? t('tags.stop_excluding') : t('tags.exclude'), icon: <EyeOff size={13}/>, onSelect: () => toggleTagExclusion(name) });
    if (options.onStartRename && known) {
        items.push({ id: 'rename', label: t('tags.rename'), icon: <Pencil size={13}/>, disabled: !known, onSelect: options.onStartRename });
    }
    if (options.onCreateChild && known) {
        items.push({ id: 'child', label: t('tags.new_child'), icon: <CornerDownRight size={13}/>, disabled: !known, onSelect: () => options.onCreateChild?.(name) });
    }
    items.push({ id: 'page', label: hasPage ? t('tags.open_page') : t('tags.create_page'), icon: <FileText size={13}/>, onSelect: () => void openTagPage(tag) });
    items.push({ id: 'search', label: t('tags.search_new_value0', { value0: name }), icon: <Search size={13}/>, onSelect: () => searchTag(tag, 'new') });
    items.push({ id: 'search-require', label: t('tags.search_require_value0', { value0: name }), icon: <SearchCheck size={13}/>, onSelect: () => searchTag(tag, 'require') });
    items.push({ id: 'search-exclude', label: t('tags.search_exclude_value0', { value0: name }), icon: <SearchX size={13}/>, onSelect: () => searchTag(tag, 'exclude') });
    if (known) {
        items.push({
            id: 'color',
            label: t('tags.color'),
            icon: <Palette size={13}/>,
            submenu: ({ closeMenu }) => (<TagColorMenu color={tag.color} onSelectColor={(color) => {
                    void setTagColor(tag, color);
                    closeMenu();
                }} onManageTags={options.onManage ? () => {
                    closeMenu();
                    options.onManage?.();
                } : undefined}/>),
        });
    }
    if (options.onManage) {
        items.push({ id: 'manage', label: t('tags.manage'), icon: <Settings2 size={13}/>, onSelect: options.onManage });
    }
    if (known) {
        items.push({ id: 'delete', label: t('tags.delete'), icon: <Trash2 size={13}/>, tone: 'danger', separatorBefore: true, onSelect: () => void deleteTag(tag) });
    }
    return items;
}
