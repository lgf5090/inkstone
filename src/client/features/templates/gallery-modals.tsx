import { useEffect, useId, useRef, useState } from 'react'
import { Check, Upload } from 'lucide-react'
import type { NoteTemplate, NoteTemplateCategory } from '@shared/types'
import { TEMPLATE_IMPORT_LIMITS, parseTemplateLibraryExport } from '@shared/note-templates'
import { EMPTY_DRAFT, splitTagInput, type TemplateDraft } from './gallery-persist'
import { cn } from '../../lib/cn'
import { Button } from '../../components/primitives'
import { Field, Input, Select, Textarea } from '../../components/form'
import { Modal } from '../../components/overlay'
import { FolderColorMenu, FolderIconMenu } from '../folders/FolderAppearanceMenus'
import { useNoteTemplates } from '../../store/note-templates'
import { useUi } from '../../store/ui'
import { t, useLocale } from '../../lib/i18n'

const EDITOR_MODAL_WIDTH = 680
const NARROW_MODAL_WIDTH = 420
const IMPORT_MODAL_WIDTH = 560

export function TemplateEditorModal({ template, initial, categories, onClose }: {
  template: NoteTemplate | null
  initial?: TemplateDraft | null
  categories: NoteTemplateCategory[]
  onClose: () => void
}) {
  const [draft, setDraft] = useState<TemplateDraft>(template
    ? {
      name: template.name,
      description: template.description,
      content: template.content,
      categoryId: template.categoryId,
      tags: template.tags,
    }
    : initial ?? EMPTY_DRAFT)
  const [isError, setIsError] = useState(false)
  const [bodyError, setBodyError] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => { nameRef.current?.focus() }, [])
  const save = () => {
    const missingName = !draft.name.trim()
    const missingBody = !draft.content.trim()
    setIsError(missingName)
    setBodyError(missingBody)
    if (missingName || missingBody) return
    const store = useNoteTemplates.getState()
    if (template) store.updateTemplate(template.id, draft)
    else store.createTemplate(draft)
    onClose()
  }
  return (<Modal open onClose={onClose} title={template ? t('templates.edit_template') : t('templates.create_template')} width={EDITOR_MODAL_WIDTH} footer={<>
      <Button variant='ghost' onClick={onClose}>{t('common.cancel')}</Button>
      <Button variant='primary' onClick={save}>{template ? t('common.save') : t('templates.create_template')}</Button>
    </>}>
    <div className='space-y-4'>
      <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
        <Field label={t('templates.template_name')} required hint={isError ? <span className='text-[var(--danger)]'>{t('templates.name_required')}</span> : undefined}>
          <Input ref={nameRef} invalid={isError} maxLength={TEMPLATE_IMPORT_LIMITS.maxNameLength} value={draft.name} onChange={(event) => {
            setDraft({ ...draft, name: event.target.value })
            setIsError(false)
          }} placeholder={t('templates.template_name')}/>
        </Field>
        <Field label={t('templates.category')}>
          <Select value={draft.categoryId ?? ''} onChange={(event) => setDraft({ ...draft, categoryId: event.target.value || null })}>
            <option value=''>{t('templates.uncategorized')}</option>
            {categories.map((category) => (<option key={category.id} value={category.id}>{category.name}</option>))}
          </Select>
        </Field>
      </div>
      <Field label={t('templates.tags')} hint={t('templates.tag_hint')}>
        <Input value={draft.tags.join(', ')} onChange={(event) => setDraft({ ...draft, tags: splitTagInput(event.target.value) })} placeholder={t('templates.tag_hint')}/>
      </Field>
      <Field label={t('templates.description')}>
        <Input maxLength={TEMPLATE_IMPORT_LIMITS.maxDescriptionLength} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder={t('templates.description')}/>
      </Field>
      <Field label={t('templates.template_content')} hint={bodyError ? <span className='text-[var(--danger)]'>{t('templates.content_required')}</span> : t('templates.template_content_hint')}>
        <Textarea value={draft.content} aria-invalid={bodyError} onChange={(event) => {
          setDraft({ ...draft, content: event.target.value })
          setBodyError(false)
        }} rows={16} spellCheck={false} className='min-h-70 font-mono text-[12.5px]'/>
      </Field>
    </div>
  </Modal>)
}

export function TemplateRenameDialog({ template, onClose }: {
  template: NoteTemplate
  onClose: () => void
}) {
  const [name, setName] = useState(template.name)
  const [isError, setIsError] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])
  const save = () => {
    if (!name.trim()) {
      setIsError(true)
      return
    }
    useNoteTemplates.getState().updateTemplate(template.id, { name })
    onClose()
  }
  return (<Modal open onClose={onClose} title={t('templates.rename_template')} width={NARROW_MODAL_WIDTH} footer={<>
      <Button variant='ghost' onClick={onClose}>{t('common.cancel')}</Button>
      <Button variant='primary' onClick={save}>{t('common.save')}</Button>
    </>}>
    <Field label={t('templates.template_name')} required hint={isError ? <span className='text-[var(--danger)]'>{t('templates.name_required')}</span> : undefined}>
      <Input ref={inputRef} invalid={isError} maxLength={TEMPLATE_IMPORT_LIMITS.maxNameLength} value={name} onChange={(event) => {
        setName(event.target.value)
        setIsError(false)
      }} onKeyDown={(event) => { if (event.key === 'Enter') save(); }} placeholder={t('templates.template_name')}/>
    </Field>
  </Modal>)
}

export function MoveTemplateDialog({ template, categories, onClose }: {
  template: NoteTemplate
  categories: NoteTemplateCategory[]
  onClose: () => void
}) {
  const move = (categoryId: string | null) => {
    if (categoryId !== template.categoryId)
      useNoteTemplates.getState().updateTemplate(template.id, { categoryId })
    onClose()
  }
  return (<Modal open onClose={onClose} title={t('templates.move_to_category')} width={NARROW_MODAL_WIDTH}>
    <div className='space-y-1'>
      <MoveChoice label={t('templates.uncategorized')} selected={template.categoryId === null} onClick={() => move(null)}/>
      {categories.map((category) => (<MoveChoice key={category.id} label={category.name} selected={template.categoryId === category.id} onClick={() => move(category.id)}/>))}
    </div>
  </Modal>)
}

function MoveChoice({ label, selected, onClick }: {
  label: string
  selected: boolean
  onClick: () => void
}) {
  return (<button type='button' aria-pressed={selected} onClick={onClick} className={cn('flex min-h-10 w-full items-center gap-2.5 rounded-[var(--r-md)] px-2.5 text-left text-[13px] transition-colors', selected ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}>
    <span className='min-w-0 flex-1 truncate'>{label}</span>
    {selected && <Check size={14} className='shrink-0'/>}
  </button>)
}

export function CategoryDialog({ dialog, onClose }: {
  dialog: { mode: 'create' } | { mode: 'rename'; category: NoteTemplateCategory }
  onClose: () => void
}) {
  const existing = dialog.mode === 'rename' ? dialog.category : null
  const [name, setName] = useState(existing?.name ?? '')
  const [icon, setIcon] = useState<string | null>(existing?.icon ?? null)
  const [color, setColor] = useState<string | null>(existing?.color ?? null)
  const [isError, setIsError] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])
  const save = () => {
    if (!name.trim()) {
      setIsError(true)
      return
    }
    const store = useNoteTemplates.getState()
    if (existing) store.renameCategory(existing.id, name, icon, color)
    else store.createCategory(name, icon, color)
    onClose()
  }
  return (<Modal open onClose={onClose} title={dialog.mode === 'rename' ? t('templates.rename_category') : t('templates.new_category')} width={NARROW_MODAL_WIDTH} footer={<>
      <Button variant='ghost' onClick={onClose}>{t('common.cancel')}</Button>
      <Button variant='primary' onClick={save}>{t('common.save')}</Button>
    </>}>
    <Field label={t('templates.category_name')} required hint={isError ? <span className='text-[var(--danger)]'>{t('templates.name_required')}</span> : undefined}>
      <Input ref={inputRef} invalid={isError} maxLength={TEMPLATE_IMPORT_LIMITS.maxNameLength} value={name} onChange={(event) => {
        setName(event.target.value)
        setIsError(false)
      }} onKeyDown={(event) => { if (event.key === 'Enter') save(); }} placeholder={t('templates.category_name')}/>
    </Field>
    <div className='flex flex-wrap gap-2 pt-1'>
      <FolderIconMenu icon={icon} onSelectIcon={(value) => setIcon(value)}/>
      <FolderColorMenu color={color} onSelectColor={setColor}/>
    </div>
  </Modal>)
}

export function ImportTemplatesModal({ onClose }: {
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const [isError, setIsError] = useState(false)
  const errorId = useId()
  const fileRef = useRef<HTMLInputElement>(null)
  const importJson = () => {
    const parsed = parseTemplateLibraryExport(text)
    if (!parsed.data) {
      setIsError(true)
      return
    }
    const { imported, skipped } = useNoteTemplates.getState().importTemplates(parsed.data)
    useUi.getState().toast({
      title: t('templates.import_summary_value0_dup_value1_bad_value2', {
        value0: imported,
        value1: skipped,
        value2: parsed.dropped,
      }),
      description: parsed.truncated ? t('templates.import_fields_truncated') : undefined,
      tone: imported ? 'success' : 'danger',
    })
    onClose()
  }
  const pickFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    // Reading the whole file into a string first, so an oversized drop fails
    // here instead of freezing the tab on JSON.parse.
    if (file.size > TEMPLATE_IMPORT_LIMITS.maxTextLength) {
      setIsError(true)
      useUi.getState().toast({ title: t('templates.import_file_too_large'), tone: 'danger' })
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      setText(String(reader.result ?? ''))
      setIsError(false)
    }
    reader.readAsText(file)
  }
  return (<Modal open onClose={onClose} title={t('templates.import_title')} width={IMPORT_MODAL_WIDTH} footer={<>
      <Button variant='ghost' onClick={onClose}>{t('common.cancel')}</Button>
      <Button variant='primary' onClick={importJson} disabled={!text.trim()}>{t('templates.import_templates')}</Button>
    </>}>
    <div className='space-y-3'>
      <p className='text-[12px] leading-relaxed text-[var(--text-tertiary)]'>{t('templates.import_hint')}</p>
      <Textarea value={text} aria-invalid={isError} aria-describedby={isError ? errorId : undefined} id={errorId} onChange={(event) => {
        setText(event.target.value)
        setIsError(false)
      }} rows={10} spellCheck={false} placeholder={t('templates.import_paste_placeholder')} className='min-h-45 font-mono text-[12px]'/>
      {isError && <p id={errorId} className='text-[11.5px] text-[var(--danger)]'>{t('templates.import_invalid')}</p>}
      <input ref={fileRef} type='file' accept='.json,application/json' className='hidden' onChange={pickFile}/>
      <Button variant='secondary' icon={<Upload size={13}/>} onClick={() => fileRef.current?.click()}>{t('templates.import_file')}</Button>
    </div>
  </Modal>)
}

export function BatchMoveDialog({ categories, onMove, onClose }: {
  categories: NoteTemplateCategory[]
  onMove: (categoryId: string | null) => void
  onClose: () => void
}) {
  return (<Modal open onClose={onClose} title={t('templates.move_to_category')} width={NARROW_MODAL_WIDTH}>
    <div className='space-y-1'>
      <MoveChoice label={t('templates.uncategorized')} selected={false} onClick={() => onMove(null)}/>
      {categories.map((category) => (<MoveChoice key={category.id} label={category.name} selected={false} onClick={() => onMove(category.id)}/>))}
    </div>
  </Modal>)
}

export function TemplatePreviewModal({ template, categoryName, onUse, onClose }: {
  template: NoteTemplate
  categoryName: string
  onUse: () => void
  onClose: () => void
}) {
  useLocale()
  const lines = template.content.split('\n')
  return (<Modal open onClose={onClose} title={template.name} description={categoryName} width={EDITOR_MODAL_WIDTH} ariaLabel={template.name} footer={<>
    <Button variant='ghost' onClick={onClose}>{t('common.close')}</Button>
    <Button variant='primary' onClick={onUse}>{t('templates.use_template')}</Button>
  </>}>
    <div className='space-y-2'>
      {template.description && <p className='text-[12px] leading-relaxed text-[var(--text-tertiary)]'>{template.description}</p>}
      {template.tags.length > 0 && (<div className='flex flex-wrap gap-1'>
        {template.tags.map((tag) => (<span key={tag} className='rounded-full bg-[var(--bg-raised)] px-1.5 py-px text-[10px] text-[var(--text-tertiary)]'>#{tag}</span>))}
      </div>)}
      <pre className='max-h-[min(46vh,420px)] overflow-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3 text-[11.5px] leading-relaxed whitespace-pre font-mono text-[var(--text-secondary)]'>{template.content}</pre>
      <p className='text-[11px] text-[var(--text-quaternary)]'>{t('templates.preview_lines_value0', { value0: lines.length })}</p>
    </div>
  </Modal>)
}
