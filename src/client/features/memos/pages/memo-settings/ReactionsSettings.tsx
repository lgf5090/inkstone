import { useState, type FormEvent } from 'react'
import { X } from 'lucide-react'
import { MEMO_REACTIONS_MAX } from '@shared/memos/constants'
import { Button, IconButton } from '../../../../components/primitives'
import { Field, Input } from '../../../../components/form'
import { t } from '../../../../lib/i18n'
import { MEMO_SETTINGS_SECTION_IDS } from './sections'
import { SettingsCard } from './SettingsCard'
import { settingsErrorMessage } from './error'
import type { MemoSettingsSectionProps } from './types'

const REACTION_MAX_LENGTH = 64

export function ReactionsSettings({ preferences, saving, save }: MemoSettingsSectionProps) {
  const [draft, setDraft] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [sectionError, setSectionError] = useState<string | null>(null)
  const reactions = preferences.reactions
  const atLimit = reactions.length >= MEMO_REACTIONS_MAX

  const remove = async (reaction: string): Promise<void> => {
    if (saving || reactions.length <= 1) return
    setSectionError(null)
    try {
      await save({ reactions: reactions.filter((entry) => entry !== reaction) })
    } catch (failure) {
      setSectionError(settingsErrorMessage(failure))
    }
  }

  const add = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (saving) return
    const value = draft.trim()
    if (!value) {
      setFormError(t('memos.settings.reactions_required'))
      return
    }
    if (value.length > REACTION_MAX_LENGTH) {
      setFormError(t('memos.settings.reactions_too_long', { max: REACTION_MAX_LENGTH }))
      return
    }
    if (reactions.includes(value)) {
      setFormError(t('memos.settings.reactions_duplicate', { emoji: value }))
      return
    }
    if (atLimit) {
      setFormError(t('memos.settings.reactions_max', { max: MEMO_REACTIONS_MAX }))
      return
    }
    setFormError(null)
    try {
      const saved = await save({ reactions: [...reactions, value] })
      if (saved) setDraft('')
    } catch (failure) {
      setFormError(settingsErrorMessage(failure))
    }
  }

  return (
    <SettingsCard
      id={MEMO_SETTINGS_SECTION_IDS.reactions}
      title={t('memos.settings.reactions')}
      description={t('memos.settings.reactions_description')}
    >
      <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
        {t('memos.settings.reactions_count', { count: reactions.length, max: MEMO_REACTIONS_MAX })}
      </p>
      {sectionError ? (
        <div role="alert" className="mt-2 rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-2">
          <p className="text-[length:var(--text-11-5)] font-medium text-[var(--danger)]">
            {t('memos.settings.save_failed')}
          </p>
          <p className="mt-0.5 text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">
            {sectionError}
          </p>
        </div>
      ) : null}
      {reactions.length === 0 ? (
        <p className="mt-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {t('memos.settings.reactions_empty')}
        </p>
      ) : (
        <ul aria-label={t('memos.settings.reactions_list')} className="mt-2 flex flex-wrap gap-1.5">
          {reactions.map((reaction) => (
            <li
              key={reaction}
              className="flex items-center gap-1 rounded-[var(--r-full)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] py-0.5 pl-2.5 pr-0.5"
            >
              <span aria-hidden="true" className="text-[length:var(--text-15)] leading-none">{reaction}</span>
              <IconButton
                label={t('memos.settings.reactions_remove', { emoji: reaction })}
                size="sm"
                disabled={saving || reactions.length <= 1}
                onClick={() => void remove(reaction)}
              >
                <X size={12} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      {reactions.length <= 1 ? (
        <p className="mt-1.5 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
          {t('memos.settings.reactions_min')}
        </p>
      ) : null}
      <form onSubmit={(event) => void add(event)} className="mt-3 flex flex-wrap items-end gap-2">
        <Field
          label={t('memos.settings.reactions_add_label')}
          hint={formError ? <span role="alert" className="text-[var(--danger)]">{formError}</span> : undefined}
          className="min-w-[var(--memo-token-field-min-width)] flex-1"
        >
          <Input
            value={draft}
            disabled={saving || atLimit}
            maxLength={REACTION_MAX_LENGTH}
            invalid={Boolean(formError)}
            placeholder={t('memos.settings.reactions_add_placeholder')}
            onChange={(event) => {
              setDraft(event.target.value)
              if (formError) setFormError(null)
            }}
          />
        </Field>
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={saving || atLimit}
        >
          {t('memos.settings.reactions_add')}
        </Button>
      </form>
    </SettingsCard>
  )
}
