import { z } from 'zod'

export const InitVaultSchema = z.object({
  masterHash: z.string().min(10).max(200),
  recoveryHint: z.string().min(1).max(500),
})

export const ResetMasterPasswordSchema = z.object({
  newMasterHash: z.string().min(10).max(200),
  newRecoveryHint: z.string().min(1).max(500),
  accounts: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string(),
      username: z.string(),
      password: z.string(),
      link: z.string().default(''),
      remark: z.string().default(''),
    })
  ),
})

export const CreateGroupSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(100),
  parentId: z.string().default(''),
  sort: z.number().int().default(0),
})

export const UpdateGroupSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  parentId: z.string().optional(),
  sort: z.number().int().optional(),
})

export const ReorderGroupsSchema = z.object({
  groups: z.array(
    z.object({
      id: z.string().min(1),
      parentId: z.string().default(''),
      sort: z.number().int(),
    })
  ),
})

export const CreateAccountSchema = z.object({
  id: z.string().min(1).optional(),
  groupId: z.string().min(1),
  title: z.string().default(''),
  username: z.string().default(''),
  password: z.string().default(''),
  link: z.string().default(''),
  remark: z.string().default(''),
  favicon: z.string().default(''),
  isFavorite: z.boolean().default(false),
  sort: z.number().int().default(0),
})

export const UpdateAccountSchema = z.object({
  groupId: z.string().min(1).optional(),
  title: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  link: z.string().optional(),
  remark: z.string().optional(),
  favicon: z.string().optional(),
  isFavorite: z.boolean().optional(),
  sort: z.number().int().optional(),
})

export const BatchDeleteAccountsSchema = z.object({
  accountIds: z.array(z.string().min(1)).min(1),
})

export const BatchMoveAccountsSchema = z.object({
  accountIds: z.array(z.string().min(1)).min(1),
  targetGroupId: z.string().min(1),
})

export const ReorderAccountsSchema = z.object({
  accounts: z.array(
    z.object({
      id: z.string().min(1),
      sort: z.number().int(),
    })
  ),
})

export const BatchImportAccountsSchema = z.object({
  groupId: z.string().min(1),
  accounts: z.array(
    z.object({
      id: z.string().min(1).optional(),
      title: z.string().default(''),
      username: z.string().default(''),
      password: z.string().default(''),
      link: z.string().default(''),
      remark: z.string().default(''),
      favicon: z.string().default(''),
    })
  ),
})

export const SaveSettingsSchema = z.object({
  webdavUrl: z.string().default(''),
  webdavUsername: z.string().default(''),
  webdavPassword: z.string().default(''),
  webdavEnabled: z.boolean().default(false),
  autoBackupEnabled: z.boolean().default(true),
  autoLockMinutes: z.number().int().min(1).max(120).default(5),
})

export const TestWebdavSchema = z.object({
  url: z.string().url(),
  username: z.string().min(1),
  password: z.string().min(1),
})
