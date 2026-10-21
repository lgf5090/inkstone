import type { ReactElement } from 'react'
import { MEMOS_APP_PATH } from '@shared/memos/constants'
import { Button } from '../../../components/primitives'
import { Empty, type EmptyArt } from '../../../components/feedback'
import { t, type MessageKey } from '../../../lib/i18n'
import { navigateMemoUrl } from '../url-state'

export type MemoPlaceholderKind = 'calendar' | 'attachments' | 'map' | 'views' | 'inbox' | 'setting' | 'explore' | 'notFound' | 'spaceMissing'

interface PlaceholderContent {
  art: EmptyArt
  titleKey: MessageKey
  descriptionKey: MessageKey
  homeLink?: boolean
}

const CONTENT: Record<MemoPlaceholderKind, PlaceholderContent> = {
  calendar: { art: 'folder', titleKey: 'memos.nav.calendar', descriptionKey: 'memos.placeholder.calendar_description' },
  attachments: { art: 'folder', titleKey: 'memos.nav.attachments', descriptionKey: 'memos.placeholder.attachments_description' },
  map: { art: 'folder', titleKey: 'memos.nav.map', descriptionKey: 'memos.placeholder.map_description' },
  views: { art: 'folder', titleKey: 'memos.nav.views', descriptionKey: 'memos.placeholder.views_description' },
  inbox: { art: 'archive', titleKey: 'memos.nav.inbox', descriptionKey: 'memos.placeholder.inbox_description' },
  setting: { art: 'folder', titleKey: 'memos.nav.settings', descriptionKey: 'memos.placeholder.setting_description' },
  explore: { art: 'search', titleKey: 'memos.nav.explore', descriptionKey: 'memos.placeholder.explore_description' },
  notFound: { art: 'search', titleKey: 'memos.placeholder.not_found_title', descriptionKey: 'memos.placeholder.not_found_description', homeLink: true },
  spaceMissing: { art: 'folder', titleKey: 'memos.feed.space_missing_title', descriptionKey: 'memos.feed.space_missing_description', homeLink: true },
}

export function MemoPlaceholderPage({ kind }: { kind: MemoPlaceholderKind }): ReactElement {
  const content = CONTENT[kind]
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <h2 className="sr-only">{t(content.titleKey)}</h2>
      <Empty
        art={content.art}
        title={t(content.titleKey)}
        description={t(content.descriptionKey)}
        action={content.homeLink ? (
          <Button size="sm" onClick={() => navigateMemoUrl(MEMOS_APP_PATH, '')}>
            {t('memos.placeholder.home_link')}
          </Button>
        ) : undefined}
      />
    </div>
  )
}
