import type {
  PasswordVaultState,
  PasswordGroup,
  PasswordAccount,
  PasswordSettings,
  PasswordBackupRecord,
  PasswordAuditEntry,
  BreachRangeEntry,
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

  /** Mints the short-lived token destructive routes require (wipe, restore, delete snapshot). */
  reauth: (password: string) =>
    request<{ token: string; expiresInMs: number }>('/vault/re-auth', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  wipeVault: (confirmToken: string) =>
    request<{ ok: boolean }>('/vault/wipe', {
      method: 'POST',
      headers: { 'X-Inkstone-Confirm': confirmToken },
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
      totpSecret: string
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

  getAccounts: (groupId?: string) =>
    request<PasswordAccount[]>(groupId ? `/accounts?groupId=${encodeURIComponent(groupId)}` : '/accounts'),

  /**
   * One page, keyset-ordered by `(sort, id)`. `nextCursor` is null on the last page; the cursor is
   * opaque to the caller and only meaningful to the route that produced it.
   */
  getAccountsPage: (options: { limit: number; cursor?: string; groupId?: string }) => {
    const params = new URLSearchParams({ limit: String(options.limit) })
    if (options.cursor) params.set('cursor', options.cursor)
    if (options.groupId) params.set('groupId', options.groupId)
    return request<{ items: PasswordAccount[]; nextCursor: string | null }>(
      `/accounts?${params.toString()}`,
    )
  },

  createAccount: (data: Partial<PasswordAccount> & { groupId: string }) =>
    request<PasswordAccount>('/accounts', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateAccount: (id: string, data: Partial<PasswordAccount> & { expectedUpdatedAt?: number }) =>
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

  // The route takes flat optional fields. Sending only the values the caller actually changed keeps
  // "absent" meaning "keep what is stored".
  saveSettings: (settings: Partial<PasswordSettings>) => {
    const body: Record<string, unknown> = {}
    if (settings.autoLockMinutes !== undefined) body.autoLockMinutes = settings.autoLockMinutes
    return request<PasswordSettings>('/settings', {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  },

  /**
   * Asks the server to rebuild the verifier at another bcrypt cost. The master password travels with
   * the request because only the server may hash it; a weaker tier lands before the reply, a stronger
   * one finishes after it and reports `applied: 'deferred'`.
   */
  setVerifierCost: (cost: number, password: string) =>
    request<{
      applied: 'unchanged' | 'immediate' | 'deferred'
      storedCost: number
      targetCost: number
      measuredMs: number
    }>('/settings/verifier', {
      method: 'POST',
      body: JSON.stringify({ cost, password }),
    }),

  getBackups: () => request<PasswordBackupRecord[]>('/backups'),

  createBackup: () =>
    request<PasswordBackupRecord>('/backups', {
      method: 'POST',
    }),

  restoreBackup: (backupId: string, confirmToken: string) =>
    request<{ ok: boolean; count: number }>(`/backups/${backupId}/restore`, {
      method: 'POST',
      headers: { 'X-Inkstone-Confirm': confirmToken },
    }),

  restoreLocalBackup: (data: unknown, confirmToken: string) =>
    request<{ groupsCount: number; accountsCount: number }>('/backups/restore-local', {
      method: 'POST',
      headers: { 'X-Inkstone-Confirm': confirmToken },
      body: JSON.stringify(data),
    }),

  deleteBackup: (backupId: string, confirmToken: string) =>
    request<{ ok: boolean }>(`/backups/${backupId}`, {
      method: 'DELETE',
      headers: { 'X-Inkstone-Confirm': confirmToken },
    }),

  getAudit: (limit = 30) => request<PasswordAuditEntry[]>(`/audit?limit=${limit}`),

  /** Only the five-character prefix leaves the browser; see `utils/breach.ts`. */
  checkBreach: (prefix: string) => request<BreachRangeEntry[]>(`/breach?prefix=${prefix}`),
}
