import { t } from '../../lib/i18n';
import { decodeDataValue } from '../../lib/markdown/data-attr';
import { Menu } from '../../components/overlay';
import { useTagMenuItems, type TagMenuOptions } from './useTagMenuItems';

export interface TagMenuRequest {
    name: string;
    x: number;
    y: number;
}

/**
 * The tag a pointer landed on: markdown hands us `#tag` spans as DOM, so every surface that wants
 * the menu reads the encoded name off the closest one. Returns null when the pointer is not on a
 * tag, which leaves the browser's own context menu alone.
 */
export function tagMenuRequestFrom(target: EventTarget | null, x: number, y: number): TagMenuRequest | null {
  const element = target instanceof HTMLElement ? target.closest<HTMLElement>('[data-tag]') : null;
  const raw = element?.dataset.tag;
  if (!raw)
    return null;
  return { name: decodeDataValue(raw), x, y };
}

/**
 * The tag menu at a pointer position, for surfaces whose rows are not React components of their own
 * (the preview renders markdown, so `#tag` spans arrive as DOM). One request at a time; the caller
 * clears it through onClose.
 */
export function TagContextMenuAt({ request, options, onClose }: {
    request: TagMenuRequest | null;
    options?: TagMenuOptions;
    onClose: () => void;
}) {
    const items = useTagMenuItems(request?.name ?? '', options);
    if (!request)
        return null;
    return <Menu anchor={{ x: request.x, y: request.y }} open onClose={onClose} items={items} label={t('navigation.tag')}/>;
}
