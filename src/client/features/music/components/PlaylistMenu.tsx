/**
 * Everything a local playlist can do, behind one menu shared by the rail row and the detail header.
 *
 * A right-click and the overflow button reach the same list; the row only has to hand the trigger
 * its two handlers. Editors live here rather than on the page so the rail can edit a playlist
 * without first opening it, and every write goes through the library store so the other surface
 * sees the change in the same render.
 */
import { useEffect, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react'
import { FileDown, FileUp, Image as ImageIcon, Pencil, Pin, PinOff, Play, Share2, Trash2 } from 'lucide-react'
import type { MusicPlaylist, MusicTrack } from '@shared/music/model'
import { Button } from '../../../components/primitives'
import { Field, Input, Textarea } from '../../../components/form'
import { Menu, Modal, confirm, type MenuItem } from '../../../components/overlay'
import { copyText } from '../../../lib/clipboard'
import { useUi } from '../../../store/ui'
import { musicApi } from '../api'
import { useMusicLibrary } from '../store/library'
import { useMusicPlayer } from '../store/player'
import { buildM3U } from '../m3u'
import { M3UActions } from './M3UActions'
import { musicText } from './labels'
import { toastFailure } from '../pages/parts/P2QueryState'

export interface PlaylistMenuTriggerProps {
  onClick: (event: ReactMouseEvent<HTMLElement>) => void
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void
  'aria-haspopup': 'menu'
  'aria-expanded': boolean
}

const COVER_MAX_BYTES = 5 * 1024 * 1024
const COVER_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

export function PlaylistMenu({ playlist, onDeleted, onChanged, children }: {
  playlist: MusicPlaylist
  onDeleted?: () => void
  /** A page showing this playlist's tracks can reload once an import lands. */
  onChanged?: () => void
  children: (props: PlaylistMenuTriggerProps) => ReactElement
}): ReactElement {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const toast = useUi((state) => state.toast)
  const updatePlaylist = useMusicLibrary((state) => state.updatePlaylist)
  const deletePlaylist = useMusicLibrary((state) => state.deletePlaylist)
  const sharePlaylist = useMusicLibrary((state) => state.sharePlaylist)

  const loadTracks = async (): Promise<MusicTrack[]> => {
    const tracks: MusicTrack[] = []
    let page = 1
    for (;;) {
      const answer = await musicApi.playlistItems(playlist.id, page)
      tracks.push(...answer.items)
      if (!answer.hasMore || answer.items.length === 0) return tracks
      page += 1
    }
  }

  const play = async (): Promise<void> => {
    setBusy(true)
    try {
      const tracks = await loadTracks()
      const first = tracks[0]
      if (!first) {
        toast({ title: musicText('music.playlist.play_empty'), tone: 'warning' })
        return
      }
      void useMusicPlayer.getState().playTrack(first, { queue: tracks })
    } catch (error) {
      toastFailure(musicText('music.playlist.load_failed'), error)
    } finally {
      setBusy(false)
    }
  }

  const exportM3U = async (): Promise<void> => {
    setBusy(true)
    try {
      const tracks = await loadTracks()
      if (tracks.length === 0) {
        toast({ title: musicText('music.playlist.export_empty'), tone: 'warning' })
        return
      }
      const blob = new Blob([buildM3U(tracks)], { type: 'audio/x-mpegurl;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchorEl = document.createElement('a')
      anchorEl.href = url
      anchorEl.download = `${playlist.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'playlist'}.m3u8`
      anchorEl.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      toastFailure(musicText('music.playlist.load_failed'), error)
    } finally {
      setBusy(false)
    }
  }

  const togglePin = async (): Promise<void> => {
    const next = !playlist.pinnedAt
    if (!(await updatePlaylist(playlist.id, { pinned: next }))) {
      toast({ title: musicText('music.playlist.update_failed'), tone: 'danger' })
      return
    }
    toast({ title: musicText(next ? 'music.playlist.pinned' : 'music.playlist.unpinned'), tone: 'success' })
  }

  const remove = async (): Promise<void> => {
    const approved = await confirm({
      title: musicText('music.playlist.delete_title'),
      description: musicText('music.playlist.delete_body', { name: playlist.name }),
      confirmLabel: musicText('music.playlist.delete'),
      tone: 'danger',
    })
    if (!approved) return
    if (!(await deletePlaylist(playlist.id))) {
      toast({ title: musicText('music.playlist.delete_failed'), tone: 'danger' })
      return
    }
    toast({ title: musicText('music.playlist.deleted'), tone: 'success' })
    onDeleted?.()
  }

  const items: MenuItem[] = [
    {
      id: 'play',
      label: musicText('music.playlist.play'),
      icon: <Play size={14} />,
      disabled: busy,
      onSelect: () => { void play() },
    },
    {
      id: 'pin',
      label: musicText(playlist.pinnedAt ? 'music.playlist.unpin' : 'music.playlist.pin'),
      icon: playlist.pinnedAt ? <PinOff size={14} /> : <Pin size={14} />,
      checked: Boolean(playlist.pinnedAt),
      onSelect: () => { void togglePin() },
    },
    {
      id: 'edit',
      label: musicText('music.playlist.edit'),
      icon: <Pencil size={14} />,
      onSelect: () => setEditOpen(true),
    },
    {
      id: 'import',
      label: musicText('music.playlist.import'),
      icon: <FileUp size={14} />,
      onSelect: () => setImportOpen(true),
    },
    {
      id: 'export',
      label: musicText('music.playlist.export'),
      icon: <FileDown size={14} />,
      disabled: busy,
      onSelect: () => { void exportM3U() },
    },
    {
      id: 'share',
      label: musicText('music.playlist.share'),
      icon: <Share2 size={14} />,
      onSelect: () => setShareOpen(true),
    },
    {
      id: 'delete',
      label: musicText('music.playlist.delete'),
      icon: <Trash2 size={14} />,
      tone: 'danger',
      separatorBefore: true,
      onSelect: () => { void remove() },
    },
  ]

  return (
    <>
      {children({
        onClick: (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (anchor) {
            setAnchor(null)
            return
          }
          const rect = event.currentTarget.getBoundingClientRect()
          setAnchor({ x: rect.left, y: rect.bottom })
        },
        onContextMenu: (event) => {
          event.preventDefault()
          event.stopPropagation()
          setAnchor({ x: event.clientX, y: event.clientY })
        },
        'aria-haspopup': 'menu',
        'aria-expanded': anchor !== null,
      })}
      {anchor && (
        <Menu
          anchor={anchor}
          open
          onClose={() => setAnchor(null)}
          items={items}
          align="end"
          width={208}
          label={musicText('music.playlist.more')}
        />
      )}
      {editOpen && (
        <EditPlaylistDialog
          playlist={playlist}
          open
          onClose={() => setEditOpen(false)}
        />
      )}
      {shareOpen && (
        <SharePlaylistDialog
          playlist={playlist}
          open
          onClose={() => setShareOpen(false)}
          sharePlaylist={sharePlaylist}
        />
      )}
      {importOpen && (
        <ImportPlaylistDialog
          playlist={playlist}
          open
          onClose={() => setImportOpen(false)}
          onImported={() => {
            void useMusicLibrary.getState().load()
            onChanged?.()
          }}
        />
      )}
    </>
  )
}

function EditPlaylistDialog({ playlist, open, onClose }: {
  playlist: MusicPlaylist
  open: boolean
  onClose: () => void
}): ReactElement {
  const [name, setName] = useState(playlist.name)
  const [description, setDescription] = useState(playlist.description)
  const [coverUrl, setCoverUrl] = useState('')
  const [coverFile, setCoverFile] = useState<File | null>(null)
  const [coverRemoved, setCoverRemoved] = useState(false)
  const [fileUrl, setFileUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const toast = useUi((state) => state.toast)
  const initialCoverUrl = playlist.coverUrl.startsWith('/api/') ? '' : playlist.coverUrl

  useEffect(() => {
    if (!open) return
    setName(playlist.name)
    setDescription(playlist.description)
    setCoverUrl(initialCoverUrl)
    setCoverFile(null)
    setCoverRemoved(false)
    setError(null)
  }, [open, playlist.name, playlist.description, initialCoverUrl])

  useEffect(() => {
    if (!coverFile) {
      setFileUrl('')
      return
    }
    const url = URL.createObjectURL(coverFile)
    setFileUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [coverFile])

  const preview = coverRemoved ? '' : fileUrl || (playlist.coverUrl.startsWith('/api/') ? playlist.coverUrl : coverUrl)

  const chooseCover = (file: File | undefined): void => {
    if (!file) return
    if (!COVER_TYPES.has(file.type)) {
      setError(musicText('music.playlist.cover_invalid'))
      return
    }
    if (file.size > COVER_MAX_BYTES) {
      setError(musicText('music.playlist.cover_too_large'))
      return
    }
    setError(null)
    setCoverRemoved(false)
    setCoverFile(file)
  }

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const value = name.trim()
    if (!value) {
      setError(musicText('music.playlist.name_required'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const patch: { name: string; description: string; coverUrl?: string } = {
        name: value,
        description: description.trim(),
      }
      if (!coverFile && !coverRemoved && coverUrl.trim() !== initialCoverUrl) {
        patch.coverUrl = coverUrl.trim()
      }
      if (!(await useMusicLibrary.getState().updatePlaylist(playlist.id, patch))) {
        throw new Error(musicText('music.library.error.playlist'))
      }
      if (coverFile) {
        await useMusicLibrary.getState().uploadPlaylistCover(playlist.id, coverFile, coverFile.name)
      } else if (coverRemoved) {
        await useMusicLibrary.getState().removePlaylistCover(playlist.id)
      }
      toast({ title: musicText('music.playlist.updated'), tone: 'success' })
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => { if (!saving) onClose() }}
      title={musicText('music.playlist.edit_title')}
      width={520}
      dismissible={!saving}
    >
      <form className="flex flex-col gap-4" onSubmit={(event) => { void save(event) }}>
        <Field label={musicText('music.playlist.name')} required>
          <Input value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label={musicText('music.playlist.description')}>
          <Textarea
            value={description}
            rows={3}
            maxLength={2_000}
            placeholder={musicText('music.playlist.description_placeholder')}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <Field label={musicText('music.playlist.cover')} hint={musicText('music.playlist.cover_hint')}>
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
              {preview
                ? <img src={preview} alt="" className="size-full object-cover" />
                : <ImageIcon size={18} className="text-[var(--text-quaternary)]" aria-hidden="true" />}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" type="button" onClick={() => fileInput.current?.click()}>
                  {musicText('music.playlist.cover_upload')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  onClick={() => {
                    setCoverFile(null)
                    setCoverRemoved(true)
                    setCoverUrl('')
                  }}
                >
                  {musicText('music.playlist.cover_remove')}
                </Button>
              </div>
              <Input
                value={coverUrl}
                placeholder={musicText('music.playlist.cover_url')}
                aria-label={musicText('music.playlist.cover_url')}
                onChange={(event) => {
                  setCoverUrl(event.target.value)
                  setCoverFile(null)
                  setCoverRemoved(false)
                }}
              />
            </div>
            <input
              ref={fileInput}
              type="file"
              hidden
              accept={Array.from(COVER_TYPES).join(',')}
              onChange={(event) => {
                chooseCover(event.target.files?.[0])
                event.target.value = ''
              }}
            />
          </div>
        </Field>
        {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" type="button" disabled={saving} onClick={onClose}>
            {musicText('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" type="submit" loading={saving}>
            {musicText('common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function SharePlaylistDialog({ playlist, open, onClose, sharePlaylist }: {
  playlist: MusicPlaylist
  open: boolean
  onClose: () => void
  sharePlaylist: (id: string, shared: boolean) => Promise<string | null>
}): ReactElement {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useUi((state) => state.toast)

  useEffect(() => {
    if (!open) return
    setUrl(playlist.shareSlug ? `${window.location.origin}/m/${playlist.shareSlug}` : '')
  }, [open, playlist.shareSlug])

  const create = async (): Promise<void> => {
    setBusy(true)
    try {
      const next = await sharePlaylist(playlist.id, true)
      setUrl(next ?? '')
    } catch (error) {
      toastFailure(musicText('music.playlist.share_create_failed'), error)
    } finally {
      setBusy(false)
    }
  }

  const stop = async (): Promise<void> => {
    setBusy(true)
    try {
      await sharePlaylist(playlist.id, false)
      setUrl('')
      toast({ title: musicText('music.playlist.share_stopped'), tone: 'success' })
    } catch (error) {
      toastFailure(musicText('music.playlist.share_failed'), error)
    } finally {
      setBusy(false)
    }
  }

  const copy = async (): Promise<void> => {
    const copied = await copyText(url)
    toast({
      title: copied ? musicText('music.playlist.share_copied') : musicText('music.playlist.share_copy_failed'),
      tone: copied ? 'success' : 'warning',
    })
  }

  return (
    <Modal
      open={open}
      onClose={() => { if (!busy) onClose() }}
      title={musicText('music.playlist.share_title', { name: playlist.name })}
      description={musicText('music.playlist.share_hint')}
      width={520}
      dismissible={!busy}
    >
      <div className="flex flex-col gap-3">
        {url ? (
          <>
            <Input value={url} readOnly aria-label={musicText('music.playlist.share')} onFocus={(event) => event.target.select()} />
            <div className="flex flex-wrap justify-end gap-2">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void stop() }}>
                {musicText('music.playlist.share_stop')}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => { void copy() }}>
                {musicText('music.playlist.share_copy')}
              </Button>
            </div>
          </>
        ) : (
          <div className="flex justify-end">
            <Button size="sm" variant="primary" loading={busy} onClick={() => { void create() }}>
              {musicText('music.playlist.share_create')}
            </Button>
          </div>
        )}
      </div>
    </Modal>
  )
}

function ImportPlaylistDialog({ playlist, open, onClose, onImported }: {
  playlist: MusicPlaylist
  open: boolean
  onClose: () => void
  onImported: () => void
}): ReactElement {
  const [pool, setPool] = useState<MusicTrack[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let active = true
    setPool(null)
    setError(null)
    void Promise.all([
      musicApi.tracks('upload'),
      musicApi.tracks('webdav'),
      musicApi.tracks('alist'),
    ]).then(([upload, webdav, alist]) => {
      if (!active) return
      const seen = new Set<string>()
      const next: MusicTrack[] = []
      for (const track of [...upload.items, ...webdav.items, ...alist.items, ...useMusicLibrary.getState().favorites]) {
        if (seen.has(track.id)) continue
        seen.add(track.id)
        next.push(track)
      }
      setPool(next)
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { active = false }
  }, [open])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={musicText('music.playlist.import_title', { name: playlist.name })}
      description={musicText('music.playlist.import_hint')}
      width={520}
    >
      <div className="flex flex-col gap-3">
        {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
        {!pool && !error && <p role="status" className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{musicText('common.loading')}</p>}
        {pool && pool.length === 0 && (
          <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{musicText('music.playlist.import_pool_empty')}</p>
        )}
        {pool && pool.length > 0 && (
          <M3UActions
            tracks={pool}
            actions={['import', 'paste']}
            importedKey="music.m3u.added_to_playlist"
            onImport={async (tracks) => {
              // The route takes at most one hundred snapshots per call; a long M3U is added in batches.
              for (let start = 0; start < tracks.length; start += 100) {
                await musicApi.addPlaylistItems(playlist.id, tracks.slice(start, start + 100))
              }
              onImported()
            }}
          />
        )}
      </div>
    </Modal>
  )
}
