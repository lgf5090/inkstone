import { z } from 'zod'

/** Ciphertext is hex of the plaintext, so these caps are roughly two bytes per character. */
const CIPHER_MAX = 8000
const MAX_BATCH = 200
const MAX_IMPORT = 500

export const InitVaultSchema = z.object({
  masterHash: z.string().min(10).max(200),
  kdfSalt: z.string().min(16).max(128),
})

export const UnlockVaultSchema = z.object({
  password: z.string().min(1).max(200),
})

export const ReauthSchema = z.object({
  password: z.string().min(1).max(200),
})

export const WipeVaultSchema = z.object({
  confirm: z.literal('delete-all'),
})

export const ResetMasterPasswordSchema = z.object({
  oldPassword: z.string().min(1).max(200),
  newMasterHash: z.string().min(10).max(200),
  newKdfSalt: z.string().min(16).max(128),
  accounts: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        title: z.string().max(CIPHER_MAX),
        username: z.string().max(CIPHER_MAX),
        password: z.string().max(CIPHER_MAX),
        link: z.string().max(CIPHER_MAX).default(''),
        remark: z.string().max(CIPHER_MAX).default(''),
  totpSecret: z.string().max(CIPHER_MAX).default(''),
      }),
    )
    .max(MAX_IMPORT),
})

export const CreateGroupSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  name: z.string().trim().min(1).max(100),
  parentId: z.string().max(128).default(''),
  icon: z.string().max(64).default(''),
  sort: z.number().int().default(0),
})

export const UpdateGroupSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  parentId: z.string().max(128).optional(),
  icon: z.string().max(64).optional(),
  sort: z.number().int().optional(),
})

export const CreateAccountSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  groupId: z.string().min(1).max(128),
  title: z.string().max(CIPHER_MAX).default(''),
  username: z.string().max(CIPHER_MAX).default(''),
  password: z.string().max(CIPHER_MAX).default(''),
  link: z.string().max(CIPHER_MAX).default(''),
  remark: z.string().max(CIPHER_MAX).default(''),
  totpSecret: z.string().max(CIPHER_MAX).default(''),
  isFavorite: z.boolean().default(false),
  sort: z.number().int().default(0),
})

export const UpdateAccountSchema = z.object({
  groupId: z.string().min(1).max(128).optional(),
  title: z.string().max(CIPHER_MAX).optional(),
  username: z.string().max(CIPHER_MAX).optional(),
  password: z.string().max(CIPHER_MAX).optional(),
  link: z.string().max(CIPHER_MAX).optional(),
  remark: z.string().max(CIPHER_MAX).optional(),
  totpSecret: z.string().max(CIPHER_MAX).optional(),
  isFavorite: z.boolean().optional(),
  sort: z.number().int().optional(),
  /** Optimistic concurrency: the row's `updatedAt` the caller last saw. */
  expectedUpdatedAt: z.number().int().optional(),
})

export const BatchDeleteAccountsSchema = z.object({
  accountIds: z.array(z.string().min(1).max(128)).min(1).max(MAX_BATCH),
})

export const BatchMoveAccountsSchema = z.object({
  accountIds: z.array(z.string().min(1).max(128)).min(1).max(MAX_BATCH),
  targetGroupId: z.string().min(1).max(128),
})

export const ReorderAccountsSchema = z.object({
  accounts: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        sort: z.number().int(),
      }),
    )
    .max(2000),
})

export const BatchImportAccountsSchema = z.object({
  groupId: z.string().min(1).max(128),
  accounts: z
    .array(
      z.object({
        id: z.string().min(1).max(128).optional(),
        title: z.string().max(CIPHER_MAX).default(''),
        username: z.string().max(CIPHER_MAX).default(''),
        password: z.string().max(CIPHER_MAX).default(''),
        link: z.string().max(CIPHER_MAX).default(''),
        remark: z.string().max(CIPHER_MAX).default(''),
        totpSecret: z.string().max(CIPHER_MAX).default(''),
      }),
    )
    .max(MAX_IMPORT),
})

// Every field is optional on purpose: the store reads "absent" as "keep what is stored", and a
// schema-level default would turn a partial body into an explicit empty value that wipes it.
export const SaveSettingsSchema = z.object({
  autoLockMinutes: z.number().int().min(1).max(120).optional(),
})

/**
 * The reader's verifier-cost switch carries the master password itself, because the server has to
 * rehash from a password it has just verified — accepting a digest from the browser would let a bad
 * client write a verifier for the wrong password and lock the vault with no recovery path.
 */
export const SetVerifierCostSchema = z.object({
  cost: z.number().int().min(4).max(31),
  password: z.string().min(1).max(200),
})
