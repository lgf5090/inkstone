/**
 * Which resolver the player asks first, and (later) a per-track override.
 *
 * The account preference is a real server setting: the segmented control writes
 * `sourcePriority` through the settings store, which debounces the PUT and rolls the panel back when
 * the write fails. Per-track overrides have no route yet, so that half of the panel is shown as a
 * disabled explanation instead of a control that would appear to save and silently do nothing.
 */
import { useEffect, useState, type ReactElement } from 'react'
import { CircleAlert, RefreshCw, ServerCog } from 'lucide-react'
import { IconButton, Spinner } from '../../../components/primitives'
import { Segmented, SettingRow } from '../../../components/form'
import { cn } from '../../../lib/cn'
import { selectCurrentTrack, useMusicPlayer } from '../store/player'
import { useMusicSettings } from '../store/settings'
import { musicText } from './labels'

type MusicSourceKind = 'official' | 'custom'

function sourceOptions(): Array<{ value: MusicSourceKind; label: string }> {
  return [
    { value: 'official', label: musicText('music.source.official') },
    { value: 'custom', label: musicText('music.source.custom') },
  ]
}

export interface SourcePickerProps {
  className?: string
}

export function SourcePicker({ className }: SourcePickerProps): ReactElement {
  const current = useMusicPlayer(selectCurrentTrack)
  const settings = useMusicSettings((state) => state.server)
  const status = useMusicSettings((state) => state.serverStatus)
  const serverError = useMusicSettings((state) => state.serverError)
  const loadServer = useMusicSettings((state) => state.loadServer)
  const saveServer = useMusicSettings((state) => state.saveServer)
  const [loaded, setLoaded] = useState(false)

  // A panel opened straight from the player has not necessarily loaded the account row yet. Editing
  // is held back until that read succeeds, because a save writes the whole settings document and a
  // default-filled one would replace choices the reader made elsewhere.
  const reload = (): void => {
    void loadServer().then(() => {
      setLoaded(useMusicSettings.getState().serverStatus === 'idle')
    })
  }

  useEffect(() => {
    let active = true
    void loadServer().then(() => {
      if (active) setLoaded(useMusicSettings.getState().serverStatus === 'idle')
    })
    return () => {
      active = false
    }
  }, [loadServer])

  const preferred: MusicSourceKind = settings.sourcePriority[0] === 'custom' ? 'custom' : 'official'
  const customConfigured = settings.customResolverEnabled && settings.customResolverUrl.trim() !== ''
  const preferredIsUnavailable = preferred === 'custom' && !customConfigured
  const options = sourceOptions()

  const choose = (source: MusicSourceKind): void => {
    if (source === preferred) return
    saveServer({
      sourcePriority: [source, ...settings.sourcePriority.filter((entry) => entry !== source)],
    })
  }

  return (
    <section aria-label={musicText('music.source.title')} className={cn('flex flex-col gap-3', className)}>
      <header className="flex items-start gap-2">
        <ServerCog size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--text-tertiary)]" />
        <p className="min-w-0 flex-1 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
          {musicText('music.source.description')}
        </p>
        <IconButton
          size="xs"
          label={musicText('music.source.retry')}
          disabled={status === 'loading' || status === 'saving'}
          onClick={reload}
        >
          <RefreshCw size={13} />
        </IconButton>
      </header>

      {!loaded && status !== 'error' && (
        <p role="status" className="flex items-center gap-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          <Spinner size={12} />
          {musicText('music.source.loading')}
        </p>
      )}

      {status === 'saving' && (
        <p role="status" className="flex items-center gap-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          <Spinner size={12} />
          {musicText('music.source.saving')}
        </p>
      )}

      {status === 'error' && (
        <p role="alert" className="flex items-start gap-1.5 text-[length:var(--text-11-5)] leading-relaxed text-[var(--danger)]">
          <CircleAlert size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
          {musicText(serverError ?? 'music.source.error')}
        </p>
      )}

      <SettingRow title={musicText('music.source.preferred')} description={musicText('music.source.preferred_hint')}>
        <Segmented
          value={preferred}
          options={options}
          label={musicText('music.source.preferred')}
          disabled={!loaded}
          onChange={choose}
        />
      </SettingRow>

      {preferredIsUnavailable && (
        <p role="status" className="rounded-[var(--r-md)] bg-[var(--bg-inset)] px-3 py-2 text-[length:var(--text-11-5)] leading-relaxed text-[var(--warning)]">
          {musicText('music.source.custom_unconfigured')}
        </p>
      )}

      {!preferredIsUnavailable && preferred === 'custom' && (
        <p role="status" className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          {musicText('music.source.custom_ready')}
        </p>
      )}

      <div className="border-t border-[var(--border-subtle)] pt-3">
        <h4 className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">
          {musicText('music.source.track_override')}
        </h4>
        <p className="mt-0.5 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
          {musicText('music.source.track_override_hint')}
        </p>
        <p className="mt-1.5 text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
          {musicText('music.source.current', { source: current?.source || '—' })}
        </p>
        {/*
          TODO(music): per-track overrides need a route over `music_source_override` (the table and
          `MusicSourceOverride` already exist). Until that route lands this control stays disabled:
          showing a saved state the server never received would be worse than showing none.
        */}
        <Segmented
          className="mt-2 opacity-50"
          value={preferred}
          options={options}
          label={musicText('music.source.track_override')}
          disabled
          onChange={() => undefined}
        />
        <p role="note" className="mt-1.5 text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">
          {musicText('music.source.track_override_unavailable')}
        </p>
      </div>
    </section>
  )
}
