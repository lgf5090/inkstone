import type { ReactElement } from 'react'
import { MEMOS_APP_PATH } from '@shared/memos/constants'
import { Button } from '../../../components/primitives'
import { Empty } from '../../../components/feedback'
import { t } from '../../../lib/i18n'
import { navigateMemoUrl } from '../url-state'

export function MemoInboxPage(): ReactElement {
  return (
    <div className="h-full min-h-0 overflow-y-auto" data-memos-inbox="">
      <h2 className="sr-only">{t('memos.nav.inbox')}</h2>
      <Empty
        art="archive"
        title={t('memos.inbox.empty_title')}
        description={t('memos.inbox.empty_description')}
        action={(
          <Button size="sm" onClick={() => navigateMemoUrl(MEMOS_APP_PATH, '')}>
            {t('memos.inbox.go_to_memos')}
          </Button>
        )}
      />
    </div>
  )
}
