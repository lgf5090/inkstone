import { useRef, useState, type ReactNode, type RefObject } from 'react'
import type { EditorView } from '@codemirror/view'
import { redo, undo } from '@codemirror/commands'
import {
  Bold,
  CaseUpper,
  ChevronDown,
  Code,
  Highlighter,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Quote,
  Redo2,
  Strikethrough,
  Type,
  Underline,
  Undo2,
} from 'lucide-react'
import { IconButton } from '../components/primitives'
import { Menu, Tooltip, type MenuItem } from '../components/overlay'
import { cn } from '../lib/cn'
import {
  insertCodeBlock,
  insertHorizontalRule,
  insertLink,
  toggleBold,
  toggleBulletList,
  toggleHighlight,
  toggleInlineCode,
  toggleItalic,
  toggleOrderedList,
  toggleQuote,
  toggleStrikethrough,
  toggleTaskList,
} from './commands'
import { setFontColor, setHighlightColor, toggleUnderline } from './text-format'
import { EditorColorPanel } from './EditorColorMenu'
import { useRecentColors } from '../lib/format-colors'
import { t } from '../lib/i18n'
import { editorCombo } from './shortcuts'

export type FormatVariant = 'note' | 'email'

export type RunFormatCommand = (command: (target: EditorView) => boolean) => void

type FormatMenu = 'text-color' | 'highlight-color' | 'align'

const PALETTE_WIDTH = 242
const PALETTE_HEIGHT = 342

export interface FormatToolbarProps {
  run: RunFormatCommand
  variant: FormatVariant
  mobile?: boolean
  onSaveAsTask?: () => void
  onInsertLink?: () => void
  onAlign?: (align: 'left' | 'center' | 'right' | 'justify') => void
  showHistory?: boolean
}

export function FormatToolbar({
  run,
  variant,
  mobile = false,
  onSaveAsTask,
  onInsertLink,
  onAlign,
  showHistory = false,
}: FormatToolbarProps) {
  const recent = useRecentColors()
  const [openMenu, setOpenMenu] = useState<FormatMenu | null>(null)
  const textColorRef = useRef<HTMLButtonElement>(null)
  const highlightColorRef = useRef<HTMLButtonElement>(null)
  const alignRef = useRef<HTMLButtonElement>(null)
  const toggleMenu = (menu: FormatMenu) => setOpenMenu(current => current === menu ? null : menu)
  const runFromMenu = (command: (target: EditorView) => boolean) => {
    setOpenMenu(null)
    run(command)
  }
  const alignItems: MenuItem[] = [
    { id: 'left', label: t('workspace.align_left'), onSelect: () => onAlign?.('left') },
    { id: 'center', label: t('workspace.align_center'), onSelect: () => onAlign?.('center') },
    { id: 'right', label: t('workspace.align_right'), onSelect: () => onAlign?.('right') },
    { id: 'justify', label: t('workspace.align_justify'), onSelect: () => onAlign?.('justify') },
  ]

  return (
    <div
      aria-label={t('workspace.formatting_tools')}
      className={cn(
        'flex shrink-0 items-center gap-0.5 overflow-x-auto no-scrollbar',
        mobile ? 'h-11 gap-1' : 'h-9',
      )}
    >
      <ToolButton label={t('common.bold')} combo={editorCombo('bold')} onClick={() => run(toggleBold)}>
        <Bold size={14} />
      </ToolButton>
      <ToolButton label={t('common.italic')} combo={editorCombo('italic')} onClick={() => run(toggleItalic)}>
        <Italic size={14} />
      </ToolButton>
      <ToolButton label={t('common.underline')} combo={editorCombo('underline')} onClick={() => run(toggleUnderline)}>
        <Underline size={14} />
      </ToolButton>
      <ToolButton label={t('common.strikethrough')} combo={editorCombo('strikethrough')} onClick={() => run(toggleStrikethrough)}>
        <Strikethrough size={14} />
      </ToolButton>
      <FormatMenuButton
        buttonRef={textColorRef}
        label={t('workspace.text_color')}
        mobile={mobile}
        open={openMenu === 'text-color'}
        onClick={() => toggleMenu('text-color')}
      >
        <Type size={14} />
        {recent.text[0] && <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: recent.text[0] }} />}
        <ChevronDown size={10} className="opacity-60" />
      </FormatMenuButton>
      <FormatMenuButton
        buttonRef={highlightColorRef}
        label={t('workspace.highlight_color')}
        mobile={mobile}
        open={openMenu === 'highlight-color'}
        onClick={() => toggleMenu('highlight-color')}
        primary={{ label: t('common.highlight'), onClick: () => run(toggleHighlight) }}
      >
        <Highlighter size={14} />
        {recent.highlight[0] && <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: recent.highlight[0] }} />}
        <ChevronDown size={10} className="opacity-60" />
      </FormatMenuButton>
      <ToolButton label={t('common.inline_code')} combo={editorCombo('inline-code')} onClick={() => run(toggleInlineCode)}>
        <Code size={14} />
      </ToolButton>
      <Divider />
      <ToolButton label={t('common.unordered_list')} combo={editorCombo('bullet-list')} onClick={() => run(toggleBulletList)}>
        <List size={14} />
      </ToolButton>
      <ToolButton label={t('common.ordered_list')} combo={editorCombo('ordered-list')} onClick={() => run(toggleOrderedList)}>
        <ListOrdered size={14} />
      </ToolButton>
      {variant === 'note' && (
        <ToolButton label={t('common.task_list')} combo={editorCombo('task-list')} onClick={() => run(toggleTaskList)}>
          <ListTodo size={14} />
        </ToolButton>
      )}
      {variant === 'note' && onSaveAsTask && (
        <ToolButton label={t('todo.chat.save_as_task')} onClick={onSaveAsTask}>
          <ListTodo size={14} />
        </ToolButton>
      )}
      <ToolButton label={t('common.quote')} combo={editorCombo('quote')} onClick={() => run(toggleQuote)}>
        <Quote size={14} />
      </ToolButton>
      {variant === 'email' && (
        <>
          <Divider />
          <ToolButton label={t('workspace.link')} combo={editorCombo('link')} onClick={() => (onInsertLink ? onInsertLink() : run(insertLink()))}>
            <Link2 size={14} />
          </ToolButton>
          <ToolButton label={t('workspace.code_block')} onClick={() => run(insertCodeBlock)}>
            <Code size={14} />
          </ToolButton>
          <ToolButton label={t('workspace.divider')} onClick={() => run(insertHorizontalRule)}>
            <Minus size={14} />
          </ToolButton>
          <FormatMenuButton
            buttonRef={alignRef}
            label={t('workspace.alignment')}
            mobile={mobile}
            open={openMenu === 'align'}
            onClick={() => toggleMenu('align')}
          >
            <CaseUpper size={14} />
          </FormatMenuButton>
          {showHistory && (
            <>
              <ToolButton label={t('common.undo')} onClick={() => run(undo)}>
                <Undo2 size={14} />
              </ToolButton>
              <ToolButton label={t('common.redo')} onClick={() => run(redo)}>
                <Redo2 size={14} />
              </ToolButton>
            </>
          )}
        </>
      )}
      <Menu
        anchor={textColorRef}
        open={openMenu === 'text-color'}
        onClose={() => setOpenMenu(null)}
        items={[]}
        width={PALETTE_WIDTH}
        label={t('workspace.text_color')}
        headerHeight={PALETTE_HEIGHT}
        header={<EditorColorPanel kind="text" current={recent.text[0]} onPick={color => runFromMenu(setFontColor(color))} />}
      />
      <Menu
        anchor={highlightColorRef}
        open={openMenu === 'highlight-color'}
        onClose={() => setOpenMenu(null)}
        items={[]}
        width={PALETTE_WIDTH}
        label={t('workspace.highlight_color')}
        headerHeight={PALETTE_HEIGHT}
        header={<EditorColorPanel kind="highlight" current={recent.highlight[0]} onPick={color => runFromMenu(setHighlightColor(color))} />}
      />
      {variant === 'email' && (
        <Menu
          anchor={alignRef}
          open={openMenu === 'align'}
          onClose={() => setOpenMenu(null)}
          items={alignItems}
          width={180}
          label={t('workspace.alignment')}
        />
      )}
    </div>
  )
}

export function MenuButton({ buttonRef, label, open, onClick, children, mobile = false }: {
  buttonRef: RefObject<HTMLButtonElement | null>
  label: string
  open: boolean
  mobile?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip label={label}>
      <button
        ref={buttonRef}
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          'inline-flex shrink-0 items-center gap-0.5 rounded-[var(--r-md)] px-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
          open && 'bg-[var(--bg-hover)] text-[var(--text-primary)]',
          mobile ? 'h-9' : 'h-7',
        )}
      >
        {children}
      </button>
    </Tooltip>
  )
}

export function ToolButton({ label, combo, onClick, children, buttonRef, expanded, popup }: {
  label: string
  combo?: string
  onClick: () => void
  children: ReactNode
  buttonRef?: RefObject<HTMLButtonElement | null>
  expanded?: boolean
  popup?: 'dialog' | 'menu'
}) {
  return (
    <Tooltip label={label} combo={combo}>
      <IconButton ref={buttonRef} label={label} size="sm" onClick={onClick} aria-expanded={expanded} aria-haspopup={popup} className="size-9 shrink-0 md:size-7">
        {children}
      </IconButton>
    </Tooltip>
  )
}

export function Divider() {
  return <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-[var(--border-subtle)]" />
}

function FormatMenuButton({ buttonRef, label, open, onClick, children, mobile = false, primary }: {
  buttonRef: RefObject<HTMLButtonElement | null>
  label: string
  open: boolean
  onClick: () => void
  children: ReactNode
  mobile?: boolean
  primary?: { label: string; onClick: () => void }
}) {
  return (
    <div className="flex shrink-0 items-center rounded-[var(--r-md)]">
      {primary && (
        <ToolButton label={primary.label} onClick={primary.onClick}>
          {children}
        </ToolButton>
      )}
      <MenuButton buttonRef={buttonRef} label={label} mobile={mobile} open={open} onClick={onClick}>
        {!primary && children}
        <ChevronDown size={10} className="opacity-60" />
      </MenuButton>
    </div>
  )
}
