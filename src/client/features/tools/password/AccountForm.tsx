import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import {
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Lock,
  Share2,
  Sparkles,
  Star,
  Trash2,
  Unlock,
} from 'lucide-react'
import type { DecryptedAccount } from '@shared/tools/password/types'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { Empty } from '../../../components/feedback'
import { IconButton, Spinner } from '../../../components/primitives'
import { Input, Textarea } from '../../../components/form'
import { Tooltip, confirm } from '../../../components/overlay'
import { evaluatePasswordStrength } from './crypto/strength'
import { usePasswordVaultStore } from './store'
import { copySecret } from './utils/clipboard'
import { FaviconAvatar } from './FaviconAvatar'

export interface AccountFormProps {
  onBack?: () => void
  className?: string
}

export function PasswordStrengthIndicator({ password }: { password: string }) {
  if (!password) return null

  const result = evaluatePasswordStrength(password)
  const score = result.score // 0 to 4

  const getBarColor = (index: number) => {
    if (index >= score && score > 0) return 'bg-[var(--border-subtle)]'
    if (score === 0 || score === 1) return 'bg-[var(--danger)]'
    if (score === 2) return 'bg-[var(--warning)]'
    if (score === 3) return 'bg-[var(--accent)]'
    return 'bg-[var(--success)]'
  }

  return (
    <div className="mt-1.5 space-y-1" data-testid="password-strength-indicator">
      <div className="flex items-center gap-1">
        {[0, 1, 2, 3].map((barIndex) => (
          <div
            key={barIndex}
            data-testid="strength-bar"
            className={cn(
              'h-1.5 flex-1 rounded-full transition-colors duration-200',
              getBarColor(barIndex),
            )}
          />
        ))}
        <span
          className="ml-2 text-[length:var(--text-11)] font-medium text-[var(--text-secondary)] shrink-0"
          data-testid="strength-label"
        >
          {result.label}
        </span>
      </div>

      {(result.warning || (result.suggestions && result.suggestions.length > 0)) && (
        <div className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          {result.warning || result.suggestions[0]}
        </div>
      )}
    </div>
  )
}

export function AccountForm({ onBack, className }: AccountFormProps) {
  const selectedAccountId = usePasswordVaultStore((s) => s.selectedAccountId)
  const decryptedAccounts = usePasswordVaultStore((s) => s.decryptedAccounts)
  const updateAccount = usePasswordVaultStore((s) => s.updateAccount)
  const deleteAccount = usePasswordVaultStore((s) => s.deleteAccount)
  const toggleFavorite = usePasswordVaultStore((s) => s.toggleFavorite)
  const createAccount = usePasswordVaultStore((s) => s.createAccount)
  const selectedGroupId = usePasswordVaultStore((s) => s.selectedGroupId)
  const groups = usePasswordVaultStore((s) => s.groups)
  const openGeneratorModal = usePasswordVaultStore((s) => s.openGeneratorModal)

  const activeAccount: DecryptedAccount | undefined = selectedAccountId
    ? decryptedAccounts[selectedAccountId]
    : undefined

  const [formData, setFormData] = useState<DecryptedAccount | null>(null)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [showPassword, setShowPassword] = useState(false)
  const [isLocked, setIsLocked] = useState(false)

  const saveTimerRef = useRef<number | null>(null)
  const latestDataRef = useRef<DecryptedAccount | null>(null)

  // The debounce is the only copy of the last few keystrokes: unmounting or switching accounts
  // inside the 300 ms window used to throw them away. Both paths now write them out first.
  const flushPendingSave = () => {
    if (!saveTimerRef.current) return
    window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = null

    const pending = latestDataRef.current
    if (!pending) return
    void updateAccount(pending.id, {
      title: pending.title,
      username: pending.username,
      password: pending.password,
      link: pending.link,
      remark: pending.remark,
      favicon: pending.favicon,
    }).catch(() => {
      useUi.getState().toast({ title: t('common.save_failed'), tone: 'danger' })
    })
  }

  // Sync state when selected account changes
  useEffect(() => {
    flushPendingSave()

    if (!activeAccount) {
      setFormData(null)
      latestDataRef.current = null
      return
    }

    setFormData(activeAccount)
    latestDataRef.current = activeAccount
    setSaveStatus('idle')
    setShowPassword(false)

    // Default lock anti-touch if account has existing content
    const hasExistingContent = Boolean(
      activeAccount.title?.trim() ||
        activeAccount.username?.trim() ||
        activeAccount.password?.trim() ||
        activeAccount.link?.trim(),
    )
    setIsLocked(hasExistingContent)
  }, [activeAccount?.id])

  useEffect(() => {
    return () => {
      flushPendingSave()
    }
  }, [])

  const triggerSave = (dataToSave: DecryptedAccount) => {
    latestDataRef.current = dataToSave
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current)
    }

    setSaveStatus('saving')
    saveTimerRef.current = window.setTimeout(async () => {
      try {
        await updateAccount(dataToSave.id, {
          title: dataToSave.title,
          username: dataToSave.username,
          password: dataToSave.password,
          link: dataToSave.link,
          remark: dataToSave.remark,
          favicon: dataToSave.favicon,
        })
        setSaveStatus('saved')
      } catch {
        setSaveStatus('idle')
        useUi.getState().toast({
          title: t('common.save_failed'),
          tone: 'danger',
        })
      }
    }, 300)
  }

  const handleFieldChange = (field: keyof DecryptedAccount, value: string) => {
    if (isLocked || !formData) return
    const next = { ...formData, [field]: value }
    setFormData(next)
    triggerSave(next)
  }

  const copyUsername = async () => {
    if (!formData?.username) return
    try {
      await copySecret(formData.username)
      useUi.getState().toast({
        title: t('tools.password.account.copied'),
        description: formData.username,
        tone: 'success',
      })
    } catch {
      useUi.getState().toast({ title: t('preview.could_not_copy'), tone: 'danger' })
    }
  }

  const copyPassword = async () => {
    if (!formData?.password) return
    try {
      await copySecret(formData.password)
      useUi.getState().toast({
        title: t('tools.password.account.copied'),
        description: t('tools.password.account.password'),
        tone: 'success',
      })
    } catch {
      useUi.getState().toast({ title: t('preview.could_not_copy'), tone: 'danger' })
    }
  }

  const handleOpenLink = async () => {
    if (!formData?.link) return
    let url = formData.link.trim()
    if (!/^https?:\/\//i.test(url)) {
      url = `https://${url}`
    }

    // Auto write credentials to clipboard before opening URL
    if (formData.password) {
      try {
        await copySecret(formData.password)
        useUi.getState().toast({
          title: t('tools.password.account.copied'),
          description: `${t('tools.password.account.password')} -> ${url}`,
          tone: 'success',
        })
      } catch {
        // Best effort
      }
    }

    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const handleShare = async () => {
    if (!formData) return
    const text = [
      `[${formData.title || t('tools.password.account.title')}]`,
      formData.username ? `${t('tools.password.account.username')}: ${formData.username}` : '',
      formData.password ? `${t('tools.password.account.password')}: ${formData.password}` : '',
      formData.link ? `${t('tools.password.account.link')}: ${formData.link}` : '',
      formData.remark ? `${t('tools.password.account.remark')}:\n${formData.remark}` : '',
    ]
      .filter(Boolean)
      .join('\n')

    try {
      await copySecret(text)
      useUi.getState().toast({
        title: t('tools.password.account.copied'),
        description: t('tools.password.account.share'),
        tone: 'success',
      })
    } catch {
      useUi.getState().toast({ title: t('preview.could_not_copy'), tone: 'danger' })
    }
  }

  const handleDelete = async () => {
    if (!formData) return
    const title = formData.title || t('tools.password.account.title')
    const ok = await confirm({
      title: t('tools.password.account.delete'),
      description: t('tools.password.account.delete_confirm', { title }),
      tone: 'danger',
    })

    if (ok) {
      // A pending save would otherwise fire at the row 300 ms after it was deleted.
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      latestDataRef.current = null
      await deleteAccount(formData.id)
      useUi.getState().toast({
        title: t('notes.deleted'),
        tone: 'success',
      })
    }
  }

  // Keyboard shortcuts (Ctrl/Cmd + U, Ctrl/Cmd + P, Ctrl/Cmd + N)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey
      if (!isMod) return

      const key = e.key.toLowerCase()
      if (key === 'u') {
        e.preventDefault()
        void copyUsername()
      } else if (key === 'p') {
        e.preventDefault()
        void copyPassword()
      } else if (key === 'n') {
        e.preventDefault()
        const targetGroupId = selectedGroupId || groups[0]?.id
        if (!targetGroupId) {
          useUi.getState().toast({
            title: t('tools.password.account.no_group'),
            tone: 'danger',
          })
          return
        }
        void createAccount({
          groupId: targetGroupId,
          title: '',
          username: '',
          password: '',
          link: '',
          remark: '',
        }).catch((err: unknown) => {
          useUi.getState().toast({
            title: err instanceof Error ? err.message : t('common.save_failed'),
            tone: 'danger',
          })
        })
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [formData?.username, formData?.password, selectedGroupId, groups])

  if (!formData) {
    return (
      <div
        data-testid="account-form-empty"
        className={cn(
          'flex h-full min-h-0 flex-1 items-center justify-center p-8 text-center bg-[var(--bg-base)]',
          className,
        )}
      >
        <Empty
          art="select"
          title={t('tools.password.account.no_selection')}
        />
      </div>
    )
  }

  return (
    <div
      data-testid="account-form"
      className={cn(
        'flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[var(--bg-base)]',
        className,
      )}
    >
      {/* Top Toolbar */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-4">
        <div className="flex items-center gap-2">
          {onBack && (
            <Tooltip label={t('email.header.back')}>
              <IconButton
                label={t('email.header.back')}
                size="sm"
                onClick={onBack}
                className="md:hidden"
              >
                <ArrowLeft size={16} />
              </IconButton>
            </Tooltip>
          )}

          {/* Anti-touch Lock / Unlock Switch */}
          <Tooltip
            label={
              isLocked
                ? t('tools.password.account.unlocked')
                : t('tools.password.account.locked')
            }
          >
            <IconButton
              label={
                isLocked
                  ? t('tools.password.account.unlocked')
                  : t('tools.password.account.locked')
              }
              size="sm"
              variant={isLocked ? 'secondary' : 'primary'}
              active={!isLocked}
              onClick={() => setIsLocked(!isLocked)}
              data-testid="form-lock-btn"
            >
              {isLocked ? <Lock size={15} /> : <Unlock size={15} />}
            </IconButton>
          </Tooltip>

          {/* Auto-save status feedback */}
          <div className="flex items-center gap-1.5 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            {saveStatus === 'saving' && (
              <>
                <Spinner size={12} />
                <span>{t('tools.password.common.saving')}</span>
              </>
            )}
            {saveStatus === 'saved' && (
              <>
                <Check size={12} className="text-[var(--success)]" />
                <span>{t('tools.password.common.saved')}</span>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {/* Favorite Toggle */}
          <Tooltip
            label={
              formData.isFavorite
                ? t('tools.password.account.unfavorite')
                : t('tools.password.account.favorite')
            }
          >
            <IconButton
              label={
                formData.isFavorite
                  ? t('tools.password.account.unfavorite')
                  : t('tools.password.account.favorite')
              }
              size="sm"
              variant="ghost"
              onClick={async () => {
                await toggleFavorite(formData.id)
                setFormData((prev) => (prev ? { ...prev, isFavorite: !prev.isFavorite } : null))
              }}
              data-testid="form-favorite-btn"
            >
              <Star
                size={16}
                className={formData.isFavorite ? 'fill-[var(--warning)] text-[var(--warning)]' : ''}
              />
            </IconButton>
          </Tooltip>

          {/* Share Credentials */}
          <Tooltip label={t('tools.password.account.share')}>
            <IconButton
              label={t('tools.password.account.share')}
              size="sm"
              variant="ghost"
              onClick={handleShare}
              data-testid="form-share-btn"
            >
              <Share2 size={16} />
            </IconButton>
          </Tooltip>

          {/* Delete Account */}
          <Tooltip label={t('tools.password.account.delete')}>
            <IconButton
              label={t('tools.password.account.delete')}
              size="sm"
              variant="ghost"
              className="text-[var(--danger)] hover:bg-[var(--danger-soft)]"
              onClick={handleDelete}
              data-testid="form-delete-btn"
            >
              <Trash2 size={16} />
            </IconButton>
          </Tooltip>
        </div>
      </div>

      {/* Form Content Area */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto max-w-2xl space-y-5">
          {/* Title Header with Favicon */}
          <div className="flex items-center gap-3">
            <FaviconAvatar
              url={formData.link}
              title={formData.title}
              favicon={formData.favicon}
              size={44}
            />
            <div className="flex-1 min-w-0">
              <label className="block text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)] mb-1">
                {t('tools.password.account.title')}
              </label>
              <Input
                value={formData.title}
                disabled={isLocked}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  handleFieldChange('title', e.target.value)
                }
                placeholder={t('tools.password.account.title')}
                className="text-[length:var(--text-14)] font-medium"
                data-testid="input-title"
              />
            </div>
          </div>

          {/* Username */}
          <div>
            <label className="block text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)] mb-1">
              {t('tools.password.account.username')}
            </label>
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <Input
                  value={formData.username}
                  disabled={isLocked}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    handleFieldChange('username', e.target.value)
                  }
                  placeholder={t('tools.password.account.username')}
                  data-testid="input-username"
                />
              </div>
              <Tooltip label={t('tools.password.account.copy_username')} side="left">
                <IconButton
                  label={t('tools.password.account.copy_username')}
                  size="md"
                  variant="secondary"
                  onClick={copyUsername}
                  data-testid="copy-username-btn"
                >
                  <Copy size={15} />
                </IconButton>
              </Tooltip>
            </div>
          </div>

          {/* Password */}
          <div>
            <label className="block text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)] mb-1">
              {t('tools.password.account.password')}
            </label>
            <div className="flex items-center gap-2">
              <div className="relative flex-1 min-w-0">
                <Input
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={t('tools.password.account.password')}
                  value={formData.password}
                  disabled={isLocked}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    handleFieldChange('password', e.target.value)
                  }
                  placeholder={t('tools.password.account.password')}
                  trailing={
                    <button
                      type="button"
                      aria-label={showPassword ? t('tools.password.account.hide_password') : t('tools.password.account.show_password')}
                      onClick={() => setShowPassword(!showPassword)}
                      className="rounded p-1 text-[var(--text-quaternary)] hover:text-[var(--text-secondary)]"
                      data-testid="toggle-password-btn"
                    >
                      {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  }
                  data-testid="input-password"
                />
              </div>

              <Tooltip label={t('tools.password.account.copy_password')} side="top">
                <IconButton
                  label={t('tools.password.account.copy_password')}
                  size="md"
                  variant="secondary"
                  onClick={copyPassword}
                  data-testid="copy-password-btn"
                >
                  <Copy size={15} />
                </IconButton>
              </Tooltip>

              <Tooltip label={t('tools.password.generator.title')} side="top">
                <IconButton
                  label={t('tools.password.generator.title')}
                  size="md"
                  variant="secondary"
                  disabled={isLocked}
                  onClick={() => openGeneratorModal()}
                  data-testid="form-generator-btn"
                >
                  <Sparkles size={15} />
                </IconButton>
              </Tooltip>
            </div>

            {/* Password Strength Indicator */}
            <PasswordStrengthIndicator password={formData.password} />
          </div>

          {/* Website Link */}
          <div>
            <label className="block text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)] mb-1">
              {t('tools.password.account.link')}
            </label>
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <Input
                  value={formData.link}
                  disabled={isLocked}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    handleFieldChange('link', e.target.value)
                  }
                  placeholder="https://..."
                  data-testid="input-link"
                />
              </div>
              <Tooltip label={t('tools.password.account.open_link')} side="left">
                <IconButton
                  label={t('tools.password.account.open_link')}
                  size="md"
                  variant="secondary"
                  onClick={handleOpenLink}
                  disabled={!formData.link}
                  data-testid="open-link-btn"
                >
                  <ExternalLink size={15} />
                </IconButton>
              </Tooltip>
            </div>
          </div>

          {/* Remark / Notes */}
          <div>
            <label className="block text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)] mb-1">
              {t('tools.password.account.remark')}
            </label>
            <Textarea
              rows={4}
              value={formData.remark}
              disabled={isLocked}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                handleFieldChange('remark', e.target.value)
              }
              placeholder={t('tools.password.account.remark')}
              data-testid="input-remark"
            />
          </div>
        </div>
      </div>
    </div>
  )
}
