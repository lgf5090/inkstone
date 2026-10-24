import { useRef, useState, type ChangeEvent, type FormEvent, type ReactElement } from 'react'
import { ClipboardPaste, FileDown, FileUp } from 'lucide-react'
import type { MusicTrack } from '@shared/music/model'
import { Button } from '../../../components/primitives'
import { Textarea } from '../../../components/form'
import { Modal } from '../../../components/overlay'
import { useUi } from '../../../store/ui'
import { useMusicPlayer } from '../store/player'
import { buildM3U, matchM3UTracks, parseM3U } from '../m3u'
import { musicText } from './labels'

const MAX_M3U_BYTES = 1024 * 1024

export function M3UActions({
  tracks,
  className,
}: {
  tracks: readonly MusicTrack[]
  className?: string
}): ReactElement {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [paste, setPaste] = useState('')

  const exportList = (): void => {
    const blob = new Blob([buildM3U(tracks)], { type: 'audio/x-mpegurl;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'inkstone-music.m3u8'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const importText = async (text: string): Promise<boolean> => {
    const entries = parseM3U(text)
    const result = matchM3UTracks(entries, tracks)
    if (result.matched.length === 0) {
      useUi.getState().toast({
        title: musicText('music.m3u.empty'),
        description: result.unmatched > 0
          ? musicText('music.m3u.unmatched', { count: result.unmatched })
          : undefined,
        tone: 'warning',
      })
      return false
    }
    for (const track of result.matched) useMusicPlayer.getState().appendToQueue(track)
    useUi.getState().toast({
      title: musicText('music.m3u.imported', { count: result.matched.length }),
      description: result.unmatched > 0
        ? musicText('music.m3u.unmatched', { count: result.unmatched })
        : undefined,
      tone: result.unmatched > 0 ? 'warning' : 'success',
    })
    return true
  }

  const importFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > MAX_M3U_BYTES) {
      useUi.getState().toast({ title: musicText('music.m3u.too_large'), tone: 'warning' })
      return
    }
    setBusy(true)
    try {
      await importText(await file.text())
    } catch (error) {
      useUi.getState().toast({
        title: musicText('music.m3u.failed'),
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      })
    } finally {
      setBusy(false)
    }
  }

  const submitPaste = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!paste.trim() || busy) return
    setBusy(true)
    try {
      if (await importText(paste)) {
        setPaste('')
        setPasteOpen(false)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={className ? `flex flex-wrap items-center gap-[var(--sp-2)] ${className}` : 'flex flex-wrap items-center gap-[var(--sp-2)]'}>
      <input
        ref={input}
        type="file"
        accept=".m3u,.m3u8,audio/x-mpegurl,text/plain"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => { void importFile(event) }}
      />
      <Button
        variant="secondary"
        size="sm"
        icon={<FileUp size={13} />}
        loading={busy}
        disabled={tracks.length === 0}
        onClick={() => input.current?.click()}
      >
        {musicText('music.m3u.import')}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        icon={<ClipboardPaste size={13} />}
        disabled={tracks.length === 0}
        onClick={() => setPasteOpen(true)}
      >
        {musicText('music.m3u.paste')}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        icon={<FileDown size={13} />}
        disabled={tracks.length === 0}
        onClick={exportList}
      >
        {musicText('music.m3u.export')}
      </Button>

      <Modal
        open={pasteOpen}
        onClose={() => {
          if (!busy) setPasteOpen(false)
        }}
        title={musicText('music.m3u.paste_title')}
        description={musicText('music.m3u.paste_hint')}
        width={520}
        dismissible={!busy}
      >
        <form className="flex flex-col gap-[var(--sp-3)]" onSubmit={(event) => { void submitPaste(event) }}>
          <Textarea
            value={paste}
            rows={8}
            maxLength={200_000}
            disabled={busy}
            aria-label={musicText('music.m3u.paste')}
            placeholder={musicText('music.m3u.paste_placeholder')}
            onChange={(event) => setPaste(event.target.value)}
          />
          <div className="flex justify-end gap-[var(--sp-2)]">
            <Button variant="ghost" size="sm" type="button" disabled={busy} onClick={() => setPasteOpen(false)}>
              {musicText('common.cancel')}
            </Button>
            <Button variant="primary" size="sm" type="submit" loading={busy} disabled={!paste.trim()}>
              {musicText('music.m3u.paste_action')}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
