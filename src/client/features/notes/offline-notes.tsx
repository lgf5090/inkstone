import { CloudDownload, CloudOff } from 'lucide-react'
import { OFFLINE_NOTES_MAX } from '@shared/constants'
import type { NoteSummary } from '@shared/types'
import type { MenuItem } from '../../components/overlay'
import { api } from '../../lib/api'
import { localDb } from '../../lib/db'
import { t } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'

export function toggleOfflineNoteId(current: readonly string[], id: string, pinned: boolean): string[] {
  const next = new Set(current)
  if (pinned) next.add(id)
  else next.delete(id)
  return [...next].slice(0, OFFLINE_NOTES_MAX)
}

async function persistOfflineIds(ids: string[]): Promise<void> {
  const session = useSession.getState()
  await session.updateSettings({ notes: { ...session.settings.notes, offlineNoteIds: ids } })
}

export async function pinNoteForOffline(id: string): Promise<void> {
  const note = useNotes.getState().notes[id]
  if (!note || note.isEncrypted || note.deletedAt) return
  try {
    const full = await api.notes.get(id)
    await localDb.setContent(id, { content: full.content, rev: full.rev, updatedAt: full.updatedAt })
    const current = useSession.getState().settings.notes.offlineNoteIds ?? []
    await persistOfflineIds(toggleOfflineNoteId(current, id, true))
    useUi.getState().toast({ title: t('notes.offline_pinned'), tone: 'success' })
  }
  catch (error) {
    useUi.getState().toast({
      title: t('notes.offline_pin_failed'),
      description: error instanceof Error ? error.message : String(error),
      tone: 'danger',
    })
  }
}

export async function unpinNoteForOffline(id: string): Promise<void> {
  try {
    const current = useSession.getState().settings.notes.offlineNoteIds ?? []
    await persistOfflineIds(toggleOfflineNoteId(current, id, false))
  }
  catch (error) {
    useUi.getState().toast({
      title: t('notes.offline_unpin_failed'),
      description: error instanceof Error ? error.message : String(error),
      tone: 'danger',
    })
  }
}

export async function prefetchOfflineNotes(ids: readonly string[]): Promise<void> {
  const contents = useNotes.getState().contents
  const missing = ids.filter((id) => contents[id] === undefined && useNotes.getState().notes[id] && !useNotes.getState().notes[id]?.isEncrypted)
  for (let offset = 0; offset < missing.length; offset += 4) {
    await Promise.all(missing.slice(offset, offset + 4).map(async (id) => {
      try {
        const note = await api.notes.get(id)
        await localDb.setContent(id, { content: note.content, rev: note.rev, updatedAt: note.updatedAt })
      }
      catch (error) {
        console.warn('[inkstone] Offline note prefetch failed:', id, error)
      }
    }))
  }
}

export function offlineNoteMenuItems(note: NoteSummary): MenuItem[] {
  if (note.deletedAt || note.isEncrypted) return []
  const pinned = (useSession.getState().settings.notes.offlineNoteIds ?? []).includes(note.id)
  return [{
    id: pinned ? 'offline-unpin' : 'offline-pin',
    label: t(pinned ? 'notes.offline_unpin' : 'notes.offline_pin'),
    icon: pinned ? <CloudOff size={13}/> : <CloudDownload size={13}/>,
    separatorBefore: true,
    onSelect: () => void (pinned ? unpinNoteForOffline(note.id) : pinNoteForOffline(note.id)),
  }]
}
