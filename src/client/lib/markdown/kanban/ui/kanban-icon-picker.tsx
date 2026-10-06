import { useState } from 'react'
import { Smile, Trash2 } from 'lucide-react'
import { t } from '../../../i18n'
import { KANBAN_ICONS } from './kanban-icon-badge'
import { KanbanPanel } from './kanban-panel'

const KANBAN_COMMON_EMOJIS = [
  '📝', '🎯', '🚀', '💡', '📌', '🏷️', '⭐', '☕', '🎨', '📦',
  '🛠️', '✅', '⏳', '🛑', '🔍', '📊', '📈', '💬', '📅', '🐛',
  '🔥', '🎉', '⚡', '💻', '🔒', '📱', '🔔', '✨', '🌐', '📚',
  '💼', '🧠', '🗂️', '🏆', '🧩', '📋', '🔑', '💎', '🌈', '☀️',
] as const

interface KanbanIconPickerProps {
  open: boolean
  panelId: string
  currentIcon?: string | null
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
  onSelectIcon: (icon: string | null) => void
}

function EmojiGrid({
  onSelect,
}: {
  onSelect: (emoji: string) => void
}) {
  // No aria-label: the character is the option, and a reader tool speaks it from its own localised
  // emoji data — a label we ship would replace that answer with one written in two languages.
  return (
    <div
      role='group'
      aria-label={t('preview.kanban_tab_emoji')}
      className='grid max-h-48 grid-cols-8 gap-1 overflow-y-auto p-2'
    >
      {KANBAN_COMMON_EMOJIS.map((emoji) => (
        <button
          key={emoji}
          type='button'
          onClick={() => onSelect(emoji)}
          className='flex size-7 items-center justify-center rounded-[var(--r-sm)] text-[length:var(--text-14)] transition-transform hover:scale-125 hover:bg-[var(--bg-hover)]'
        >
          {emoji}
        </button>
      ))}
    </div>
  )
}

function LucideIconGrid({
  onSelect,
}: {
  onSelect: (iconName: string) => void
}) {
  return (
    <div
      role='group'
      aria-label={t('preview.kanban_tab_icons')}
      className='grid max-h-48 grid-cols-6 gap-1 overflow-y-auto p-2'
    >
      {KANBAN_ICONS.map(({ name, icon: IconComponent, labelKey }) => {
        const label = t(labelKey)
        return (
          <button
            key={name}
            type='button'
            onClick={() => onSelect(`lucide:${name}`)}
            title={label}
            aria-label={label}
            className='flex size-7 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-secondary)] transition-transform hover:scale-110 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
          >
            <IconComponent size={15} />
          </button>
        )
      })}
    </div>
  )
}

function CustomEmojiInput({
  onSelect,
}: {
  onSelect: (emoji: string) => void
}) {
  const [val, setVal] = useState('')
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        const trimmed = val.trim()
        if (trimmed) onSelect(Array.from(trimmed)[0] ?? trimmed)
      }}
      className='flex items-center gap-1.5 border-t border-[var(--border-subtle)] p-2'
    >
      <Smile size={13} className='text-[var(--text-tertiary)]' />
      <input
        type='text'
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder={t('preview.kanban_custom_emoji')}
        className='h-6 flex-1 rounded-[var(--r-xs)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 text-[length:var(--text-11)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]'
      />
    </form>
  )
}

function PickerHeaderTabs({
  tab,
  setTab,
  onRemove,
}: {
  tab: 'emoji' | 'icon'
  setTab: (t: 'emoji' | 'icon') => void
  onRemove: () => void
}) {
  return (
    <div className='flex items-center justify-between border-b border-[var(--border-subtle)] px-2 pt-1'>
      <div className='flex gap-1'>
        <button
          type='button'
          onClick={() => setTab('emoji')}
          className={`border-b-2 px-2 py-1 text-[length:var(--text-11)] font-semibold transition-colors ${
            tab === 'emoji'
              ? 'border-[var(--accent)] text-[var(--accent)]'
              : 'border-transparent text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'
          }`}
        >
          {t('preview.kanban_tab_emoji')}
        </button>
        <button
          type='button'
          onClick={() => setTab('icon')}
          className={`border-b-2 px-2 py-1 text-[length:var(--text-11)] font-semibold transition-colors ${
            tab === 'icon'
              ? 'border-[var(--accent)] text-[var(--accent)]'
              : 'border-transparent text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'
          }`}
        >
          {t('preview.kanban_tab_icons')}
        </button>
      </div>
      <button
        type='button'
        onClick={onRemove}
        title={t('preview.kanban_remove_icon')}
        className='rounded-[var(--r-xs)] p-1 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--danger)]'
      >
        <Trash2 size={12} />
      </button>
    </div>
  )
}

export function KanbanIconPicker({
  open,
  panelId,
  anchorRef,
  onClose,
  onSelectIcon,
}: KanbanIconPickerProps) {
  const [tab, setTab] = useState<'emoji' | 'icon'>('emoji')

  const handleSelect = (val: string) => {
    onSelectIcon(val)
    onClose()
  }

  return (
    <KanbanPanel
      open={open}
      panelId={panelId}
      label={t('preview.kanban_icon_picker')}
      anchorRef={anchorRef}
      onClose={onClose}
      className='z-[var(--z-popover)] w-64 rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] shadow-[var(--shadow-pop)]'
    >
      <PickerHeaderTabs
        tab={tab}
        setTab={setTab}
        onRemove={() => {
          onSelectIcon(null)
          onClose()
        }}
      />
      {tab === 'emoji' ? <EmojiGrid onSelect={handleSelect} /> : <LucideIconGrid onSelect={handleSelect} />}
      <CustomEmojiInput onSelect={handleSelect} />
    </KanbanPanel>
  )
}
