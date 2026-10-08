import { useRef, useState, type ReactNode, type RefObject } from 'react';
import type { EditorView } from '@codemirror/view';
import { Blocks, Bold, Braces, CaseUpper, ChevronDown, Code, FileText, Heading, Highlighter, Image as ImageIcon, Italic, Link2, List, ListOrdered, ListTodo, MoveVertical, Quote, Sigma, Smile, Sparkles, Strikethrough, Table, Type, Underline, WandSparkles } from 'lucide-react';
import { IconButton } from '../../components/primitives';
import { Menu, Tooltip } from '../../components/overlay';
import { cn } from '../../lib/cn';
import { formatCodeBlock, insertCodeBlock, insertLink, insertTable, toggleBold, toggleBulletList, toggleHighlight, toggleInlineCode, toggleItalic, toggleOrderedList, toggleQuote, toggleStrikethrough, toggleTaskList } from '../../editor/commands';
import { setFontColor, setHighlightColor, toggleUnderline } from '../../editor/text-format';
import { EditorColorPanel } from './EditorColorMenu';
import { useRecentColors } from '../../lib/format-colors';
import { blockCarryItems, blockMenuItems, codeMenuItems, formatMenuItems, headingMenuItems, imageMenuItems, mathMenuItems, noteMenuItems, referenceMenuItems, type RunEditorCommand } from '../../editor/editorMenus';
import { isTouchPointer } from '../../editor/dragger';
import { useSession } from '../../store/session';
import { useUi } from '../../store/ui';
import { t } from '../../lib/i18n';
import { editorCombo } from '../../editor/shortcuts';
import { APP_SHORTCUTS } from '../../lib/shortcuts';
import { closeEmojiPicker, isEmojiPickerOpen, openEmojiPicker, useEmojiPicker } from '../../store/emoji-picker';

type ToolbarMenu = 'heading' | 'reference' | 'image' | 'note' | 'code' | 'math' | 'block' | 'carry' | 'format' | 'text-color' | 'highlight-color';

/**
 * The palette is a menu header, and a header is placed before it is measured. These are what the
 * panel actually is, so the maths that flips a menu away from the viewport edge can see it.
 */
const PALETTE_WIDTH = 242;
const PALETTE_HEIGHT = 342;

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
    const textColorRef = useRef<HTMLButtonElement>(null);
    const highlightColorRef = useRef<HTMLButtonElement>(null);
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
    const recent = useRecentColors();
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
        'text-color': textColorRef,
        'highlight-color': highlightColorRef,
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
        'text-color': t('workspace.text_color'),
        'highlight-color': t('workspace.highlight_color'),
    };
    const menuButton = (id: ToolbarMenu, icon: ReactNode, primary?: { label: string; combo?: string; onClick: () => void }) => {
        const lastUsed = id === 'text-color' ? recent.text[0] : id === 'highlight-color' ? recent.highlight[0] : undefined;
        return (<div className="flex shrink-0 items-center rounded-[var(--r-md)]">
          {primary && <ToolButton label={primary.label} combo={primary.combo} onClick={primary.onClick}>{icon}</ToolButton>}
          <MenuButton buttonRef={anchors[id]} label={labels[id]} mobile={mobile} open={openMenu === id} onClick={() => toggleMenu(id)}>
            {!primary && icon}
            {lastUsed && <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: lastUsed }}/>}
            <ChevronDown size={10} className="opacity-60"/>
          </MenuButton>
        </div>);
    };

    return (<div aria-label={t('workspace.formatting_tools')} className={cn('editor-toolbar flex shrink-0 items-center overflow-x-auto border-b border-[var(--border-subtle)] px-2 no-scrollbar', mobile ? 'h-11 gap-1' : 'h-9 gap-0.5')}>
      {menuButton('heading', <Heading size={14}/>)}
      <Divider />
      <ToolButton label={t('common.bold')} combo={editorCombo('bold')} onClick={() => run(toggleBold)}><Bold size={14}/></ToolButton>
      <ToolButton label={t('common.italic')} combo={editorCombo('italic')} onClick={() => run(toggleItalic)}><Italic size={14}/></ToolButton>
      <ToolButton label={t('common.underline')} combo={editorCombo('underline')} onClick={() => run(toggleUnderline)}><Underline size={14}/></ToolButton>
      <ToolButton label={t('common.strikethrough')} combo={editorCombo('strikethrough')} onClick={() => run(toggleStrikethrough)}><Strikethrough size={14}/></ToolButton>
      {menuButton('text-color', <Type size={14}/>)}
      {menuButton('highlight-color', <Highlighter size={14}/>, { label: t('common.highlight'), onClick: () => run(toggleHighlight) })}
      <ToolButton label={t('common.inline_code')} combo={editorCombo('inline-code')} onClick={() => run(toggleInlineCode)}><Code size={14}/></ToolButton>
      <Divider />
      <ToolButton label={t('common.unordered_list')} combo={editorCombo('bullet-list')} onClick={() => run(toggleBulletList)}><List size={14}/></ToolButton>
      <ToolButton label={t('common.ordered_list')} combo={editorCombo('ordered-list')} onClick={() => run(toggleOrderedList)}><ListOrdered size={14}/></ToolButton>
      <ToolButton label={t('common.task_list')} combo={editorCombo('task-list')} onClick={() => run(toggleTaskList)}><ListTodo size={14}/></ToolButton>
      <ToolButton label={t('common.quote')} combo={editorCombo('quote')} onClick={() => run(toggleQuote)}><Quote size={14}/></ToolButton>
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
      {linterEnabled && (<><Divider />
        <ToolButton label={t('linter.command.lint_note')} combo={APP_SHORTCUTS.lintNote} onClick={() => {
                    void import('../../lib/linter/drive').then((drive) => drive.lintCurrentNote());
                }}>
          <WandSparkles size={14}/>
        </ToolButton>
      </>)}
      {menus.map((menu) => <Menu key={menu.id} anchor={menu.anchor} open={openMenu === menu.id} onClose={() => setToolbarMenu(null)} items={menu.items} width={menu.width} label={menu.label}/>)}
      <Menu anchor={textColorRef} open={openMenu === 'text-color'} onClose={() => setToolbarMenu(null)} items={[]} width={PALETTE_WIDTH} label={t('workspace.text_color')} headerHeight={PALETTE_HEIGHT} header={<EditorColorPanel kind="text" current={recent.text[0]} onPick={color => run(setFontColor(color))}/>}/>
      <Menu anchor={highlightColorRef} open={openMenu === 'highlight-color'} onClose={() => setToolbarMenu(null)} items={[]} width={PALETTE_WIDTH} label={t('workspace.highlight_color')} headerHeight={PALETTE_HEIGHT} header={<EditorColorPanel kind="highlight" current={recent.highlight[0]} onPick={color => run(setHighlightColor(color))}/>}/>
    </div>);
}

function MenuButton({ buttonRef, label, open, onClick, children, mobile = false }: {
    buttonRef: RefObject<HTMLButtonElement | null>;
    label: string;
    open: boolean;
    mobile?: boolean;
    onClick: () => void;
    children: ReactNode;
}) {
    return (<Tooltip label={label}>
      <button ref={buttonRef} type="button" onClick={onClick} aria-label={label} aria-haspopup="menu" aria-expanded={open} className={cn('inline-flex shrink-0 items-center gap-0.5 rounded-[var(--r-md)] px-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]', open && 'bg-[var(--bg-hover)] text-[var(--text-primary)]', mobile ? 'h-9' : 'h-7')}>
        {children}
      </button>
    </Tooltip>);
}

function ToolButton({ label, combo, onClick, children, buttonRef, expanded, popup }: {
    label: string;
    combo?: string;
    onClick: () => void;
    children: ReactNode;
    buttonRef?: RefObject<HTMLButtonElement | null>;
    expanded?: boolean;
    popup?: 'dialog' | 'menu';
}) {
    return (<Tooltip label={label} combo={combo}>
      <IconButton ref={buttonRef} label={label} size="sm" onClick={onClick} aria-expanded={expanded} aria-haspopup={popup} className="size-9 shrink-0 md:size-7">{children}</IconButton>
    </Tooltip>);
}

function Divider() {
    return <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-[var(--border-subtle)]"/>;
}
