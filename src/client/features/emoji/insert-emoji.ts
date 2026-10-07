import { getActiveEditorView, insertText } from '../../editor/commands';
import { t } from '../../lib/i18n';
import { useUi } from '../../store/ui';

/**
 * Where a picked emoji goes: the editor on screen, and the clipboard when there is no editor to
 * write into (a note opened read-only, a phone in the preview tab). Silently dropping the pick is
 * the one answer that is never right.
 */
export function insertEmojiText(text: string): Promise<boolean> {
    const view = getActiveEditorView();
    if (view && view.dom.isConnected && !view.dom.closest('[inert]')) {
        insertText(text)(view);
        view.focus();
        return Promise.resolve(true);
    }
    return copyToClipboard(text);
}

async function copyToClipboard(text: string): Promise<boolean> {
    const ui = useUi.getState();
    try {
        await navigator.clipboard.writeText(text);
        ui.toast({ title: t('emoji.copied_to_clipboard'), description: text });
        return true;
    }
    catch {
        ui.toast({ title: t('emoji.copy_failed'), description: t('emoji.copy_failed_hint'), tone: 'danger' });
        return false;
    }
}
