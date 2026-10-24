import { useRef, useState, type ReactNode, type RefObject } from 'react';
import type { EditorView } from '@codemirror/view';
import { Blocks, Braces, CaseUpper, ChevronDown, FileText, Heading, Image as ImageIcon, Link2, MoveVertical, Sigma, Smile, Sparkles, Table, Wand2, WandSparkles } from 'lucide-react';
import { Menu } from '../../components/overlay';
import { cn } from '../../lib/cn';
import { formatCodeBlock, insertCodeBlock, insertLink, insertTable } from '../../editor/commands';
import { blockCarryItems, blockMenuItems, codeMenuItems, formatMenuItems, headingMenuItems, imageMenuItems, mathMenuItems, noteMenuItems, referenceMenuItems, type RunEditorCommand } from '../../editor/editorMenus';
import { Divider, FormatToolbar, MenuButton, ToolButton } from '../../editor/FormatToolbar';
import { isTouchPointer } from '../../editor/dragger';
import { useSession } from '../../store/session';
import { useUi } from '../../store/ui';
import { useNotes } from '../../store/notes';
import { t } from '../../lib/i18n';
import { editorCombo } from '../../editor/shortcuts';
import { APP_SHORTCUTS } from '../../lib/shortcuts';
import { closeEmojiPicker, isEmojiPickerOpen, openEmojiPicker, useEmojiPicker } from '../../store/emoji-picker';
import { EDITOR_AI_LABELS, runEditorAi, type EditorAiAction } from '../chat/editor-ai';
import { suggestNoteMeta } from '../chat/note-suggestions';

type ToolbarMenu = 'heading' | 'reference' | 'image' | 'note' | 'code' | 'math' | 'block' | 'carry' | 'format' | 'ai';

export function EditorToolbar({ runCommand, view, onPickImage, mobile = false, showEmoji = true }: {
    runCommand?: (command: (target: EditorView) => boolean) => void;
    view?: EditorView | null;
    onPickImage: () => void;
    mobile?: boolean;
    showEmoji?: boolean;
}) {
    const emojiRef = useRef<HTMLButtonElement>(null);
    const emojiOpen = useEmojiPicker((state) => state.open && state.anchor !== null);
    const headingRef = useRef<HTMLButtonElement>(null);
    const referenceRef = useRef<HTMLButtonElement>(null);
    const imageRef = useRef<HTMLButtonElement>(null);
    const noteRef = useRef<HTMLButtonElement>(null);
    const codeRef = useRef<HTMLButtonElement>(null);
    const mathRef = useRef<HTMLButtonElement>(null);
    const blockRef = useRef<HTMLButtonElement>(null);
    const carryRef = useRef<HTMLButtonElement>(null);
    const formatRef = useRef<HTMLButtonElement>(null);
    const aiRef = useRef<HTMLButtonElement>(null);
    const [openMenu, setToolbarMenu] = useState<ToolbarMenu | null>(null);
    const draggerOn = useSession((state) => state.settings.editor.dragger);
    const draggerTextDrag = useSession((state) => state.settings.editor.draggerMobileTextDrag);
    const draggerModeButton = useSession((state) => state.settings.editor.draggerDragModeButton);
    const dragMode = useUi((state) => state.draggerDragMode);
    // The mode is a finger's shortcut for a handle, so it is only offered where a handle is hard to hit.
    const dragModeRow = draggerOn && mobile && isTouchPointer() && draggerTextDrag && draggerModeButton
      ? { enabled: dragMode, onToggle: () => useUi.getState().setDraggerDragMode(!dragMode) }
      : null;
    const linterEnabled = useSession((s) => s.settings.linter.enabled);
    const toggleMenu = (menu: ToolbarMenu) => setToolbarMenu((current) => current === menu ? null : menu);
    // The dropdown closes before the command runs, so a menu still holding the pointer cannot keep
    // the focus the command is about to hand back to the editor.
    const run: RunEditorCommand = (command) => {
        setToolbarMenu(null);
        if (runCommand) {
            runCommand(command);
            return;
        }
        if (!view) return;
        command(view);
        view.focus();
    };
    const pickImage = () => {
        setToolbarMenu(null);
        onPickImage();
    };
    /**
     * One of the AI entries, run against whatever the caret is holding.
     *
     * The command reads the document itself rather than a copy captured when the menu opened: the
     * selection is where the reader left it, and a note they kept typing in while the menu was up is a
     * note whose offsets have moved. The whole document is the subject when nothing is selected, which is
     * what makes "summarise this note" reachable from the same menu.
     */
    const runAi = (action: EditorAiAction) => {
        setToolbarMenu(null);
        run((target) => {
            const noteId = useUi.getState().activeNoteId;
            if (!noteId)
                return false;
            const doc = target.state.doc.toString();
            const range = target.state.selection.main;
            const selection = range.empty ? '' : doc.slice(range.from, range.to);
            const at = range.empty ? doc.length : range.to;
            return runEditorAi({
                action,
                noteId,
                noteTitle: useNotes.getState().notes[noteId]?.title ?? '',
                selection,
                whole: doc,
                from: range.empty ? at : range.from,
                to: at,
            });
        });
    };
    const aiItems = [
        ...(['ask', 'rewrite', 'summarize', 'continue', 'translate', 'outline', 'todo'] as const).map((action) => ({
            id: action,
            label: t(EDITOR_AI_LABELS[action]),
            onSelect: () => runAi(action),
        })),
        // The one AI entry that is about the note rather than the selection: it reads the whole body
        // and writes to the front matter, so it sits apart from the five that rewrite a passage.
        {
            id: 'suggest-meta',
            label: t('assistant.suggest.command'),
            separatorBefore: true,
            onSelect: () => {
                setToolbarMenu(null);
                const noteId = useUi.getState().activeNoteId;
                if (noteId)
                    void suggestNoteMeta(noteId);
            },
        },
    ];
    const menus = [
        { id: 'heading', anchor: headingRef, label: t('workspace.title_level'), items: headingMenuItems(run), width: 224 },
        { id: 'reference', anchor: referenceRef, label: t('workspace.links_and_references'), items: referenceMenuItems(run), width: 200 },
        { id: 'image', anchor: imageRef, label: t('workspace.insert_image'), items: imageMenuItems(run, pickImage), width: 176 },
        { id: 'note', anchor: noteRef, label: t('workspace.note_tools'), items: noteMenuItems(run), width: 224 },
        { id: 'code', anchor: codeRef, label: t('workspace.code_and_diagrams'), items: codeMenuItems(run), width: 192 },
        { id: 'math', anchor: mathRef, label: t('workspace.math'), items: mathMenuItems(run), width: 176 },
        { id: 'block', anchor: blockRef, label: t('workspace.content_blocks'), items: blockMenuItems(run), width: 176 },
        { id: 'carry', anchor: carryRef, label: t('dragger.block_actions'), items: blockCarryItems(run, dragModeRow), width: 190 },
        { id: 'format', anchor: formatRef, label: t('workspace.more_formats'), items: formatMenuItems(run), width: 200 },
        { id: 'ai', anchor: aiRef, label: t('assistant.edit.menu'), items: aiItems, width: 190 },
    ] as const;
    const anchors: Record<ToolbarMenu, RefObject<HTMLButtonElement | null>> = {
        heading: headingRef,
        reference: referenceRef,
        image: imageRef,
        note: noteRef,
        code: codeRef,
        math: mathRef,
        block: blockRef,
        carry: carryRef,
        format: formatRef,
        ai: aiRef,
    };
    const labels: Record<ToolbarMenu, string> = {
        heading: t('workspace.title_level'),
        reference: t('workspace.links_and_references'),
        image: t('workspace.insert_image'),
        note: t('workspace.note_tools'),
        code: t('workspace.code_and_diagrams'),
        math: t('workspace.math'),
        block: t('workspace.content_blocks'),
        carry: t('dragger.block_actions'),
        format: t('workspace.more_formats'),
        ai: t('assistant.edit.menu'),
    };
    const menuButton = (id: ToolbarMenu, icon: ReactNode, primary?: { label: string; combo?: string; onClick: () => void }) => {
        return (<div className="flex shrink-0 items-center rounded-[var(--r-md)]">
          {primary && <ToolButton label={primary.label} combo={primary.combo} onClick={primary.onClick}>{icon}</ToolButton>}
          <MenuButton buttonRef={anchors[id]} label={labels[id]} mobile={mobile} open={openMenu === id} onClick={() => toggleMenu(id)}>
            {!primary && icon}
            <ChevronDown size={10} className="opacity-60"/>
          </MenuButton>
        </div>);
    };

    return (<div aria-label={t('workspace.formatting_tools')} className={cn('editor-toolbar flex shrink-0 items-center overflow-x-auto border-b border-[var(--border-subtle)] px-2 no-scrollbar', mobile ? 'h-11 gap-1' : 'h-9 gap-0.5')}>
      {menuButton('heading', <Heading size={14}/>)}
      <Divider />
      <FormatToolbar
        run={run}
        variant="note"
        mobile={mobile}
        onSaveAsTask={() => { void import('../chat/note-task-link').then((module) => module.saveSelectionAsTask()) }}
      />
      <Divider />
      {menuButton('reference', <Link2 size={14}/>, { label: t('workspace.link'), combo: editorCombo('link'), onClick: () => run(insertLink()) })}
      {menuButton('image', <ImageIcon size={14}/>, { label: t('workspace.upload_image'), onClick: pickImage })}
      {menuButton('note', <FileText size={14}/>)}
      {showEmoji && (<ToolButton buttonRef={emojiRef} label={t('emoji.insert')} combo={APP_SHORTCUTS.emoji} expanded={emojiOpen} popup="dialog" onClick={() => {
                if (isEmojiPickerOpen())
                    closeEmojiPicker();
                else
                    openEmojiPicker(emojiRef.current);
            }}><Smile size={14}/></ToolButton>)}
      <Divider />
      {menuButton('code', <Braces size={14}/>, { label: t('workspace.code_block'), onClick: () => run(insertCodeBlock) })}
      <ToolButton label={t('command.format_code_block')} combo={editorCombo('format-code')} onClick={() => run(formatCodeBlock)}><Sparkles size={14}/></ToolButton>
      <ToolButton label={t('workspace.table')} onClick={() => run(insertTable)}><Table size={14}/></ToolButton>
      {menuButton('math', <Sigma size={14}/>)}
      {menuButton('block', <Blocks size={14}/>)}
      {draggerOn && menuButton('carry', <MoveVertical size={14}/>)}
      {menuButton('format', <CaseUpper size={14}/>)}
      <Divider />
      {menuButton('ai', <Wand2 size={14}/>)}
      {linterEnabled && (<><Divider />
        <ToolButton label={t('linter.command.lint_note')} combo={APP_SHORTCUTS.lintNote} onClick={() => {
                    void import('../../lib/linter/drive').then((drive) => drive.lintCurrentNote());
                }}>
          <WandSparkles size={14}/>
        </ToolButton>
      </>)}
      {menus.map((menu) => <Menu key={menu.id} anchor={menu.anchor} open={openMenu === menu.id} onClose={() => setToolbarMenu(null)} items={menu.items} width={menu.width} label={menu.label}/>)}
    </div>);
}
