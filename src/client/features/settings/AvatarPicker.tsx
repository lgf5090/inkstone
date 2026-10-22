import { useEffect, useRef, useState } from 'react'
import { Check, RefreshCw, RotateCcw, Upload } from 'lucide-react'
import {
  AVATAR_EMOJI_CHOICES,
  AVATAR_ICON_CHOICES,
  avatarEmojiPreference,
  avatarIconPreference,
  isBitmapAvatarDataUrl,
  parseAvatarEmojiPreference,
  parseAvatarIconPreference,
  parseStoredAvatarUrl,
} from '@shared/avatar'
import { Avatar, Button } from '../../components/primitives'
import { Modal } from '../../components/overlay'
import {
  AvatarUploadError,
  createRandomAvatarPreferences,
  prepareAvatarUpload,
} from '../../lib/avatar'
import { ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'

export function AvatarPicker({
  open,
  onClose,
  displayName,
  preference,
}: {
  open: boolean
  onClose: () => void
  displayName: string
  preference: string
}) {
  const updateProfile = useSession((state) => state.updateProfile)
  const toast = useUi((state) => state.toast)
  const inputRef = useRef<HTMLInputElement>(null)
  const [choices, setChoices] = useState<string[]>([])
  const [selected, setSelected] = useState(preference)
  const [busy, setBusy] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const processingRef = useRef(false)

  useEffect(() => {
    if (!open) return
    setSelected(preference)
    setChoices(createRandomAvatarPreferences())
    setError(null)
  }, [open, preference])

  const close = () => {
    if (!busyRef.current && !processingRef.current) onClose()
  }

  const save = async () => {
    if (busyRef.current || processingRef.current) return
    if (selected === preference) return close()
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await updateProfile({ avatarUrl: selected })
      toast({ title: t('settings.avatar_saved'), tone: 'success' })
      onClose()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('settings.action_failed_try_again'))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const chooseFile = async (file: File | undefined) => {
    if (!file || busyRef.current || processingRef.current) return
    processingRef.current = true
    setProcessing(true)
    setError(null)
    try {
      setSelected(await prepareAvatarUpload(file))
    } catch (caught) {
      setError(avatarUploadError(caught))
    } finally {
      processingRef.current = false
      setProcessing(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const selectionLabel = selected === ''
    ? t('settings.name_based_avatar')
    : parseAvatarEmojiPreference(selected)
      ? t('settings.emoji_avatar')
      : parseAvatarIconPreference(selected)
        ? t('settings.icon_avatar')
        : isBitmapAvatarDataUrl(selected) || parseStoredAvatarUrl(selected)
          ? t('settings.uploaded_avatar')
          : t('settings.random_avatar')

  return (
    <Modal
      open={open}
      onClose={close}
      title={t('settings.change_avatar')}
      width={620}
      footer={(
        <>
          <Button variant="ghost" onClick={close} disabled={busy || processing}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void save()}
            loading={busy}
            disabled={processing || selected === preference}
          >
            {t('common.save')}
          </Button>
        </>
      )}
    >
      <div className="space-y-5">
        <div className="flex items-center gap-4 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
          <Avatar src={selected} name={displayName} size={72} />
          <div className="min-w-0 flex-1">
            <div className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">
              {t('settings.selected_avatar')}
            </div>
            <div className="mt-1 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{selectionLabel}</div>
          </div>
          <Button
            size="sm"
            variant="secondary"
            icon={<RotateCcw size={12} />}
            onClick={() => setSelected('')}
            disabled={busy || processing}
          >
            {t('settings.use_name_avatar')}
          </Button>
        </div>

        <section className="rounded-[var(--r-lg)] border border-dashed border-[var(--border-default)] bg-[var(--bg-inset)] p-4">
          <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
            <div>
              <h3 className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
                {t('settings.upload_local_image')}
              </h3>
              <p className="mt-1 text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">
                {t('settings.avatar_upload_hint')}
              </p>
            </div>
            <Button
              variant="secondary"
              icon={<Upload size={13} />}
              loading={processing}
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              {t('settings.choose_image')}
            </Button>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={busy || processing}
            className="sr-only"
            onChange={(event) => void chooseFile(event.target.files?.[0])}
          />
        </section>

        <section>
          <div className="mb-2.5 flex items-center justify-between gap-3">
            <h3 className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
              {t('settings.random_avatars')}
            </h3>
            <Button
              size="sm"
              variant="ghost"
              icon={<RefreshCw size={12} />}
              onClick={() => setChoices(createRandomAvatarPreferences())}
              disabled={busy || processing}
            >
              {t('settings.refresh_avatars')}
            </Button>
          </div>
          <div className="grid grid-cols-5 gap-2.5">
            {choices.map((choice, index) => {
              const active = selected === choice
              return (
                <button
                  key={choice}
                  type="button"
                  aria-label={t('settings.random_avatar_number', { number: index + 1 })}
                  aria-pressed={active}
                  disabled={busy || processing}
                  onClick={() => setSelected(choice)}
                  className={`relative flex aspect-square min-w-0 items-center justify-center rounded-[var(--r-lg)] border transition-[border-color,background-color,transform] duration-[var(--dur-fast)] hover:-translate-y-0.5 ${
                    active
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                      : 'border-[var(--border-subtle)] bg-[var(--bg-base)] hover:border-[var(--border-strong)]'
                  }`}
                >
                  <Avatar
                    src={choice}
                    name={displayName}
                    size={42}
                    className="md:!size-[60px]"
                  />
                  {active && (
                    <span className="absolute right-1.5 bottom-1.5 flex size-4 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-contrast)]">
                      <Check size={10} strokeWidth={3} />
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </section>

        <section>
          <h3 className="mb-2.5 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
            {t('settings.avatar_emoji_title')}
          </h3>
          <div className="grid grid-cols-6 gap-2.5 sm:grid-cols-8">
            {AVATAR_EMOJI_CHOICES.map((emoji) => {
              const value = avatarEmojiPreference(emoji)
              const active = selected === value
              return (
                <button
                  key={emoji}
                  type="button"
                  aria-label={`${t('settings.avatar_emoji_title')} ${emoji}`}
                  aria-pressed={active}
                  disabled={busy || processing}
                  onClick={() => setSelected(value)}
                  className={`flex aspect-square min-w-0 items-center justify-center rounded-[var(--r-lg)] border text-[length:var(--text-18)] transition-[border-color,background-color,transform] duration-[var(--dur-fast)] hover:-translate-y-0.5 ${
                    active
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                      : 'border-[var(--border-subtle)] bg-[var(--bg-base)] hover:border-[var(--border-strong)]'
                  }`}
                >
                  <span aria-hidden="true">{emoji}</span>
                </button>
              )
            })}
          </div>
        </section>

        <section>
          <h3 className="mb-2.5 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
            {t('settings.avatar_icon_title')}
          </h3>
          <div className="grid grid-cols-6 gap-2.5 sm:grid-cols-8">
            {AVATAR_ICON_CHOICES.map((name) => {
              const value = avatarIconPreference(name)
              const active = selected === value
              return (
                <button
                  key={name}
                  type="button"
                  aria-label={`${t('settings.avatar_icon_title')} ${name}`}
                  aria-pressed={active}
                  disabled={busy || processing}
                  onClick={() => setSelected(value)}
                  className={`flex aspect-square min-w-0 items-center justify-center rounded-[var(--r-lg)] border transition-[border-color,background-color,transform] duration-[var(--dur-fast)] hover:-translate-y-0.5 ${
                    active
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                      : 'border-[var(--border-subtle)] bg-[var(--bg-base)] hover:border-[var(--border-strong)]'
                  }`}
                >
                  <Avatar src={value} name={displayName} size={34} />
                </button>
              )
            })}
          </div>
        </section>

        {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
      </div>
    </Modal>
  )
}

function avatarUploadError(caught: unknown): string {
  if (!(caught instanceof AvatarUploadError)) return t('settings.avatar_processing_failed')
  if (caught.code === 'unsupported') return t('settings.avatar_file_unsupported')
  if (caught.code === 'too_large') return t('settings.avatar_file_too_large')
  if (caught.code === 'decode_failed') return t('settings.avatar_decode_failed')
  return t('settings.avatar_processing_failed')
}
