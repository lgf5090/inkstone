import type { EditorView } from '@codemirror/view'
import type { MenuItem } from '../components/overlay'
import { prompt, submenuFor } from '../components/overlay'
import { t } from '../lib/i18n'
import { editorCombo } from './shortcuts'
import {
  clearInlineFormatting,
  convertCase,
  convertWidth,
  lineTool,
  numberLines,
  toggleSubscript,
  toggleSuperscript,
  toggleUnderline,
  wrapLines,
} from './text-format'
import {
  generateMindmapFromOutline,
  formatCodeBlock,
  insertAlign,
  insertAdvancedCodeBlock,
  insertBlockId,
  insertCallout,
  insertCodeBlock,
  insertColumns,
  insertDetails,
  insertDiagramCode,
  insertFootnote,
  insertFrontMatter,
  insertHorizontalRule,
  insertImage,
  insertLink,
  insertMathBlock,
  insertMediaLayout,
  insertNoteTemplate,
  insertRunnableJsBlock,
  insertTable,
  insertTabs,
  insertTag,
  insertTimeline,
  setHeading,
  toggleBlockReference,
  toggleBold,
  toggleBulletList,
  toggleItalic,
  toggleComment,
  toggleHighlight,
  toggleInlineCode,
  toggleInlineMath,
  toggleNoteEmbed,
  toggleOrderedList,
  toggleQuote,
  toggleStrikethrough,
  toggleTaskList,
  toggleWikiLink,
  unwrapMediaLayoutHere,
  wrapLinesAsMediaLayout,
} from './commands'
import { CHART_TEMPLATES, DATAVIEW_JS_BODY, DATAVIEW_TEMPLATES, KANBAN_TEMPLATES, MERMAID_TEMPLATES, MINDMAP_TEMPLATES, type DiagramTemplate } from './diagram-templates'
import { openEmojiPicker } from '../store/emoji-picker'
import { AlignCenter, AlignLeft, Bold, Braces, CaseUpper, ChevronDown, Code, Columns3, Eraser, FileCode, FileText, GitCommitVertical, Highlighter, Image as ImageIcon, Italic, Link2, List, ListOrdered, ListTree, ListTodo, Minus, Plus, Quote, Sigma, Sparkles, SquarePen, Strikethrough, Subscript, Superscript, Table as TableIcon, Underline } from 'lucide-react'
import { openLinkAtCursor } from '../features/links/use-link-editor'

/**
 * The editor's command lists in one place.
 *
 * The toolbar shows them as seven dropdowns and the context menu folds them into one Insert submenu;
 * both are built here from the same rows so a new block family is registered once. A caller supplies
 * `run`, which is where each surface decides what "pressing" means — the toolbar closes its own menu
 * first, the context menu closes the whole panel after.
 */
export type RunEditorCommand = (command: (target: EditorView) => boolean) => void

const diagramSubmenu = (run: RunEditorCommand, family: string, opening: string, templates: DiagramTemplate[], width: number) => {
  const items: MenuItem[] = templates.map((template) => ({
    id: `${family}-${template.id}`,
    label: t(template.labelKey),
    onSelect: () => run(insertDiagramCode(opening, template.body)),
  }))
  return { items, submenu: submenuFor(items, width) }
}

export function headingMenuItems(run: RunEditorCommand): MenuItem[] {
  return [
    { id: 'paragraph', label: t('workspace.paragraph'), combo: editorCombo('paragraph'), onSelect: () => run(setHeading(0)) },
    ...[1, 2, 3, 4, 5, 6].map((level) => ({
      id: `h${level}`,
      label: t('workspace.heading_value0', { value0: level }),
      combo: editorCombo(`h${level}`),
      separatorBefore: level === 1,
      onSelect: () => run(setHeading(level)),
    })),
  ]
}

/**
 * Everything the toolbar has no room for a button of its own: the tag-wrapping formats, the case and
 * width rewriters, and the line tidy-up. The two colour channels sit next to this on the toolbar
 * because they need a palette, not a list.
 */
export function formatMenuItems(run: RunEditorCommand): MenuItem[] {
  const caseItems: MenuItem[] = ([
    ['upper', 'workspace.case_upper'],
    ['lower', 'workspace.case_lower'],
    ['title', 'workspace.case_title'],
    ['sentence', 'workspace.case_sentence'],
    ['inverse', 'workspace.case_inverse'],
  ] as const).map(([mode, key]) => ({ id: `case-${mode}`, label: t(key), onSelect: () => run(convertCase(mode)) }))
  const tidyItems: MenuItem[] = [
    { id: 'trim-line-ends', label: t('workspace.trim_line_ends'), onSelect: () => run(lineTool('trim-end')) },
    { id: 'trim-whole-lines', label: t('workspace.trim_whole_lines'), onSelect: () => run(lineTool('trim-lines')) },
    { id: 'compress-spaces', label: t('workspace.compress_spaces'), onSelect: () => run(lineTool('compress-spaces')) },
    { id: 'join-lines', label: t('workspace.join_lines'), separatorBefore: true, onSelect: () => run(lineTool('join-lines')) },
    { id: 'blank-lines-between', label: t('workspace.blank_lines_between'), onSelect: () => run(lineTool('blank-lines-between')) },
    { id: 'remove-blank-lines', label: t('workspace.remove_blank_lines'), onSelect: () => run(lineTool('remove-blank-lines')) },
    { id: 'dedupe-lines', label: t('workspace.dedupe_lines'), onSelect: () => run(lineTool('dedupe-lines')) },
    {
      id: 'number-lines',
      label: t('workspace.number_lines'),
      separatorBefore: true,
      onSelect: () => {
        void prompt({ title: t('workspace.number_lines'), description: t('workspace.number_lines_prompt'), defaultValue: '{n}. ', placeholder: '{n}. ', preserveSpaces: true }).then((template) => {
          if (template !== null)
            run(numberLines(template));
        });
      },
    },
    {
      id: 'prefix-suffix',
      label: t('workspace.prefix_suffix'),
      onSelect: () => {
        void prompt({ title: t('workspace.prefix_suffix'), description: t('workspace.prefix_prompt'), placeholder: '- ', preserveSpaces: true }).then((prefix) => {
          if (prefix === null)
            return;
          void prompt({ title: t('workspace.prefix_suffix'), description: t('workspace.suffix_prompt'), placeholder: ' :' , preserveSpaces: true }).then((suffix) => {
            if (suffix !== null)
              run(wrapLines(prefix, suffix));
          });
        });
      },
    },
  ]
  return [
    { id: 'bold', label: t('common.bold'), icon: <Bold size={13} />, combo: editorCombo('bold'), onSelect: () => run(toggleBold) },
    { id: 'italic', label: t('common.italic'), icon: <Italic size={13} />, combo: editorCombo('italic'), onSelect: () => run(toggleItalic) },
    { id: 'underline', label: t('common.underline'), icon: <Underline size={13} />, combo: editorCombo('underline'), onSelect: () => run(toggleUnderline) },
    { id: 'strikethrough', label: t('common.strikethrough'), icon: <Strikethrough size={13} />, combo: editorCombo('strikethrough'), onSelect: () => run(toggleStrikethrough) },
    { id: 'superscript', label: t('workspace.superscript'), icon: <Superscript size={13} />, onSelect: () => run(toggleSuperscript) },
    { id: 'subscript', label: t('workspace.subscript'), icon: <Subscript size={13} />, onSelect: () => run(toggleSubscript) },
    { id: 'highlight', label: t('common.highlight'), icon: <Highlighter size={13} />, onSelect: () => run(toggleHighlight) },
    { id: 'inline-code', label: t('common.inline_code'), icon: <Code size={13} />, combo: editorCombo('inline-code'), onSelect: () => run(toggleInlineCode) },
    { id: 'inline-math', label: t('workspace.inline_math'), icon: <Sigma size={13} />, onSelect: () => run(toggleInlineMath) },
    { id: 'clear-formatting', label: t('workspace.clear_formatting'), icon: <Eraser size={13} />, separatorBefore: true, onSelect: () => run(clearInlineFormatting) },
    { id: 'case', label: t('workspace.case_change'), icon: <CaseUpper size={13} />, subItems: caseItems, submenu: submenuFor(caseItems, 168) },
    { id: 'width-full', label: t('workspace.width_full'), separatorBefore: true, onSelect: () => run(convertWidth('full')) },
    { id: 'width-half', label: t('workspace.width_half'), onSelect: () => run(convertWidth('half')) },
    { id: 'tidy', label: t('workspace.line_tidy'), icon: <AlignLeft size={13} />, separatorBefore: true, subItems: tidyItems, submenu: submenuFor(tidyItems, 196) },
  ]
}

export function listMenuItems(run: RunEditorCommand): MenuItem[] {
  return [
    { id: 'bullet', label: t('common.unordered_list'), icon: <List size={13} />, combo: editorCombo('bullet-list'), onSelect: () => run(toggleBulletList) },
    { id: 'ordered', label: t('common.ordered_list'), icon: <ListOrdered size={13} />, combo: editorCombo('ordered-list'), onSelect: () => run(toggleOrderedList) },
    { id: 'task', label: t('common.task_list'), icon: <ListTodo size={13} />, combo: editorCombo('task-list'), onSelect: () => run(toggleTaskList) },
    { id: 'quote', label: t('common.quote'), icon: <Quote size={13} />, combo: editorCombo('quote'), onSelect: () => run(toggleQuote) },
    { id: 'callout', label: t('workspace.callout'), icon: <Sparkles size={13} />, onSelect: () => run(insertCallout) },
  ]
}

export function referenceMenuItems(run: RunEditorCommand): MenuItem[] {
  return [
    { id: 'link', label: t('workspace.link'), combo: editorCombo('link'), onSelect: () => run(insertLink()) },
    { id: 'link-editor', label: t('workspace.link_editor'), icon: <SquarePen size={13} />, combo: editorCombo('link-editor'), separatorBefore: true, onSelect: () => run(openLinkAtCursor) },
    { id: 'wiki-link', label: t('common.wiki_links'), onSelect: () => run(toggleWikiLink) },
    { id: 'note-embed', label: t('workspace.note_embed'), onSelect: () => run(toggleNoteEmbed) },
    { id: 'block-reference', label: t('workspace.block_reference'), onSelect: () => run(toggleBlockReference) },
    { id: 'footnote', label: t('workspace.footnote'), separatorBefore: true, onSelect: () => run(insertFootnote) },
  ]
}

export function imageMenuItems(run: RunEditorCommand, pickImage: () => void): MenuItem[] {
  return [
    { id: 'upload-image', label: t('workspace.upload_image'), onSelect: pickImage },
    { id: 'remote-image', label: t('workspace.remote_image'), onSelect: () => run(insertImage()) },
  ]
}

export function noteMenuItems(run: RunEditorCommand): MenuItem[] {
  return [
    { id: 'emoji', label: t('emoji.insert'), onSelect: () => run(() => {
          openEmojiPicker();
          return true;
        }) },
    { id: 'tag', label: t('workspace.insert_tag'), onSelect: () => run(insertTag) },
    { id: 'block-id', label: t('workspace.block_id'), onSelect: () => run(insertBlockId) },
    { id: 'front-matter', label: t('workspace.front_matter'), separatorBefore: true, onSelect: () => run(insertFrontMatter) },
    { id: 'note-template', label: t('editor.insert_note_template'), onSelect: () => run(insertNoteTemplate) },
    { id: 'comment', label: t('workspace.hidden_comment'), combo: editorCombo('comment'), separatorBefore: true, onSelect: () => run(toggleComment) },
  ]
}

export function codeMenuItems(run: RunEditorCommand): MenuItem[] {
  const mermaid = diagramSubmenu(run, 'mermaid', '```mermaid', MERMAID_TEMPLATES, 190)
  const chart = diagramSubmenu(run, 'chart', '```chart style=table', CHART_TEMPLATES, 180)
  const mindmap = diagramSubmenu(run, 'mindmap', '```mindmap', MINDMAP_TEMPLATES, 180)
  const kanban = diagramSubmenu(run, 'kanban', '```kanban', KANBAN_TEMPLATES, 180)
  const dataview = diagramSubmenu(run, 'dataview', '```dataview', DATAVIEW_TEMPLATES, 190)
  return [
    { id: 'code', label: t('workspace.code_block'), onSelect: () => run(insertCodeBlock) },
    { id: 'advanced-code', label: t('workspace.enhanced_code_block'), onSelect: () => run(insertAdvancedCodeBlock) },
    { id: 'js-example', label: t('workspace.runnable_js_block'), onSelect: () => run(insertRunnableJsBlock) },
    { id: 'mermaid', label: t('workspace.mermaid_diagram'), separatorBefore: true, subItems: mermaid.items, submenu: mermaid.submenu },
    { id: 'chart', label: t('workspace.chartjs_diagram'), subItems: chart.items, submenu: chart.submenu },
    { id: 'mindmap', label: t('workspace.mind_map'), subItems: mindmap.items, submenu: mindmap.submenu },
    { id: 'kanban', label: t('workspace.kanban_board'), subItems: kanban.items, submenu: kanban.submenu },
    { id: 'dataview', label: t('workspace.dataview_query'), subItems: dataview.items, submenu: dataview.submenu },
    { id: 'dataview-js', label: t('workspace.dataview_js'), onSelect: () => run(insertDiagramCode('\`\`\`dataviewjs', DATAVIEW_JS_BODY)) },
    { id: 'mindmap-from-outline', label: t('workspace.mindmap_from_outline'), separatorBefore: true, onSelect: () => run(generateMindmapFromOutline) },
    { id: 'format-code', label: t('command.format_code_block'), combo: editorCombo('format-code'), separatorBefore: true, onSelect: () => run(formatCodeBlock) },
  ]
}

export function mathMenuItems(run: RunEditorCommand): MenuItem[] {
  return [
    { id: 'inline-math', label: t('workspace.inline_math'), onSelect: () => run(toggleInlineMath) },
    { id: 'block-math', label: t('workspace.block_math'), onSelect: () => run(insertMathBlock) },
  ]
}

const ALIGN_KEYS = { left: 'workspace.align_left', center: 'workspace.align_center', right: 'workspace.align_right', justify: 'workspace.align_justify' } as const

export function blockMenuItems(run: RunEditorCommand): MenuItem[] {
  const alignItems: MenuItem[] = (Object.keys(ALIGN_KEYS) as (keyof typeof ALIGN_KEYS)[]).map((value) => ({
    id: `align-${value}`,
    label: t(ALIGN_KEYS[value]),
    onSelect: () => run(insertAlign(value)),
  }))
  // One block, three ways in: an empty frame to fill, the lines already chosen, and the frame the cursor
  // is inside. The reference plugin offers the first two as commands and the third as a menu row.
  const mediaLayoutItems: MenuItem[] = [
    { id: 'media-layout-insert', label: t('command.media_layout_insert'), onSelect: () => run(insertMediaLayout) },
    { id: 'media-layout-wrap', label: t('command.media_layout_wrap'), onSelect: () => run(wrapLinesAsMediaLayout) },
    { id: 'media-layout-unwrap', label: t('command.media_layout_unwrap'), onSelect: () => run(unwrapMediaLayoutHere) },
  ]
  return [
    { id: 'table', label: t('workspace.table'), icon: <TableIcon size={13} />, onSelect: () => run(insertTable) },
    { id: 'callout', label: t('workspace.callout'), icon: <Quote size={13} />, onSelect: () => run(insertCallout) },
    { id: 'details', label: t('workspace.details_block'), icon: <ChevronDown size={13} />, onSelect: () => run(insertDetails) },
    { id: 'tabs', label: t('common.tabs'), icon: <ListTree size={13} />, onSelect: () => run(insertTabs) },
    { id: 'columns', label: t('workspace.columns'), icon: <Columns3 size={13} />, onSelect: () => run(insertColumns) },
    {
      id: 'media-layout',
      label: t('workspace.media_layout'),
      icon: <ImageIcon size={13} />,
      onSelect: () => run(insertMediaLayout),
      subItems: mediaLayoutItems,
      submenu: submenuFor(mediaLayoutItems),
    },
    { id: 'timeline', label: t('workspace.timeline'), icon: <GitCommitVertical size={13} />, onSelect: () => run(insertTimeline) },
    {
      id: 'align',
      label: t('workspace.alignment'),
      icon: <AlignCenter size={13} />,
      separatorBefore: true,
      subItems: alignItems,
      submenu: submenuFor(alignItems),
    },
    { id: 'divider', label: t('workspace.divider'), icon: <Minus size={13} />, separatorBefore: true, onSelect: () => run(insertHorizontalRule) },
  ]
}

/** The context menu's single Insert row: every block the editor can write, one level deeper. */
export function insertMenuItem(run: RunEditorCommand, pickImage: () => void, pickFile: () => void): MenuItem {
  // The dropdown is for producing something new. Formatting the block the cursor is already in is an
  // action on an existing block, so it stays on the toolbar's own button and out of this list.
  const code = codeMenuItems(run).filter((item) => item.id !== 'format-code')
  const blocks = blockMenuItems(run)
  const children: MenuItem[] = [
    { id: 'link', label: t('workspace.link'), icon: <Link2 size={13} />, combo: editorCombo('link'), onSelect: () => run(insertLink()) },
    { id: 'image', label: t('workspace.insert_image'), icon: <ImageIcon size={13} />, onSelect: pickImage },
    { id: 'file', label: t('workspace.insert_file'), icon: <FileText size={13} />, onSelect: pickFile },
    ...code.map((item) => (item.id === 'code' ? { ...item, icon: <Braces size={13} /> } : item.id === 'advanced-code' ? { ...item, icon: <FileCode size={13} /> } : item)),
    ...blocks,
    ...mathMenuItems(run),
    ...noteMenuItems(run),
  ]
  return {
    id: 'insert',
    label: t('contextmenu.insert'),
    icon: <Plus size={14} />,
    subItems: children,
    submenu: submenuFor(children, 208),
  }
}

