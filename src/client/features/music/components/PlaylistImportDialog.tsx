import { useId, useState, type FormEvent, type ReactElement } from 'react'
import { Button } from '../../../components/primitives'
import { Input } from '../../../components/form'
import { Modal } from '../../../components/overlay'
import { useUi } from '../../../store/ui'
import { useMusicLibrary } from '../store/library'
import {
  PlaylistImportError,
  importNeteasePlaylist,
  parseNeteasePlaylistId,
} from '../playlist-import'
import { musicText } from './labels'

/** Paste a Netease playlist link or id and collect it as one local playlist. */
export function PlaylistImportDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean
  onClose: () => void
  onImported: (playlistId: string) => void
}): ReactElement {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputId = useId()

  const close = (): void => {
    if (busy) return
    setValue('')
    setError(null)
    onClose()
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busy) return
    if (!parseNeteasePlaylistId(value)) {
      setError(musicText('music.import.invalid'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await importNeteasePlaylist(value, musicText('music.import.default_name'))
      await useMusicLibrary.getState().load()
      useUi.getState().toast({
        title: result.truncated
          ? musicText('music.import.partial', { count: result.imported })
          : musicText('music.import.success', {
            name: result.playlist.name,
            count: result.imported,
          }),
        tone: result.truncated ? 'warning' : 'success',
      })
      setValue('')
      onImported(result.playlist.id)
      onClose()
    } catch (reason) {
      if (reason instanceof PlaylistImportError) {
        setError(musicText(reason.reason === 'invalid' ? 'music.import.invalid' : 'music.import.empty'))
      } else {
        setError(musicText('music.import.failed', {
          detail: reason instanceof Error ? reason.message : String(reason),
        }))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={musicText('music.import.title')}
      description={musicText('music.import.description')}
      width={520}
      dismissible={!busy}
    >
      <form className="flex flex-col gap-[var(--sp-3)]" onSubmit={(event) => { void submit(event) }}>
        <div className="flex flex-col gap-[var(--sp-1)]">
          <label htmlFor={inputId} className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
            {musicText('music.import.input_label')}
          </label>
          <Input
            id={inputId}
            placeholder={musicText('music.import.placeholder')}
            value={value}
            maxLength={2048}
            disabled={busy}
            onChange={(event) => setValue(event.target.value)}
          />
        </div>
        {busy && (
          <p role="status" className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {musicText('music.import.busy')}
          </p>
        )}
        {error && (
          <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-[var(--sp-2)]">
          <Button variant="ghost" size="sm" type="button" disabled={busy} onClick={close}>
            {musicText('common.cancel')}
          </Button>
          <Button variant="primary" size="sm" type="submit" loading={busy} disabled={!value.trim()}>
            {musicText('music.import.action')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
