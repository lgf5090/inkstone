/**
 * Memory writes with history.
 *
 * A fact that changes should not have to be deleted: when the reader says they sold the car, the old
 * memory becomes a past fact rather than vanishing, so "what car did I have before?" still answers.
 * Only an explicit replacement does that automatically; anything less certain is parked as a review
 * the reader decides on, because a wrong automatic supersession is invisible until it matters.
 *
 * Detection runs on memory writes only, never per chat message, and is rule-based by default. The
 * optional AI double-check can only dismiss or explain a review — it can never retire or delete a
 * memory by itself, which is what keeps a model's opinion out of the reader's data.
 */

import type { AssistantMemory, AssistantMemoryCategory, AssistantMemoryStatus, MemoryReviewAction } from '@shared/assistant'
import {
  classifyRelationship,
  decide,
  extractStatedDate,
  fitMemoryBudget,
  slotSearchTerms,
  toPromptMemory,
  type PromptMemory,
} from '@shared/assistant-memory'
import { estimateTokens } from '@shared/assistant'
import { ApiError } from '../lib/errors'
import type { AssistantStore } from './store'
import type { MemoryReviewRow } from './store'

/** The categories the tools may name. The shared list is the source; this is the same array typed for a schema. */
export const MEMORY_CATEGORIES_FOR_TOOLS
  = ['preference', 'fact', 'goal', 'habit', 'person', 'place', 'other'] as const

/** How many older memories one write is compared against. */
const CONFLICT_CANDIDATES = 8

/** How far a supersession chain is followed when reading history or refusing a cycle. */
export const MAX_CHAIN_DEPTH = 50

export interface WriteResult {
  memory: AssistantMemory
  superseded: AssistantMemory[]
  reviews: MemoryReviewRow[]
}

export type ConflictJudge = (older: string, newer: string) => Promise<{ relationship: string, confidence: number, reason: string } | null>

export interface MemoryHistoryHooks {
  /** Supplied only when the reader turned on the AI double-check. */
  judge?: ConflictJudge
}

export class MemoryHistoryService {
  constructor(
    private readonly store: AssistantStore,
    private readonly hooks: MemoryHistoryHooks = {},
    private readonly conflictReviewEnabled = true,
  ) {}

  async create(input: { content: string, category: AssistantMemoryCategory, source: AssistantMemory['source'] }): Promise<WriteResult> {
    const content = input.content.trim()
    const duplicate = await this.store.findDuplicateMemory(content)
    // Saved first: nothing below may lose the memory, and a failed comparison leaves a plain fact.
    if (duplicate) return { memory: duplicate, superseded: [], reviews: [] }
    const memory = await this.store.insertMemory({
      content,
      category: input.category,
      source: input.source,
      validFrom: extractStatedDate(content),
    })
    return this.afterWrite(memory)
  }

  async update(id: string, patch: { content?: string, category?: AssistantMemoryCategory }): Promise<WriteResult> {
    const before = await this.store.getMemory(id)
    if (!before) throw ApiError.notFound('Memory not found')
    const content = patch.content?.trim()
    const memory = await this.store.updateMemoryContent(id, content ?? before.content, patch.category ?? before.category)
    if (!memory) throw ApiError.notFound('Memory not found')
    if (memory.content === before.content) return { memory, superseded: [], reviews: [] }
    return this.afterWrite(memory)
  }

  /** Records a newer version of a fact. The old memory stays behind as history. */
  async correct(id: string, content: string, category?: AssistantMemoryCategory): Promise<WriteResult> {
    const old = await this.store.getMemory(id)
    if (!old) throw ApiError.notFound('Memory not found')
    const trimmed = content.trim()
    if (trimmed.toLowerCase() === old.content.toLowerCase()) throw ApiError.badRequest('That is the same as the current memory.')
    const created = await this.store.insertMemory({
      content: trimmed,
      category: category ?? old.category,
      source: 'manual',
      validFrom: extractStatedDate(trimmed),
    })
    const superseded = await this.supersede(old.id, created.id, { validUntil: created.validFrom })
    const rest = await this.afterWrite(created)
    return {
      memory: created,
      superseded: [superseded, ...rest.superseded],
      reviews: rest.reviews,
    }
  }

  async setStatus(id: string, status: AssistantMemoryStatus): Promise<AssistantMemory | null> {
    const memory = await this.store.getMemory(id)
    if (!memory) throw ApiError.notFound('Memory not found')
    if (status === 'active') {
      // Restoring a past fact makes it current again and detaches it from what replaced it.
      return await this.store.setMemoryLifecycle(id, {
        status: 'active',
        supersededBy: null,
        validUntil: memory.status === 'historical' ? null : memory.validUntil,
      })
    }
    return await this.store.setMemoryLifecycle(id, { status })
  }

  /** Marks `oldId` a past fact replaced by `newId`. Nothing is deleted. */
  async supersede(oldId: string, newId: string, opts: { validUntil?: string | null } = {}): Promise<AssistantMemory> {
    const older = await this.store.getMemory(oldId)
    const newer = await this.store.getMemory(newId)
    if (!older || !newer) throw ApiError.notFound('Memory not found')
    if (await this.wouldCycle(oldId, newId)) {
      throw ApiError.badRequest('A memory cannot replace itself or one of its own replacements.')
    }
    const updated = await this.store.supersedePair(oldId, newId, opts.validUntil ?? older.validUntil)
    if (!updated) throw ApiError.notFound('Memory not found')
    return updated
  }

  async wouldCycle(oldId: string, newId: string): Promise<boolean> {
    if (oldId === newId) return true
    let current: string | null = newId
    for (let depth = 0; depth < MAX_CHAIN_DEPTH && current; depth++) {
      const memory = await this.store.getMemory(current)
      if (!memory) return false
      if (memory.supersededBy === oldId) return true
      current = memory.supersededBy
    }
    return false
  }

  /** Older and newer versions around a memory, oldest first, bounded by `MAX_CHAIN_DEPTH`. */
  async history(id: string): Promise<{ memory: AssistantMemory, previous: AssistantMemory[], next: AssistantMemory[] }> {
    const memory = await this.store.getMemory(id)
    if (!memory) throw ApiError.notFound('Memory not found')
    const previous: AssistantMemory[] = []
    const seen = new Set([id])
    let frontier = [id]
    for (let depth = 0; depth < MAX_CHAIN_DEPTH && frontier.length && previous.length < 100; depth++) {
      const next: string[] = []
      for (const frontierId of frontier) {
        for (const parent of await this.store.predecessors(frontierId)) {
          if (seen.has(parent.id)) continue
          seen.add(parent.id)
          previous.push(parent)
          next.push(parent.id)
        }
      }
      frontier = next
    }
    // The breadth-first walk found the nearest versions first; oldest first reads naturally.
    previous.reverse()
    const later: AssistantMemory[] = []
    let current = memory.supersededBy
    for (let depth = 0; depth < MAX_CHAIN_DEPTH && current && !seen.has(current); depth++) {
      seen.add(current)
      const step = await this.store.getMemory(current)
      if (!step) break
      later.push(step)
      current = step.supersededBy
    }
    return { memory, previous, next: later }
  }

  /**
   * The reader's decision on a possible conflict.
   *
   * `replace` and `discard` are the only destructive actions here, and both are a button the reader
   * pressed on the review card — never something the rules decided on their own.
   */
  async resolveReview(reviewId: string, action: MemoryReviewAction): Promise<{ kept: number, deleted: boolean }> {
    const review = await this.store.getReview(reviewId)
    if (!review) throw ApiError.notFound('This review no longer exists.')
    const newer = await this.store.getMemory(review.memory_id)
    const older = await this.store.getMemory(review.other_id)
    await this.store.deleteReview(reviewId)
    if (!newer || !older) throw ApiError.conflict('One of these memories was already removed.')
    switch (action) {
      case 'keep_both':
        return { kept: 2, deleted: false }
      case 'mark_historical':
        await this.supersede(older.id, newer.id)
        return { kept: 2, deleted: false }
      case 'replace':
        await this.store.deleteMemory(older.id)
        return { kept: 1, deleted: true }
      case 'discard':
        await this.store.deleteMemory(newer.id)
        return { kept: 1, deleted: true }
    }
  }

  async delete(id: string): Promise<void> {
    const memory = await this.store.getMemory(id)
    if (!memory) throw ApiError.notFound('Memory not found')
    await this.store.deleteMemory(id)
    // The activity log quoted the content when the memory was created, so forgetting one has to take
    // that line with it — and the entry recording the forget must not quote it back in.
    await this.store.deleteActivityQuoting('memory.created', memory.content)
    await this.store.recordActivity('memory.deleted', '')
  }

  async clear(): Promise<number> {
    return await this.store.deleteAllMemories()
  }

  /** Labels and budgets the memories that go into the system prompt. */
  promptMemories(selected: AssistantMemory[], maxTokens: number): PromptMemory[] {
    const byId = new Map(selected.map((memory) => [memory.id, memory]))
    const labelled = selected.map((memory) => toPromptMemory(memory, (id) => byId.get(id) ?? null))
    return fitMemoryBudget(labelled, maxTokens, (entry) => estimateTokens(entry.content))
  }

  private async afterWrite(memory: AssistantMemory): Promise<WriteResult> {
    if (!this.conflictReviewEnabled) return { memory, superseded: [], reviews: [] }
    try {
      return await this.detectConflicts(memory)
    } catch (error) {
      // Detection is best-effort; the memory itself is already saved.
      console.warn('[inkstone] assistant memory conflict detection skipped:', error instanceof Error ? error.name : error)
      return { memory: (await this.store.getMemory(memory.id)) ?? memory, superseded: [], reviews: [] }
    }
  }

  private async detectConflicts(memory: AssistantMemory): Promise<WriteResult> {
    const candidates = new Map<string, AssistantMemory>()
    for (const found of await this.store.searchMemories(memory.content, CONFLICT_CANDIDATES, 'current')) {
      candidates.set(found.id, found)
    }
    // The same single-valued topic without shared words: "I moved to Paris" against "I live in London".
    for (const terms of slotSearchTerms(memory.content)) {
      for (const found of await this.store.searchMemories(terms, CONFLICT_CANDIDATES, 'current')) {
        candidates.set(found.id, found)
      }
    }
    candidates.delete(memory.id)

    const assessments = [...candidates.values()]
      .filter((candidate) => candidate.status !== 'historical' && candidate.createdAt <= memory.updatedAt)
      .map((candidate) => ({ candidate, assessment: classifyRelationship(memory.content, candidate) }))

    const superseded: AssistantMemory[] = []
    const reviews: MemoryReviewRow[] = []
    let aiChecks = 0
    for (const { candidate, assessment } of assessments) {
      const action = decide(assessment)
      if (action === 'none') continue
      if (action === 'supersede') {
        if (await this.wouldCycle(candidate.id, memory.id)) continue
        superseded.push(await this.supersede(candidate.id, memory.id, { validUntil: memory.validFrom }))
        continue
      }
      let reason = assessment.reason
      if (this.hooks.judge && aiChecks < 1) {
        aiChecks++
        const verdict = await this.hooks.judge(candidate.content, memory.content).catch(() => null)
        if (verdict && (verdict.relationship === 'complements' || verdict.relationship === 'unrelated') && verdict.confidence >= 0.8) continue
        if (verdict?.reason) reason = verdict.reason.slice(0, 60)
      }
      const review = await this.store.createReview({
        memoryId: memory.id,
        otherId: candidate.id,
        relationship: assessment.relationship === 'possible_update' ? 'possible_update' : 'contradiction',
        reason,
      })
      await this.store.setMemoryLifecycle(memory.id, { status: 'uncertain' })
      if (review) reviews.push(review)
    }
    if (superseded.length) {
      await this.store.recordActivity('memory.superseded', `${superseded.length} older memory kept as history`)
    }
    if (reviews.length) {
      await this.store.recordActivity('memory.review', `${reviews.length} possible memory conflict needs review`)
    }
    return { memory: (await this.store.getMemory(memory.id)) ?? memory, superseded, reviews }
  }
}
