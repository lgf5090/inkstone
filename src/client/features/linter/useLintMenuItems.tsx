import { Eye, EyeOff, WandSparkles } from 'lucide-react';
import type { MenuItem } from '../../components/overlay';
import { folderIsIgnored, noteIsIgnored, toggleFolderIgnored, toggleNoteIgnored } from '../../lib/linter/ignore-state';
import { t } from '../../lib/i18n';
import { useSession } from '../../store/session';

/**
 * The linter's two row menu entries, for a note or for a folder.
 *
 * A row is not the note the editor holds, so both entries name the row they were built for and act on
 * that id. Formatting is the one thing that must not be imported here: the rule library is loaded only
 * when the reader actually asks for it, which is what keeps the note list light.
 */
function lintNote(noteId: string): void {
    void import('../../lib/linter/drive').then((drive) => drive.lintAndReport(noteId, false));
}

export function useLintNoteMenuItems(noteId: string): MenuItem[] {
    const linter = useSession((s) => s.settings.linter);
    if (!linter.enabled)
        return [];
    const ignoring = noteIsIgnored(linter, noteId);
    return [
        { id: 'lint-note', label: t('linter.command.lint_this_note'), icon: <WandSparkles size={13}/>, separatorBefore: true, onSelect: () => lintNote(noteId) },
        {
            id: 'ignore-note',
            label: t(ignoring ? 'linter.command.unignore_note' : 'linter.command.ignore_note'),
            icon: ignoring ? <Eye size={13}/> : <EyeOff size={13}/>,
            onSelect: () => toggleNoteIgnored(noteId),
        },
    ];
}

export function useLintFolderMenuItems(folderId: string): MenuItem[] {
    const linter = useSession((s) => s.settings.linter);
    if (!linter.enabled)
        return [];
    const ignoring = folderIsIgnored(linter, folderId);
    return [
        {
            id: 'lint-folder',
            label: t('linter.command.lint_this_folder'),
            icon: <WandSparkles size={13}/>,
            separatorBefore: true,
            onSelect: () => {
                void import('../../lib/linter/drive').then((drive) => drive.lintFolderById(folderId));
            },
        },
        {
            id: 'ignore-folder',
            label: t(ignoring ? 'linter.command.unignore_folder' : 'linter.command.ignore_folder'),
            icon: ignoring ? <Eye size={13}/> : <EyeOff size={13}/>,
            onSelect: () => toggleFolderIgnored(folderId),
        },
    ];
}
