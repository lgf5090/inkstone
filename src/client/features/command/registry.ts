/**
 * The application commands, as data.
 *
 * The palette used to build this list inside its own component, which made the commands unreachable
 * from anywhere else — a QuickAdd macro could not say "do what the palette entry called X does"
 * without opening the palette. Every entry here reads what it needs from the stores when it is
 * called, so the palette, a hotkey and an automation step all run the same one implementation.
 */
import type { ComponentType } from 'react'
import {
  Archive, Columns2, Download, Eye, EyeOff, FolderPlus, ImagePlus, IndentDecrease, IndentIncrease, Keyboard, LayoutTemplate, Link2, ListTree, MoveDown, MoveUp, Palette, Pencil, Plus, Presentation, ScanSearch, Settings, Share2, Smile, SquarePen, Star, Sun, Moon, Trash2, Waypoints, ChevronsDownUp, ChevronsUpDown, Search, Zap,
} from 'lucide-react'
import type { MessageKey } from '@shared/locales/en-US'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { APP_SHORTCUTS } from '../../lib/shortcuts'
import { editorCombo } from '../../editor/shortcuts'
import type { Command } from '@codemirror/view'
import { getActiveEditorView } from '../../editor/commands'
import {
  outlinerFoldItem, outlinerIndentItem, outlinerMoveItemDown, outlinerMoveItemUp, outlinerOutdentItem,
  outlinerUnfoldAll, outlinerUnfoldItem,
} from '../../editor/outliner'
import { openLinkAtCursor } from '../links/use-link-editor'
import { pasteAsLinkFromClipboard } from '../../editor/paste-link'
import { requestPropertyDecoration } from '../../lib/property-commands'
import { buildOutlineTree, stringifyOutline } from '../preview/outline-tree'
import { outlineHeadingsFor } from '../preview/outline-registry'
import { openEmojiPicker } from '../../store/emoji-picker'
import { openOmnisearch } from '../omnisearch/store'
import { createContextualNote, useNotes } from '../../store/notes'
import { useQuickAdd } from '../../store/quickadd'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'

export interface AppCommand {
  id: string
  kind: 'command'
  label: string
  detail?: string
  group: string
  icon: ComponentType<{ size?: number }>
  combo?: string
  run: () => void
}

function runOnList(command: Command): () => void {
  return () => {
    const view = getActiveEditorView()
    if (!view || !command(view)) useUi.getState().toast({ title: t('command.no_list_to_edit'), tone: 'warning' })
  }
}

/** The commands as they apply right now: labels follow the locale, and a few need an open note. */
export function appCommands(): AppCommand[] {
  const ui = useUi.getState()
  const notes = useNotes.getState()
  const session = useSession.getState()
  const quickAdd = useQuickAdd.getState()
  const activeNoteId = ui.activeNoteId
  const activeNote = activeNoteId ? notes.notes[activeNoteId] ?? null : null
  const openPanel = ui.openPanel
  const openView = ui.openView
  const toast = ui.toast
  const sendOutlineCommand = ui.sendOutlineCommand
  const toggleLocalGraph = ui.toggleLocalGraph
  const createFolder = notes.createFolder
  const deleteNote = notes.deleteNote
  const patchNote = notes.patchNote
  const updateSettings = session.updateSettings
  const quickAddChoices = quickAdd.choices
  const quickAddOn = quickAdd.settings.enabled
  const isDark = document.documentElement.dataset.theme === 'dark';
  return [
    {
        id: 'cmd-new',
        kind: 'command',
        label: t("common.new_note"),
        icon: Plus,
        combo: APP_SHORTCUTS.newNote,
        group: t("command.commands"),
        run: () => void createContextualNote(),
    },
    {
        id: 'cmd-new-from-template',
        kind: 'command',
        label: t("templates.new_note_from_template"),
        icon: LayoutTemplate,
        combo: APP_SHORTCUTS.templates,
        group: t("command.commands"),
        run: () => openPanel('templates'),
    },
    {
        id: 'cmd-new-folder',
        kind: 'command',
        label: t("common.new_folder"),
        icon: FolderPlus,
        group: t("command.commands"),
        run: () => void createFolder(),
    },
    {
        id: 'cmd-omnisearch',
        kind: 'command',
        label: t("shell.omnisearch"),
        icon: ScanSearch,
        combo: APP_SHORTCUTS.omnisearch,
        group: t("command.commands"),
        run: () => openOmnisearch({ mode: 'vault' }),
    },
    {
        id: 'cmd-emoji',
        kind: 'command',
        label: t("command.open_emoji_picker"),
        icon: Smile,
        combo: APP_SHORTCUTS.emoji,
        group: t("command.commands"),
        run: () => openEmojiPicker(),
    },
    ...(activeNote
        ? [
            {
                id: 'cmd-edit-link',
                kind: 'command' as const,
                label: t("command.edit_or_insert_link"),
                icon: SquarePen,
                group: t("common.current_note"),
                run: () => {
                    const view = getActiveEditorView();
                    if (!view || !openLinkAtCursor(view))
                        toast({ title: t("command.no_editor_to_edit"), tone: 'warning' });
                },
            },
            {
                id: 'cmd-paste-as-link',
                kind: 'command' as const,
                label: t("command.paste_as_link"),
                icon: Link2,
                group: t("common.current_note"),
                run: () => {
                    const view = getActiveEditorView();
                    if (!view) {
                        toast({ title: t("command.no_editor_to_edit"), tone: 'warning' });
                        return;
                    }
                    pasteAsLinkFromClipboard(view);
                },
            },
            {
                id: 'cmd-cover-image',
                kind: 'command' as const,
                label: t("command.select_cover_image"),
                icon: ImagePlus,
                group: t("common.current_note"),
                run: () => requestPropertyDecoration('cover', activeNote.id),
            },
            {
                id: 'cmd-list-up',
                kind: 'command' as const,
                label: t("command.move_list_up"),
                icon: MoveUp,
                group: t("common.current_note"),
                combo: editorCombo('move-list-up'),
                run: runOnList(outlinerMoveItemUp),
            },
            {
                id: 'cmd-list-down',
                kind: 'command' as const,
                label: t("command.move_list_down"),
                icon: MoveDown,
                group: t("common.current_note"),
                combo: editorCombo('move-list-down'),
                run: runOnList(outlinerMoveItemDown),
            },
            {
                id: 'cmd-list-indent',
                kind: 'command' as const,
                label: t("command.outliner_indent"),
                icon: IndentIncrease,
                group: t("common.current_note"),
                run: runOnList(outlinerIndentItem),
            },
            {
                id: 'cmd-list-outdent',
                kind: 'command' as const,
                label: t("command.outliner_outdent"),
                icon: IndentDecrease,
                group: t("common.current_note"),
                run: runOnList(outlinerOutdentItem),
            },
            {
                id: 'cmd-list-fold',
                kind: 'command' as const,
                label: t("command.fold_list"),
                icon: ChevronsDownUp,
                group: t("common.current_note"),
                combo: editorCombo('fold-list'),
                run: runOnList(outlinerFoldItem),
            },
            {
                id: 'cmd-list-unfold',
                kind: 'command' as const,
                label: t("command.unfold_list"),
                icon: ChevronsUpDown,
                group: t("common.current_note"),
                combo: editorCombo('unfold-list'),
                run: runOnList(outlinerUnfoldItem),
            },
            {
                id: 'cmd-list-unfold-all',
                kind: 'command' as const,
                label: t("command.outliner_unfold_all"),
                icon: ListTree,
                group: t("common.current_note"),
                run: runOnList(outlinerUnfoldAll),
            },
            {
                id: 'cmd-banner-image',
                kind: 'command' as const,
                label: t("command.select_banner_image"),
                icon: ImagePlus,
                group: t("common.current_note"),
                run: () => requestPropertyDecoration('banner', activeNote.id),
            },
            {
                id: 'cmd-note-icon',
                kind: 'command' as const,
                label: t("command.select_icon"),
                icon: Smile,
                group: t("common.current_note"),
                run: () => requestPropertyDecoration('icon', activeNote.id),
            },
            {
                id: 'cmd-toggle-hidden-properties',
                kind: 'command' as const,
                label: useSession.getState().settings.properties.revealHidden ? t("command.hide_hidden_properties") : t("command.reveal_hidden_properties"),
                icon: EyeOff,
                group: t("common.current_note"),
                run: () => {
                    const properties = useSession.getState().settings.properties;
                    useSession.getState().updateSettings({ properties: { revealHidden: !properties.revealHidden } });
                },
            },
            {
                id: 'cmd-omnisearch-in-file',
                kind: 'command' as const,
                label: t("omnisearch.scope_file"),
                icon: ScanSearch,
                combo: APP_SHORTCUTS.omnisearchInFile,
                group: t("common.current_note"),
                run: () => openOmnisearch({ mode: 'file', noteId: activeNote.id }),
            },
            {
                id: 'cmd-presentation-mode',
                kind: 'command' as const,
                label: t("workspace.presentation_mode"),
                icon: Presentation,
                combo: APP_SHORTCUTS.present,
                group: t("common.current_note"),
                run: () => void import('../presentation').then((module) => module.startPresentationFromNote(activeNote.id)),
            },
            {
                id: 'cmd-star',
                kind: 'command' as const,
                label: activeNote.isStarred ? t("command.remove_current_note_from_favorites") : t("command.add_current_note_to_favorites"),
                icon: Star,
                combo: APP_SHORTCUTS.star,
                group: t("common.current_note"),
                run: () => void patchNote(activeNote.id, { isStarred: !activeNote.isStarred }),
            },
            {
                id: 'cmd-archive',
                kind: 'command' as const,
                label: activeNote.isArchived ? t("common.unarchive") : t("command.archive_current_note"),
                icon: Archive,
                group: t("common.current_note"),
                run: () => void patchNote(activeNote.id, { isArchived: !activeNote.isArchived }),
            },
            {
                id: 'cmd-share',
                kind: 'command' as const,
                label: t("command.share_current_note"),
                icon: Share2,
                group: t("common.current_note"),
                run: () => openPanel('share'),
            },
            {
                id: 'cmd-delete',
                kind: 'command' as const,
                label: t("command.move_the_current_note_to_trash"),
                icon: Trash2,
                group: t("common.current_note"),
                run: () => void deleteNote(activeNote.id),
            },
            {
                id: 'cmd-outline-copy',
                kind: 'command' as const,
                label: t("command.copy_outline_as_text"),
                icon: ListTree,
                group: t("common.current_note"),
                run: () => {
                    const headings = outlineHeadingsFor(activeNote.id);
                    if (headings.length === 0) {
                        toast({ title: t("command.outline_empty") });
                        return;
                    }
                    void navigator.clipboard.writeText(stringifyOutline(buildOutlineTree(headings), { numbering: false, indent: '\t' }));
                    toast({ title: t("command.outline_copied", { count: headings.length }), tone: 'success' });
                },
            },
            {
                id: 'cmd-outline-copy-numbered',
                kind: 'command' as const,
                label: t("command.copy_outline_numbered"),
                icon: ListTree,
                group: t("common.current_note"),
                run: () => {
                    const headings = outlineHeadingsFor(activeNote.id);
                    if (headings.length === 0) {
                        toast({ title: t("command.outline_empty") });
                        return;
                    }
                    void navigator.clipboard.writeText(stringifyOutline(buildOutlineTree(headings), { numbering: true, indent: '' }));
                    toast({ title: t("command.outline_copied", { count: headings.length }), tone: 'success' });
                },
            },
            {
                id: 'cmd-outline-focus-search',
                kind: 'command' as const,
                label: t("command.outline_focus_search"),
                icon: Search,
                group: t("common.interface"),
                run: () => { sendOutlineCommand('focus-search'); },
            },
            {
                id: 'cmd-outline-level-up',
                kind: 'command' as const,
                label: t("command.outline_level_up"),
                icon: ListTree,
                group: t("common.interface"),
                run: () => { sendOutlineCommand('level-up'); },
            },
            {
                id: 'cmd-outline-level-down',
                kind: 'command' as const,
                label: t("command.outline_level_down"),
                icon: ListTree,
                group: t("common.interface"),
                run: () => { sendOutlineCommand('level-down'); },
            },
            {
                id: 'cmd-outline-reset-level',
                kind: 'command' as const,
                label: t("command.outline_reset_level"),
                icon: ListTree,
                group: t("common.interface"),
                run: () => { sendOutlineCommand('reset-level'); },
            },
        ]
        : []),
    {
        id: 'cmd-layout-edit',
        kind: 'command',
        label: t("workspace.live_preview"),
        icon: Pencil,
        group: t("common.interface"),
        run: () => void updateSettings({ preview: { layout: 'live' } }),
    },
    {
        id: 'cmd-layout-split',
        kind: 'command',
        label: t("command.layout_split_view"),
        icon: Columns2,
        group: t("common.interface"),
        run: () => void updateSettings({ preview: { layout: 'split' } }),
    },
    {
        id: 'cmd-layout-preview',
        kind: 'command',
        label: t("workspace.reading_mode"),
        icon: Eye,
        group: t("common.interface"),
        run: () => void updateSettings({ preview: { layout: 'preview' } }),
    },
    {
        id: 'cmd-theme',
        kind: 'command',
        label: isDark ? t("command.switch_to_light_theme") : t("command.switch_to_dark_theme"),
        icon: isDark ? Sun : Moon,
        group: t("common.interface"),
        run: () => void updateSettings({ appearance: { theme: isDark ? 'light' : 'dark' } }),
    },
    {
        id: 'cmd-accent',
        kind: 'command',
        label: t("command.change_accent_color"),
        icon: Palette,
        group: t("common.interface"),
        run: () => openPanel('settings'),
    },
    {
        id: 'cmd-graph',
        kind: 'command',
        label: t("command.open_graph"),
        icon: Waypoints,
        combo: APP_SHORTCUTS.graph,
        group: t("common.interface"),
        run: () => openPanel('graph'),
    },
    {
        id: 'cmd-local-graph',
        kind: 'command',
        label: t("command.open_local_graph"),
        icon: Waypoints,
        group: t("common.interface"),
        run: () => { if (useUi.getState().activeNoteId) toggleLocalGraph(); },
    },
    {
        id: 'cmd-settings',
        kind: 'command',
        label: t("common.open_settings"),
        icon: Settings,
        combo: APP_SHORTCUTS.settings,
        group: t("command.commands"),
        run: () => openPanel('settings'),
    },
    {
        id: 'cmd-shortcuts',
        kind: 'command',
        label: t("command.keyboard_shortcuts"),
        icon: Keyboard,
        combo: APP_SHORTCUTS.shortcuts,
        group: t("command.commands"),
        run: () => openPanel('shortcuts'),
    },
    {
        id: 'cmd-export',
        kind: 'command',
        label: t("command.export_all_notes_zip"),
        icon: Download,
        group: t("command.commands"),
        run: () => void api.transfer.save('zip').catch((error) => {
            useUi.getState().toast({
                title: t("common.export_failed"),
                description: error instanceof Error ? error.message : String(error),
                tone: 'danger',
            });
        }),
    },
    {
        id: 'cmd-trash',
        kind: 'command',
        label: t("command.open_trash"),
        icon: Trash2,
        group: t("common.navigation"),
        run: () => openView('trash'),
    },
    {
        id: 'cmd-starred',
        kind: 'command',
        label: t("command.open_favorites"),
        icon: Star,
        group: t("common.navigation"),
        run: () => openView('starred'),
    },
    ...(quickAddOn
        ? [
            {
                id: 'cmd-quickadd',
                kind: 'command' as const,
                label: t("quickadd.launcher_title"),
                icon: Zap,
                combo: APP_SHORTCUTS.quickadd,
                group: t("command.commands"),
                run: () => openPanel('quickadd'),
            },
        ]
        : []),
    // A choice flagged as a command is the one thing QuickAdd promises to run without opening
    // the list, and a renamed choice has to show its new name here the same second.
    ...(quickAddOn
        ? quickAddChoices
            .filter((choice) => choice.enabled && choice.asCommand && choice.type !== 'group')
            .map((choice) => ({
                id: `cmd-quickadd-${choice.id}`,
                kind: 'command' as const,
                label: choice.name,
                detail: t(`quickadd.type_${choice.type}` as MessageKey),
                icon: Zap,
                combo: choice.hotkey ?? undefined,
                group: t("quickadd.group"),
                run: () => void import('../../lib/quickadd/runner')
                    .then(({ runQuickAddChoice }) => runQuickAddChoice(choice.id)),
            }))
        : []),
    ]
}

/** One command by id, or null when nothing registers that id. */
export function findAppCommand(id: string): AppCommand | null {
  const wanted = id.trim()
  return appCommands().find((entry) => entry.id === wanted) ?? null
}

/**
 * Run a command by id without opening the palette. The three refusals are reported rather than
 * swallowed, because a caller in an automation chain has to say why nothing happened.
 */
export function runAppCommand(id: string): { ok: true } | { ok: false; reason: 'unavailable' } {
  const command = findAppCommand(id)
  if (!command) return { ok: false, reason: 'unavailable' }
  command.run()
  return { ok: true }
}
