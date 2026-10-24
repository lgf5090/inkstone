import { useEffect, useId, useState, type FormEvent, type ReactElement } from 'react'
import type { MusicTrack } from '@shared/music/model'
import { Button } from '../../../components/primitives'
import { Input } from '../../../components/form'
import { Modal } from '../../../components/overlay'
import { musicApi } from '../api'
import { musicText } from './labels'

/** Edit the display snapshot of a saved library track; provider identity and bytes stay unchanged. */
export function EditTrackDialog({
  track,
  open,
  onClose,
  onSaved,
}: {
  track: MusicTrack | null
  open: boolean
  onClose: () => void
  onSaved: (track: MusicTrack) => void
}): ReactElement {
  const prefix = useId()
  const [title, setTitle] = useState('')
  const [artist, setArtist] = useState('')
  const [album, setAlbum] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!track) return
    setTitle(track.title)
    setArtist(track.artists.map((entry) => entry.name).join(' / '))
    setAlbum(track.album)
    setError(null)
  }, [track?.id])

  const close = (): void => {
    if (busy) return
    onClose()
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!track || busy) return
    const nextTitle = title.trim()
    if (!nextTitle) {
      setError(musicText('music.edit.title_required'))
      return
    }
    const names = artist.split(/[/,]/).map((value) => value.trim()).filter(Boolean)
    const artists = names.map((name) => track.artists.find((entry) => entry.name === name) ?? { id: '', name })
    setBusy(true)
    setError(null)
    try {
      const answer = await musicApi.updateTrackMetadata(track.id, {
        title: nextTitle,
        artists,
        album: album.trim(),
      })
      onSaved(answer.track)
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={musicText('music.edit.title')}
      description={musicText('music.edit.description')}
      width={520}
      dismissible={!busy}
    >
      <form className="flex flex-col gap-[var(--sp-3)]" onSubmit={(event) => { void submit(event) }}>
        <div className="flex flex-col gap-[var(--sp-1)]">
          <label htmlFor={`${prefix}-title`} className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
            {musicText('music.edit.title_label')}
          </label>
          <Input id={`${prefix}-title`} value={title} maxLength={500} disabled={busy} onChange={(event) => setTitle(event.target.value)} />
        </div>
        <div className="flex flex-col gap-[var(--sp-1)]">
          <label htmlFor={`${prefix}-artist`} className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
            {musicText('music.edit.artist_label')}
          </label>
          <Input id={`${prefix}-artist`} value={artist} maxLength={500} disabled={busy} onChange={(event) => setArtist(event.target.value)} />
        </div>
        <div className="flex flex-col gap-[var(--sp-1)]">
          <label htmlFor={`${prefix}-album`} className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
            {musicText('music.edit.album_label')}
          </label>
          <Input id={`${prefix}-album`} value={album} maxLength={500} disabled={busy} onChange={(event) => setAlbum(event.target.value)} />
        </div>
        {error && (
          <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-[var(--sp-2)]">
          <Button variant="ghost" size="sm" type="button" disabled={busy} onClick={close}>
            {musicText('common.cancel')}
          </Button>
          <Button variant="primary" size="sm" type="submit" loading={busy}>
            {musicText('music.edit.save')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
