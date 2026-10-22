import type { MessageKey } from '../locales/en-US'

export const MEMOS_MESSAGE_KEYS = {
  appTab: 'app.tabs.memos',
  loading: 'memos.common.loading',
  empty: 'memos.common.empty',
  error: 'memos.common.error',
  retry: 'memos.common.retry',
  save: 'memos.common.save',
  cancel: 'memos.common.cancel',
  delete: 'memos.common.delete',
  confirm: 'memos.common.confirm',
} as const satisfies Record<string, MessageKey>
