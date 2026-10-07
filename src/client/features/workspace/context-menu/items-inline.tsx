import { CaseUpper, CheckSquare, Copy, ExternalLink, FileText, Heading, List, Maximize2, Network, Pencil, Plus, Sigma, SquarePen, Trash2 } from 'lucide-react'
import { submenuFor, type MenuItem } from '../../../components/overlay'
import { t } from '../../../lib/i18n'
import { findNoteByTitle } from '../../../store/notes'
import { updateTaskAtSourceLine } from '../../../editor/commands'
import { formatMenuItems } from '../../../editor/editorMenus'
import { editLinkFromMenu } from '../../links/use-link-editor'
import { joinLines, splitLines } from '../../../lib/markdown/fence-edit'
import { containerRangeInText, isSafeExternalUrl, setHeadingLevelInText, taskToBulletInText } from './line-edits'
import type { MenuCtx } from './types'
import { isSourceMenu } from './types'

/**
 * The menus of the things that live inside a line: a heading, a task, a link, an image, a formula,
 * a tag, and the document's own front matter.
 *
 * The preview side edits the note's text rather than running an editor command. That distinction is
 * the whole point of this file: a split view always has a live editor, and a CodeMirror command acts
 * on wherever its cursor happens to be — which is not the heading that was right-clicked.
 */

function jumpItem(ctx: MenuCtx, line: number, separatorBefore = true): MenuItem {
  return { id: 'jump-to-editor', label: t('contextmenu.jump_to_editor'), icon: <Pencil size={14} />, separatorBefore, onSelect: () => ctx.onJumpToLine(line) }
}

function copyItem(ctx: MenuCtx, id: string, label: string, text: string, separatorBefore = false): MenuItem {
  return { id, label, icon: <Copy size={14} />, separatorBefore, onSelect: () => ctx.onCopyText(text) }
}

/**
 * The row that hands the link to the inline editor. Both halves of the menu's state are passed through
 * because only the caller knows which side raised it, and the editor needs a character span either way.
 */
function editLinkItem(ctx: MenuCtx): MenuItem | null {
  if (!ctx.noteId) return null
  const fromSource = ctx.editorView !== null && ctx.editor !== null
  const fromPreview = ctx.preview !== null && ctx.preview.line !== undefined
  if (!fromSource && !fromPreview) return null
  return {
    id: 'edit-link',
    label: t('contextmenu.link_edit'),
    icon: <SquarePen size={14} />,
    onSelect: () => {
      const opened = editLinkFromMenu({
        noteId: ctx.noteId,
        content: ctx.content,
        editorPos: fromSource ? ctx.editor!.pos : null,
        previewLine: fromPreview ? ctx.preview!.line! : null,
        previewElement: fromPreview ? ctx.preview!.target : null,
        view: ctx.editorView,
      })
      if (!opened) ctx.onToast({ title: t('contextmenu.link_edit_failed'), tone: 'warning' })
    },
  }
}

function withEditRow(items: MenuItem[], ctx: MenuCtx): MenuItem[] {
  const edit = editLinkItem(ctx)
  return edit ? [edit, ...items] : items
}

/** Delete a whole line of the note, its newline included, from either side. */
function deleteLineItem(ctx: MenuCtx, line: number, label: string): MenuItem {
  return {
    id: 'delete-line',
    label,
    icon: <Trash2 size={14} />,
    tone: 'danger',
    separatorBefore: true,
    onSelect: () => {
      const { lines, eol, trailingNewline } = splitLines(ctx.content)
      if (line < 0 || line >= lines.length) return
      lines.splice(line, 1)
      ctx.onEditContent(joinLines(lines, eol, trailingNewline))
    },
  }
}

export function buildHeadingItems(ctx: MenuCtx): MenuItem[] | null {
  const heading = ctx.editor?.heading ?? ctx.preview?.heading
  if (!heading || (ctx.editor?.kind ?? ctx.preview?.kind) !== 'heading') return null
  const line = isSourceMenu(ctx) ? ctx.editor!.line - 1 : ctx.preview?.line
  const level = heading.level
  const levels: MenuItem[] = [
    ...[1, 2, 3, 4, 5, 6].map((next) => ({
      id: `heading-${next}`,
      label: t('workspace.heading_value0', { value0: next }),
      checked: next === level,
      onSelect: () => applyHeadingLevel(ctx, line, next),
    })),
    {
      id: 'heading-paragraph',
      label: t('workspace.paragraph'),
      separatorBefore: true,
      onSelect: () => applyHeadingLevel(ctx, line, 0),
    },
  ]
  const items: MenuItem[] = [
    {
      id: 'heading-level',
      label: t('contextmenu.heading_level'),
      icon: <Heading size={14} />,
      subItems: levels,
      submenu: submenuFor(levels, 190),
    },
    copyItem(ctx, 'copy-heading', t('contextmenu.copy_heading_text'), heading.text, true),
  ]
  if (!isSourceMenu(ctx) && line !== undefined && line !== null) items.push(jumpItem(ctx, line))
  if (isSourceMenu(ctx)) items.push(deleteLineItem(ctx, line!, t('contextmenu.delete_heading')))
  return items
}

/** Rewrite the heading marker on the note's own line, so the block that was clicked is the one that moves. */
function applyHeadingLevel(ctx: MenuCtx, line: number | null | undefined, level: number): void {
  if (line === null || line === undefined) return
  const next = setHeadingLevelInText(ctx.content, line, level)
  if (next === null) {
    ctx.onToast({ title: t('contextmenu.line_changed'), tone: 'warning' })
    return
  }
  ctx.onEditContent(next)
}

export function buildTaskItems(ctx: MenuCtx): MenuItem[] | null {
  const task = ctx.editor?.task ?? ctx.preview?.task
  if (!task || (ctx.editor?.kind ?? ctx.preview?.kind) !== 'task') return null
  const line = isSourceMenu(ctx) ? ctx.editor!.line - 1 : ctx.preview?.line
  const items: MenuItem[] = [
    {
      id: 'toggle-task',
      label: t(task.checked ? 'contextmenu.task_mark_open' : 'contextmenu.task_mark_done'),
      icon: <CheckSquare size={14} />,
      onSelect: () => {
        if (line === null || line === undefined) return
        const next = updateTaskAtSourceLine(ctx.content, line, !task.checked)
        if (next === null) ctx.onToast({ title: t('contextmenu.line_changed'), tone: 'warning' })
        else ctx.onEditContent(next)
      },
    },
  ]
  if (isSourceMenu(ctx)) {
    items.push({
      id: 'task-to-bullet',
      label: t('contextmenu.task_to_bullet'),
      icon: <List size={14} />,
      onSelect: () => {
        if (line === null || line === undefined) return
        const next = taskToBulletInText(ctx.content, line)
        if (next === null) ctx.onToast({ title: t('contextmenu.line_changed'), tone: 'warning' })
        else ctx.onEditContent(next)
      },
    })
    items.push(deleteLineItem(ctx, line!, t('contextmenu.task_delete')))
  } else if (line !== undefined && line !== null) {
    items.push(jumpItem(ctx, line))
  }
  return items
}

export function buildImageItems(ctx: MenuCtx): MenuItem[] | null {
  const image = ctx.editor?.image ?? ctx.preview?.image
  if (!image || (ctx.editor?.kind ?? ctx.preview?.kind) !== 'image') return null
  const src = 'src' in image ? image.src : image.url
  const alt = image.alt
  const items: MenuItem[] = [
    { id: 'preview-image', label: t('contextmenu.image_preview'), icon: <Maximize2 size={14} />, onSelect: () => ctx.onLightbox({ src, alt }) },
    copyItem(ctx, 'copy-image-md', t('contextmenu.copy_markdown'), `![${alt}](${src})`, true),
    copyItem(ctx, 'copy-image-url', t('contextmenu.copy_link'), src),
  ]
  if (!isSourceMenu(ctx) && ctx.preview?.line !== undefined) items.push(jumpItem(ctx, ctx.preview.line))
  return withEditRow(items, ctx)
}

export function buildLinkItems(ctx: MenuCtx): MenuItem[] | null {
  const link = ctx.editor?.link ?? ctx.preview?.link
  if (!link || (ctx.editor?.kind ?? ctx.preview?.kind) !== 'link') return null
  const items: MenuItem[] = [
    {
      id: 'open-link',
      label: t('contextmenu.link_open'),
      icon: <ExternalLink size={14} />,
      disabled: !isSafeExternalUrl(link.url),
      onSelect: () => {
        if (isSafeExternalUrl(link.url)) window.open(link.url, '_blank', 'noopener,noreferrer')
      },
    },
    copyItem(ctx, 'copy-link-url', t('contextmenu.copy_link'), link.url, true),
  ]
  if (isSourceMenu(ctx) && ctx.editor?.link) {
    const span = ctx.editor.link
    const view = ctx.editorView
    items.push({
      id: 'unwrap-link',
      label: t('contextmenu.link_unwrap'),
      icon: <Trash2 size={14} />,
      tone: 'danger',
      onSelect: () => {
        view?.dispatch({ changes: { from: span.from, to: span.to, insert: span.text } })
        view?.focus()
      },
    })
  }
  if (!isSourceMenu(ctx) && ctx.preview?.line !== undefined) items.push(jumpItem(ctx, ctx.preview.line))
  return withEditRow(items, ctx)
}

export function buildWikiLinkItems(ctx: MenuCtx): MenuItem[] | null {
  const wiki = ctx.editor?.wikiLink ?? ctx.preview?.wikiLink
  if (!wiki || (ctx.editor?.kind ?? ctx.preview?.kind) !== 'wikilink') return null
  const title = wiki.target
  const items: MenuItem[] = [
    {
      id: 'open-wiki',
      label: t('contextmenu.wikilink_open'),
      icon: <Network size={14} />,
      disabled: !title,
      onSelect: () => {
        const note = findNoteByTitle(title)
        if (note) ctx.onOpenNote(note.id)
        else ctx.onCreateNote({ title, open: true })
      },
    },
    {
      id: 'open-wiki-secondary',
      label: t('contextmenu.wikilink_open_secondary'),
      icon: <Maximize2 size={14} />,
      disabled: !title,
      onSelect: () => {
        const note = findNoteByTitle(title)
        if (note) ctx.onOpenInSecondary(note.id)
      },
    },
    copyItem(ctx, 'copy-wiki-title', t('contextmenu.copy_title'), title, true),
  ]
  if (!isSourceMenu(ctx) && ctx.preview?.line !== undefined) items.push(jumpItem(ctx, ctx.preview.line))
  if (isSourceMenu(ctx) && ctx.editor?.wikiLink) {
    const span = ctx.editor.wikiLink
    items.push({
      id: 'unwrap-wiki',
      label: t('contextmenu.link_unwrap'),
      icon: <Trash2 size={14} />,
      tone: 'danger',
      onSelect: () => {
        ctx.editorView?.dispatch({ changes: { from: span.from, to: span.to, insert: span.alias || title } })
        ctx.editorView?.focus()
      },
    })
  }
  return withEditRow(items, ctx)
}

export function buildEmbedItems(ctx: MenuCtx): MenuItem[] | null {
  const embed = ctx.editor?.embed ?? ctx.preview?.embed
  if (!embed || (ctx.editor?.kind ?? ctx.preview?.kind) !== 'embed') return null
  const title = embed.target.split('#')[0]!.trim()
  const items: MenuItem[] = [
    {
      id: 'open-embed',
      label: t('contextmenu.embed_open_source'),
      icon: <FileText size={14} />,
      disabled: !title,
      onSelect: () => {
        const note = findNoteByTitle(title)
        if (note) ctx.onOpenNote(note.id)
        else ctx.onToast({ title: t('contextmenu.wikilink_missing'), tone: 'warning' })
      },
    },
    copyItem(ctx, 'copy-embed-target', t('contextmenu.copy_title'), embed.target, true),
  ]
  if (!isSourceMenu(ctx) && ctx.preview?.line !== undefined) items.push(jumpItem(ctx, ctx.preview.line))
  return withEditRow(items, ctx)
}

export function buildMathItems(ctx: MenuCtx): MenuItem[] | null {
  const math = ctx.editor?.math ?? ctx.preview?.math
  if (!math || (ctx.editor?.kind ?? ctx.preview?.kind) !== 'math') return null
  const items: MenuItem[] = [
    copyItem(ctx, 'copy-math', t('contextmenu.copy_formula'), math.formula, false),
  ]
  if (isSourceMenu(ctx) && ctx.editor?.math) {
    const span = ctx.editor.math
    items.push({
      id: 'toggle-math-block',
      label: t(math.block ? 'contextmenu.math_to_inline' : 'contextmenu.math_to_block'),
      icon: <Sigma size={14} />,
      onSelect: () => {
        const trimmed = span.formula.trim()
        const next = math.block ? `$${trimmed}$` : `$$\n${trimmed}\n$$\n`
        ctx.editorView?.dispatch({ changes: { from: span.from, to: span.to, insert: next }, scrollIntoView: true })
        ctx.editorView?.focus()
      },
    })
    items.push({
      id: 'delete-math',
      label: t('contextmenu.delete_block'),
      icon: <Trash2 size={14} />,
      tone: 'danger',
      onSelect: () => {
        ctx.editorView?.dispatch({ changes: { from: span.from, to: span.to, insert: '' } })
        ctx.editorView?.focus()
      },
    })
  }
  if (!isSourceMenu(ctx) && ctx.preview?.line !== undefined) items.push(jumpItem(ctx, ctx.preview.line))
  return items
}

/** The properties panel and the raw front matter block answer with the same rows. */
const FRONTMATTER_PROPERTIES = [
  { id: 'tags', text: 'tags: []' },
  { id: 'aliases', text: 'aliases: []' },
  { id: 'status', text: 'status: draft' },
  { id: 'published', text: 'published: false' },
  { id: 'cssclasses', text: 'cssclasses: []' },
]

export function buildFrontmatterItems(ctx: MenuCtx): MenuItem[] | null {
  if ((ctx.editor?.kind ?? ctx.preview?.kind) !== 'frontmatter') return null
  const items: MenuItem[] = []
  if (isSourceMenu(ctx)) {
    const properties: MenuItem[] = FRONTMATTER_PROPERTIES.map((property) => ({
      id: `property-${property.id}`,
      label: property.text,
      onSelect: () => {
        const { lines, eol, trailingNewline } = splitLines(ctx.content)
        if (!/^---[ \t]*$/.test(lines[0] ?? '')) return
        lines.splice(1, 0, property.text)
        ctx.onEditContent(joinLines(lines, eol, trailingNewline))
      },
    }))
    items.push({
      id: 'add-property',
      label: t('contextmenu.frontmatter_add_property'),
      icon: <Plus size={14} />,
      subItems: properties,
      submenu: submenuFor(properties, 200),
    })
  } else {
    items.push(jumpItem(ctx, 0, false))
  }
  const body = frontmatterBody(ctx.content)
  if (body) items.push(copyItem(ctx, 'copy-frontmatter', t('contextmenu.copy_properties'), body, items.length > 0))
  return items
}

/** The text between the two `---` rules, or '' when the note has no front matter. */
export function frontmatterBody(content: string): string {
  const { lines } = splitLines(content)
  if (!/^---[ \t]*$/.test(lines[0] ?? '')) return ''
  const close = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.|===)[ \t]*$/.test(line))
  return close === -1 ? '' : lines.slice(1, close).join('\n')
}

export function buildContainerItems(ctx: MenuCtx): MenuItem[] | null {
  const source = ctx.editor?.kind === 'container' ? ctx.editor.container : null
  const rendered = ctx.preview?.kind === 'container' ? ctx.preview.container : null
  if (!source && !rendered) return null
  const line = source ? source.from : ctx.preview?.line
  const span = source ? { start: source.from, end: source.to } : containerRangeInText(ctx.content, line ?? -1)
  if (!span) return null
  const body = splitLines(ctx.content).lines.slice(span.start, span.end + 1).join('\n')
  const items: MenuItem[] = [
    {
      id: 'copy-container',
      label: t('contextmenu.copy_source'),
      icon: <Copy size={14} />,
      onSelect: () => ctx.onCopyText(body),
    },
  ]
  if (!isSourceMenu(ctx) && ctx.preview?.line !== undefined) items.push(jumpItem(ctx, ctx.preview.line, true))
  return items
}

export function buildSelectionItems(ctx: MenuCtx): MenuItem[] | null {
  const text = ctx.editor?.selectedText ?? ctx.preview?.selectedText
  if (!text) return null
  const line = isSourceMenu(ctx) ? ctx.editor!.line - 1 : ctx.preview?.line
  const items: MenuItem[] = []
  if (!isSourceMenu(ctx) && line !== undefined) items.push(jumpItem(ctx, line, false))
  items.push(
    copyItem(ctx, 'copy-selection', t('common.copy'), text, items.length > 0),
    {
      id: 'create-from-selection',
      label: t('contextmenu.create_note_from_selection'),
      icon: <Plus size={14} />,
      onSelect: () => ctx.onCreateNote({ title: text.trim().slice(0, 200), open: true }),
    },
  )
  // Only the editor's own selection: a format command runs wherever the CodeMirror cursor is, which
  // in a split view is not the text that was just right-clicked in the preview.
  if (isSourceMenu(ctx)) {
    const format = formatMenuItems(command => ctx.runCommand(command))
    items.push({ id: 'format', label: t('workspace.more_formats'), icon: <CaseUpper size={14} />, separatorBefore: true, subItems: format, submenu: submenuFor(format, 200) })
  }
  return items
}
