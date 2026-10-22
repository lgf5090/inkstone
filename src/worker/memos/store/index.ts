import type { Memo, MemoListResponse } from '@shared/memos/types'
import { listMemoComments } from './comments'
import { deleteMemo, type MemoDeleteResult } from './deletion'
import { readMemo } from './hydrate'
import { listMemos, type MemoListOptions } from './list'
import {
  createMemo,
  patchMemo,
  restoreMemo,
  type MemoCreateFields,
  type MemoPatchFields,
  type MemoPatchResult,
} from './mutations'
import {
  getMemoRelations,
  replaceMemoRelations,
  type MemoRelationsFields,
  type MemoRelationsPair,
} from './relations'

export type { MemoCommentFields } from './comments'
export type { MemoAttachmentObjectRef, MemoDeleteResult } from './deletion'
export type { MemoRow } from './hydrate'
export type { MemoListOptions } from './list'
export type {
  MemoCreateFields,
  MemoPatchFields,
  MemoPatchResult,
} from './mutations'
export type { MemoRelationsFields, MemoRelationsPair } from './relations'

export class MemosStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
  ) {}

  async list(options: MemoListOptions): Promise<MemoListResponse> {
    return listMemos(this.db, this.userId, options)
  }

  async get(id: string): Promise<Memo | null> {
    return readMemo(this.db, this.userId, id)
  }

  async listComments(
    parentId: string,
    options: { cursor?: string | null; limit?: number; tz?: string } = {},
  ): Promise<MemoListResponse | null> {
    return listMemoComments(this.db, this.userId, parentId, options)
  }

  async create(fields: MemoCreateFields): Promise<Memo> {
    return createMemo(this.db, this.userId, fields)
  }

  async patch(id: string, fields: MemoPatchFields): Promise<MemoPatchResult> {
    return patchMemo(this.db, this.userId, id, fields)
  }

  async restore(id: string): Promise<Memo | null> {
    return restoreMemo(this.db, this.userId, id)
  }

  async delete(id: string): Promise<MemoDeleteResult | null> {
    return deleteMemo(this.db, this.userId, id)
  }

  async relations(id: string): Promise<MemoRelationsPair | null> {
    return getMemoRelations(this.db, this.userId, id)
  }

  async replaceRelations(id: string, fields: MemoRelationsFields): Promise<MemoRelationsPair | null> {
    return replaceMemoRelations(this.db, this.userId, id, fields)
  }
}
