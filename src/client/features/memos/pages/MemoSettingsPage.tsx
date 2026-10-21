import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { MemoPreferences, MemoPreferencesPatch } from '@shared/memos/types'
import { Button } from '../../../components/primitives'
import { Empty, LoadingBlock } from '../../../components/feedback'
import { t, type MessageKey } from '../../../lib/i18n'
import { memosApi } from '../api'
import { useMemoPreferences } from '../use-memo-preferences'
import { AccountSettings } from './memo-settings/AccountSettings'
import { AboutSettings } from './memo-settings/AboutSettings'
import { AccessTokensSettings } from './memo-settings/AccessTokensSettings'
import { GeneralSettings } from './memo-settings/GeneralSettings'
import { ReactionsSettings } from './memo-settings/ReactionsSettings'
import { TagRulesSettings } from './memo-settings/TagRulesSettings'
import { MEMO_SETTINGS_SECTION_IDS } from './memo-settings/sections'

interface SettingsSectionLink {
  id: string
  labelKey: MessageKey
}

const SECTION_LINKS: readonly SettingsSectionLink[] = [
  { id: MEMO_SETTINGS_SECTION_IDS.general, labelKey: 'memos.settings.general' },
  { id: MEMO_SETTINGS_SECTION_IDS.reactions, labelKey: 'memos.settings.reactions' },
  { id: MEMO_SETTINGS_SECTION_IDS.tags, labelKey: 'memos.settings.tags' },
  { id: MEMO_SETTINGS_SECTION_IDS.tokens, labelKey: 'memos.settings.tokens' },
  { id: MEMO_SETTINGS_SECTION_IDS.about, labelKey: 'memos.settings.about' },
  { id: MEMO_SETTINGS_SECTION_IDS.account, labelKey: 'memos.settings.account' },
]

export function MemoSettingsPage(): ReactElement {
  const preferences = useMemoPreferences()
  const [draft, setDraft] = useState<MemoPreferences | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)

  useEffect(() => {
    if (preferences.status === 'ready' && preferences.data && draft === null) {
      setDraft(preferences.data)
    }
  }, [draft, preferences.data, preferences.status])

  const save = async (patch: MemoPreferencesPatch): Promise<MemoPreferences | null> => {
    const current = draft
    if (!current || savingRef.current) return null
    savingRef.current = true
    setSaving(true)
    setDraft({ ...current, ...patch })
    try {
      const saved = await memosApi.preferences.patch(patch)
      setDraft(saved)
      return saved
    } catch (error) {
      setDraft(current)
      throw error
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto" data-memos-settings="">
      <div className="mx-auto w-full max-w-[980px] px-3 py-3 md:px-5 md:py-4">
        <header>
          <h2 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">
            {t('memos.nav.settings')}
          </h2>
          <p className="mt-0.5 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
            {t('memos.settings.page_description')}
          </p>
        </header>
        <nav aria-label={t('memos.settings.sections')} className="mt-3">
          <ul className="flex gap-1 overflow-x-auto pb-1">
            {SECTION_LINKS.map((section) => (
              <li key={section.id} className="shrink-0">
                <a
                  href={`#${section.id}`}
                  className="inline-flex min-h-9 items-center rounded-[var(--r-full)] border border-[var(--border-subtle)] px-3 text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--border-default)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] md:min-h-7"
                >
                  {t(section.labelKey)}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        {draft === null ? (
          preferences.status === 'error' ? (
            <Empty
              art="folder"
              title={t('memos.settings.load_failed_title')}
              description={preferences.error ?? t('memos.settings.load_failed_description')}
              action={(
                <Button size="sm" onClick={preferences.reload}>
                  {t('memos.common.retry')}
                </Button>
              )}
            />
          ) : (
            <LoadingBlock label={t('memos.common.loading')} />
          )
        ) : (
          <div className="mt-3 space-y-4">
            <GeneralSettings preferences={draft} saving={saving} save={save} />
            <ReactionsSettings preferences={draft} saving={saving} save={save} />
            <TagRulesSettings preferences={draft} saving={saving} save={save} />
            <AccessTokensSettings />
            <AboutSettings />
            <AccountSettings />
          </div>
        )}
      </div>
    </div>
  )
}
