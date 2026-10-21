/**
 * A new `runId`.
 *
 * Ids have to be unique across a batch rather than merely clever, and the two sources of randomness this app
 * has are `crypto.randomUUID` and a counter; the counter is used when the platform has no `crypto`, which is
 * a browser that is old enough to lack it rather than a theoretical one.
 *
 * Its own module rather than a export of `./index.ts`, because the door is the one file every half is
 * allowed to look at and no half may look at it: the page host mints ids for the nested runs it starts, and
 * importing them from the door would make that import a cycle.
 */
export function createTemplateRunId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.()
  const tail = random ?? `${Date.now().toString(36)}${++sequence}`
  return `${prefix}-${tail}`
}

let sequence = 0
