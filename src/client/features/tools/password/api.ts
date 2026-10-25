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
    try {
      const data = await res.json()
      if (data && (data.error || data.message)) {
        errorMsg = data.error || data.message
      }
    } catch {
      // Ignored
    }
    throw new Error(errorMsg)
  }

  const json = (await res.json()) as any
  if (json && typeof json === 'object' && 'data' in json && json.ok === true) {
    return json.data as T
  }
  return json as T
}

export const passwordApi = {
  getVaultState: () => request<PasswordVaultState>('/vault'),

  initVault: (masterHash: string, recoveryHint: string) =>
    request<{ ok: boolean }>('/vault/init', {
      method: 'POST',
      body: JSON.stringify({ masterHash, recoveryHint }),
    }),

  resetMasterPassword: (payload: {
    newMasterHash: string
    newRecoveryHint: string
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

  updateGroup: (id: string, data: { name?: string; parentId?: string; sort?: number }) =>
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

  saveSettings: (settings: Partial<PasswordSettings>) =>
    request<PasswordSettings>('/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),

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
    request<{ fileId: string; downloadUrl: string; size: number }>('/export', {
      method: 'POST',
      body: JSON.stringify({ format, content }),
    }),
}
