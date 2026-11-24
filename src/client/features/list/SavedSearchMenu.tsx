import { useRef, useState } from 'react'
import { Bookmark, Plus, Trash2 } from 'lucide-react'
import { IconButton } from '../../components/primitives'
import { Menu, confirm, prompt, type MenuItem } from '../../components/overlay'
import { t } from '../../lib/i18n'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { removeNoteSearch, saveNoteSearch } from './saved-searches'

export function SavedSearchMenu() {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const settings = useSession((state) => state.settings)
  const updateSettings = useSession((state) => state.updateSettings)
  const query = useUi((state) => state.searchQuery)
  const openSearchList = useUi((state) => state.openSearchList)
  const toast = useUi((state) => state.toast)
  const saved = settings.search.savedSearches ?? []

  const persist = async (next: typeof saved) => {
    try {
      await updateSettings({ search: { ...settings.search, savedSearches: next } })
    }
    catch (error) {
      toast({
        title: t('notes.saved_search_failed'),
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      })
    }
  }

  const saveCurrent = async () => {
    const name = await prompt({
      title: t('notes.save_search'),
      description: query.trim(),
      placeholder: t('notes.saved_search_name'),
    })
    if (!name?.trim() || !query.trim()) return
    await persist(saveNoteSearch(saved, crypto.randomUUID(), name, query))
  }

  const remove = async (id: string, name: string) => {
    const accepted = await confirm({
      title: t('notes.delete_saved_search', { value0: name }),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (accepted) await persist(removeNoteSearch(saved, id))
  }

  const items: MenuItem[] = [
    ...saved.map((item) => ({
      id: item.id,
      label: item.name,
      icon: <Bookmark size={13}/>,
      onSelect: () => {
        setOpen(false)
        openSearchList(item.query)
      },
    })),
    {
      id: 'save-current',
      label: t('notes.save_search'),
      icon: <Plus size={13}/>,
      separatorBefore: true,
      disabled: !query.trim(),
      onSelect: () => void saveCurrent(),
    },
    ...(saved.length ? [{
      id: 'delete-saved',
      label: t('notes.delete_saved_search_menu'),
      icon: <Trash2 size={13}/>,
      separatorBefore: true,
      subItems: saved.map((item) => ({
        id: `delete:${item.id}`,
        label: item.name,
        onSelect: () => void remove(item.id, item.name),
      })),
    }] : []),
  ]

  return (
    <>
      <IconButton ref={anchorRef} label={t('notes.saved_searches')} size="sm" onClick={() => setOpen(true)}>
        <Bookmark size={14}/>
      </IconButton>
      <Menu anchor={anchorRef} open={open} onClose={() => setOpen(false)} items={items} align="end" width={260}/>
    </>
  )
}
