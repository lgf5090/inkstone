import type { Variables } from '../env'

export interface UserRow {
  id: string
  username: string
  login: string
  name: string
  avatar_url: string
  role: 'owner' | 'member'
  settings: string
  created_at: number
}

export const USER_COLUMNS = `id, username, login, name, avatar_url, role, settings, created_at`

export function rowToUser(row: UserRow): Variables['user'] {
  return {
    id: row.id,
    username: row.username,
    login: row.login,
    name: row.name,
    avatarUrl: row.avatar_url,
    role: row.role === 'owner' ? 'owner' : 'member',
    createdAt: row.created_at,
    settingsRaw: row.settings,
  }
}
