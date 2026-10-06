import { useState } from 'react'
import { Send } from 'lucide-react'
import type { NoteTemplate } from '@shared/types'
import { api } from '../../lib/api'
import { useUi } from '../../store/ui'
import { Button, Kbd } from '../../components/primitives'
import { Modal } from '../../components/overlay'
import { t } from '../../lib/i18n'

const HELP_MODAL_WIDTH = 440
const PUBLISH_MODAL_WIDTH = 600

export function KeyboardHelpModal({ onClose }: { onClose: () => void }) {
  const rows: { label: string; keys: string[] }[] = [
    { label: t('templates.help_move'), keys: ['↑', '↓', '←', '→'] },
    { label: t('templates.help_use'), keys: ['Enter'] },
    { label: t('templates.help_star'), keys: ['Ctrl/⌘', 'Click'] },
    { label: t('templates.help_search'), keys: ['/'] },
    { label: t('templates.help_tab'), keys: ['Tab'] },
    { label: t('templates.help_esc'), keys: ['Esc'] },
    { label: t('templates.help_help'), keys: ['?'] },
  ]
  const selectRows: { label: string; keys: string[] }[] = [
    { label: t('templates.help_select_mode'), keys: ['s'] },
    { label: t('templates.help_select_click'), keys: ['Click'] },
    { label: t('templates.help_select_focused'), keys: ['Space'] },
    { label: t('templates.help_select_all'), keys: ['a'] },
  ]
  return (<Modal open onClose={onClose} title={t('templates.keyboard_shortcuts')} width={HELP_MODAL_WIDTH}>
    <div className='divide-y divide-[var(--border-subtle)]'>
      {rows.map((row) => (<div key={row.label} className='flex items-center justify-between gap-3 py-2.5'>
        <span className='text-[12.5px] text-[var(--text-secondary)]'>{row.label}</span>
        <Kbd keys={row.keys}/>
      </div>))}
      <div className='pt-2.5 pb-1 text-[10.5px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]'>{t('templates.help_select_section')}</div>
      {selectRows.map((row) => (<div key={row.label} className='flex items-center justify-between gap-3 py-2.5'>
        <span className='text-[12.5px] text-[var(--text-secondary)]'>{row.label}</span>
        <Kbd keys={row.keys}/>
      </div>))}
    </div>
  </Modal>)
}

export function PublishTemplateDialog({ template, category, onClose, onPublished }: {
  template: NoteTemplate
  category: string
  onClose: () => void
  onPublished: () => void
}) {
  const [isBusy, setIsBusy] = useState(false)
  const publish = async () => {
    if (isBusy) return
    setIsBusy(true)
    try {
      await api.communityTemplates.publish({
        name: template.name,
        description: template.description,
        content: template.content,
        tags: template.tags,
        category,
      })
      useUi.getState().toast({ title: t('templates.community_published'), tone: 'success' })
      onPublished()
    }
    catch {
      useUi.getState().toast({ title: t('common.action_failed'), tone: 'danger' })
    }
    finally {
      setIsBusy(false)
    }
  }
  return (<Modal open onClose={onClose} title={t('templates.publish_to_community')} width={PUBLISH_MODAL_WIDTH} footer={<>
      <Button variant='ghost' onClick={onClose}>{t('common.cancel')}</Button>
      <Button variant='primary' icon={<Send size={13}/>} loading={isBusy} onClick={() => void publish()}>{t('templates.publish_to_community')}</Button>
    </>}>
    <div className='space-y-3'>
      <p className='text-[12px] leading-relaxed text-[var(--text-tertiary)]'>{t('templates.publish_hint')}</p>
      <div className='rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3'>
        <div className='flex items-center gap-1.5'>
          <h3 className='min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--text-primary)]'>{template.name}</h3>
          <span className='shrink-0 text-[10.5px] text-[var(--text-quaternary)]'>{category}</span>
        </div>
        {template.tags.length > 0 && (<div className='mt-1.5 flex flex-wrap items-center gap-1'>
          {template.tags.map((tag) => (<span key={tag} className='rounded-full bg-[var(--bg-raised)] px-1.5 py-px text-[10px] text-[var(--text-tertiary)]'>#{tag}</span>))}
        </div>)}
        {template.description && <p className='mt-1.5 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]'>{template.description}</p>}
        <pre className='mt-2 max-h-55 overflow-y-auto text-[11px] leading-relaxed whitespace-pre-wrap text-[var(--text-secondary)]'>{template.content}</pre>
      </div>
    </div>
  </Modal>)
}
