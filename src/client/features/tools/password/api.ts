import type {
  PasswordVaultState,
  PasswordGroup,
  PasswordAccount,
  PasswordSettings,
  PasswordBackupRecord,
  WebdavConfig,
} from '@shared/tools/password/types'

const BASE_URL = '/api/tools/password'

const HEADERS = {
  'Content-Type': 'application/json',
  'X-Inkstone-Client': '1',
}

/**
 * Carries the API's own error code and status so a caller can tell "wrong master password" (401)
 * from "you have used up your attempts" (429) without matching on an English sentence.
 */
export class PasswordApiError extends Error {
  readonly code?: string
  readonly status: number

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'PasswordApiError'
    this.status = status
    this.code = code
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...HEADERS,
      ...(options.headers || {}),
    },
  })

  if (!res.ok) {
    let errorMsg = `HTTP ${res.status}`
    let errorCode: string | undefined
    try {
      // The API answers `{ error: { code, message } }`. Reading `data.error` directly put
      // "[object Object]" in every toast; this unwraps both that shape and a plain string.
      const data = (await res.json()) as {
        error?: string | { code?: string; message?: string }
        message?: string
      }
      if (typeof data?.error === 'string') {
        errorMsg = data.error
      } else if (data?.error?.message) {
        errorMsg = data.error.message
        errorCode = data.error.code
      } else if (data?.message) {
        errorMsg = data.message
      }
    } catch {
      // Not JSON (proxy page, empty body): the status line is all there is to report.
    }
    throw new PasswordApiError(errorMsg, res.status, errorCode)
  }

  const json = (await res.json()) as any
  if (json && typeof json === 'object' && 'data' in json && json.ok === true) {
    return json.data as T
  }
  return json as T
}

export const passwordApi = {
  getVaultState: () => request<PasswordVaultState>('/vault'),

  initVault: (masterHash: string, kdfSalt: string) =>
    request<{ ok: boolean }>('/vault/init', {
      method: 'POST',
      body: JSON.stringify({ masterHash, kdfSalt }),
    }),

  // The server owns the "is this the master password" answer now, which is what lets it rate-limit
  // guesses and what makes /vault/reset require proof of the old one. An empty `salt` marks a vault
  // that predates the salted derivation.
  unlock: (password: string) =>
    request<{ ok: boolean; salt: string }>('/vault/unlock', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  wipeVault: () =>
    request<{ ok: boolean }>('/vault/wipe', {
      method: 'POST',
      body: JSON.stringify({ confirm: 'delete-all' }),
    }),

  resetMasterPassword: (payload: {
    oldPassword: string
    newMasterHash: string
    newKdfSalt: string
    accounts: Array<{
      id: string
      title: string
      username: string
      password: string
      link: string
      remark: string
    }>
  }) =>
    request<{ ok: boolean }>('/vault/reset', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getGroups: () => request<PasswordGroup[]>('/groups'),

  createGroup: (data: { id?: string; name: string; parentId?: string; sort?: number }) =>
    request<PasswordGroup>('/groups', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateGroup: (id: string, data: { name?: string; parentId?: string; icon?: string; sort?: number }) =>
    request<PasswordGroup>(`/groups/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  deleteGroup: (id: string) =>
    request<{ ok: boolean }>(`/groups/${id}`, {
      method: 'DELETE',
    }),

  reorderGroups: (groups: Array<{ id: string; parentId: string; sort: number }>) =>
    request<{ ok: boolean }>('/groups/reorder', {
      method: 'PUT',
      body: JSON.stringify({ groups }),
    }),

  getAccounts: (groupId?: string) =>
    request<PasswordAccount[]>(groupId ? `/accounts?groupId=${encodeURIComponent(groupId)}` : '/accounts'),

  createAccount: (data: Partial<PasswordAccount> & { groupId: string }) =>
    request<PasswordAccount>('/accounts', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateAccount: (id: string, data: Partial<PasswordAccount>) =>
    request<PasswordAccount>(`/accounts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  deleteAccount: (id: string) =>
    request<{ ok: boolean }>(`/accounts/${id}`, {
      method: 'DELETE',
    }),

  batchDeleteAccounts: (accountIds: string[]) =>
    request<{ ok: boolean; count: number }>('/accounts/batch-delete', {
      method: 'POST',
      body: JSON.stringify({ accountIds }),
    }),

  batchMoveAccounts: (accountIds: string[], targetGroupId: string) =>
    request<{ ok: boolean; count: number }>('/accounts/batch-move', {
      method: 'POST',
      body: JSON.stringify({ accountIds, targetGroupId }),
    }),

  reorderAccounts: (accounts: Array<{ id: string; sort: number }>) =>
    request<{ ok: boolean }>('/accounts/reorder', {
      method: 'PUT',
      body: JSON.stringify({ accounts }),
    }),

  batchImportAccounts: (groupId: string, accounts: Array<Partial<PasswordAccount>>) =>
    request<PasswordAccount[]>('/accounts/import', {
      method: 'POST',
      body: JSON.stringify({ groupId, accounts }),
    }),

  getSettings: () => request<PasswordSettings>('/settings'),

  // The route speaks flat columns; this module's public shape is nested. Translating here keeps the
  // one contract in a single place — the callers below hand over a `PasswordSettings` and the wire
  // format is nobody else's concern. A falsy password is omitted rather than sent as '', because the
  // server reads "absent" as "keep the stored credential" and GET never echoes it back.
  saveSettings: (settings: Partial<PasswordSettings>) => {
    const body: Record<string, unknown> = {}
    if (settings.webdav) {
      body.webdavUrl = settings.webdav.url ?? ''
      body.webdavUsername = settings.webdav.username ?? ''
      body.webdavEnabled = Boolean(settings.webdav.enabled)
      if (settings.webdav.password) body.webdavPassword = settings.webdav.password
    }
    if (settings.autoBackupEnabled !== undefined) body.autoBackupEnabled = settings.autoBackupEnabled
    if (settings.autoLockMinutes !== undefined) body.autoLockMinutes = settings.autoLockMinutes
    return request<PasswordSettings>('/settings', {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  },

  testWebdav: (config: WebdavConfig) =>
    request<{ ok: boolean; error?: string }>('/settings/webdav-test', {
      method: 'POST',
      body: JSON.stringify(config),
    }),

  getBackups: () => request<PasswordBackupRecord[]>('/backups'),

  createBackup: () =>
    request<PasswordBackupRecord>('/backups', {
      method: 'POST',
    }),

  restoreBackup: (backupId: string) =>
    request<{ ok: boolean; count: number }>(`/backups/${backupId}/restore`, {
      method: 'POST',
    }),

  deleteBackup: (backupId: string) =>
    request<{ ok: boolean }>(`/backups/${backupId}`, {
      method: 'DELETE',
    }),

  exportPlaintext: (format: 'txt' | 'csv', content: string) =>
    request<{ fileId: string; downloadUrl: string; size: number; type: 'txt' | 'csv'; filename: string }>(
      '/export',
      {
        method: 'POST',
        body: JSON.stringify({ type: format, content }),
      },
    ),
}
