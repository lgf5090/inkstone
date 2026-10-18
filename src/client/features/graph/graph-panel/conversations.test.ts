// @vitest-environment jsdom
/**
 * A conversation as a thing the graph can point at.
 *
 * Two facts already tie the chat to the notebook, and neither has ever been drawn: a thread carries the id
 * of the page it was started from (`chat_conversations.note_id`), and a page can hold a thread whole
 * (`![[chat:<id>]]`), which the graph currently reports as a hollow node because no *note* answers to that
 * title. Putting the two together turns both into an edge to something real.
 *
 * What is pinned is the honesty of the drawing, not its arithmetic. A thread is added only when the page it
 * names is actually on the canvas, so a node never floats on an edge to nowhere. An embed is converted only
 * when the assistant still has that thread, so a note pointing at a deleted conversation keeps saying so
 * instead of gaining a node that opens nothing. And a graph with no threads comes back unchanged — the
 * feature is not allowed to invent the things it exists to show.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantConversation } from '@shared/assistant'
import type { GraphNode, GraphResponse } from '@shared/types'
import {
  attachThreads,
  conversationIdOf,
  conversationNodeId,
  withConversations,
  type GraphThread,
} from './conversations'

/** What the assistant's own listing answers with; the graph reads three fields off each row. */
function threadRow(id: string, title: string, noteId: string | null): AssistantConversation {
  return { id, title, noteId } as unknown as AssistantConversation
}

type ThreadsAnswer = { conversations: AssistantConversation[], nextCursor: string | null }

const conversations = vi.fn(async (): Promise<ThreadsAnswer> => ({ conversations: [], nextCursor: null }))

vi.mock('../../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  CLIENT_ID: 'test-client',
  api: { assistant: { conversations: () => conversations() } },
}))

const NOTE = 'note-0'
const OTHER = 'note-1'

function note(id: string, title = id): GraphNode {
  return {
    id, title, kind: 'note', degree: 1, inDegree: 0, outDegree: 1,
    folderId: null, folderName: null, folderColor: null, tags: [],
  }
}

/** The hollow node the graph draws for a `![[chat:<id>]]` embed, as the route spells it. */
function embedGhost(threadId: string): GraphNode {
  return {
    id: `unresolved:chat:${threadId}`, title: `chat:${threadId}`, kind: 'unresolved',
    degree: 1, inDegree: 0, outDegree: 0,
    folderId: null, folderName: null, folderColor: null, tags: [],
  }
}

function response(nodes: GraphNode[], edges: GraphResponse['edges']): GraphResponse {
  return {
    nodes, edges,
    meta: {
      mode: 'global', centerId: null, depth: 1, totalNodes: nodes.length,
      totalEdges: edges.length, truncated: false, limit: 350,
    },
  }
}

function thread(id: string, title: string, noteId: string | null): GraphThread {
  return { id, title, noteId }
}

const titles = (response: ReturnType<typeof withConversations>) => response.nodes.map((node) => node.title)

describe('a thread that names a page', () => {
  it('draws the thread beside the page it was started from', () => {
    const base = response([note(NOTE), note(OTHER)], [{ source: OTHER, target: NOTE }])
    const merged = withConversations(base, [thread('c1', 'What we decided about pricing', NOTE)])
    const node = merged.nodes.find((entry) => entry.id === conversationNodeId('c1'))
    expect(node, 'the conversation is missing from the graph').toBeTruthy()
    expect(node!.title).toBe('What we decided about pricing')
    expect(node!.kind).toBe('conversation')
    expect(merged.edges).toContainEqual({ source: conversationNodeId('c1'), target: NOTE })
    // The page gained a neighbour, and the badge that counts them has to know.
    expect(merged.nodes.find((entry) => entry.id === NOTE)!.degree).toBe(2)
  })

  it('leaves a thread whose page is not on the canvas out', () => {
    const base = response([note(NOTE)], [])
    const merged = withConversations(base, [thread('c9', 'About a page far away', 'elsewhere')])
    expect(merged.nodes).toHaveLength(1)
    expect(merged.edges).toEqual([])
    expect(conversationIdOf(merged.nodes[0]!)).toBeNull()
  })

  it('adds nothing at all when no thread names a page', () => {
    const base = response([note(NOTE), note(OTHER)], [{ source: OTHER, target: NOTE }])
    const merged = withConversations(base, [])
    expect(merged.nodes.map((entry) => entry.id)).toEqual(base.nodes.map((entry) => entry.id))
    expect(merged.edges).toEqual(base.edges)
  })
})

describe('a page that holds a conversation', () => {
  it('turns the hollow node into the thread the embed points at', () => {
    const base = response(
      [note(NOTE), embedGhost('c2')],
      [{ source: NOTE, target: 'unresolved:chat:c2' }],
    )
    const merged = withConversations(base, [thread('c2', 'The thread inside the note', null)])
    expect(titles(merged)).toContain('The thread inside the note')
    expect(merged.nodes.some((entry) => entry.kind === 'unresolved')).toBe(false)
    expect(merged.edges).toContainEqual({ source: NOTE, target: conversationNodeId('c2') })
    expect(conversationIdOf(merged.nodes.find((entry) => entry.id === conversationNodeId('c2'))!)).toBe('c2')
  })

  it('leaves the hollow node when the assistant no longer has that thread', () => {
    const base = response(
      [note(NOTE), embedGhost('gone')],
      [{ source: NOTE, target: 'unresolved:chat:gone' }],
    )
    const merged = withConversations(base, [thread('c3', 'Something else', OTHER)])
    const ghost = merged.nodes.find((entry) => entry.id === 'unresolved:chat:gone')
    expect(ghost, 'a dead embed lost the node that told the truth about it').toBeTruthy()
    expect(ghost!.kind).toBe('unresolved')
    expect(merged.nodes.some((entry) => entry.kind === 'conversation')).toBe(false)
  })

  it('draws one node when a page both names a thread and holds it', () => {
    // Both facts about the same thread, in the same answer: the note was started from the thread, and the
    // note beside it embeds the thread. Two edges, one node, or the graph shows a reader the same
    // conversation twice at two different sizes.
    const merged = withConversations(
      response([note(NOTE), note(OTHER), embedGhost('c4')], [
        { source: OTHER, target: 'unresolved:chat:c4' },
        { source: NOTE, target: OTHER },
      ]),
      [thread('c4', 'Named and embedded', NOTE)],
    )
    const nodes = merged.nodes.filter((entry) => entry.kind === 'conversation')
    expect(nodes).toHaveLength(1)
    // Both edges, named rather than counted at one end: the embed runs page → thread (the page holds it)
    // and the origin runs thread → page (the thread was started from it), so filtering by one side of the
    // conversation node would find one of the two and call the other missing.
    expect(merged.edges.filter((edge) => edge.source === conversationNodeId('c4') || edge.target === conversationNodeId('c4')))
      .toHaveLength(2)
    expect(merged.edges).toContainEqual({ source: OTHER, target: conversationNodeId('c4') })
    expect(merged.edges).toContainEqual({ source: conversationNodeId('c4'), target: NOTE })
    expect(titles(merged)).not.toContain('chat:c4')
  })

  it('reads a thread id back off the node it was drawn into', () => {
    expect(conversationIdOf(note(NOTE))).toBeNull()
    expect(conversationIdOf({ ...embedGhost('c5'), kind: 'note' })).toBeNull()
  })
})

describe('the two reads the panel joins', () => {
  let warned: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    conversations.mockResolvedValue({ conversations: [], nextCursor: null })
    conversations.mockClear()
    warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warned.mockRestore()
  })

  /** The scene as the panel has it before the threads are joined: one page, no edges. */
  const emptyScene = () => response([note(NOTE)], [])

  it('adds the thread the listing names', async () => {
    conversations.mockResolvedValueOnce({ conversations: [threadRow('c7', 'What we settled', NOTE)], nextCursor: null })
    const merged = await attachThreads(emptyScene(), null)
    expect(merged.problem).toBeNull()
    expect(merged.scene.nodes.some((entry) => entry.kind === 'conversation')).toBe(true)
    expect(merged.scene.edges).toContainEqual({ source: conversationNodeId('c7'), target: NOTE })
  })

  it('keeps the notes graph and says so when the listing fails', async () => {
    conversations.mockRejectedValueOnce(new Error('the assistant is unreachable'))
    const base = emptyScene()
    const merged = await attachThreads(base, null)
    // Blank canvas is the wrong answer: the reader asked about the shape of their notes, and that half of
    // the picture is still true. What has to change is the silence around the missing half.
    expect(merged.scene).toBe(base)
    expect(merged.problem).toContain('unreachable')
    expect(warned).toHaveBeenCalled()
  })

  it('does not report a panel that closed mid-read', async () => {
    const aborted = new DOMException('Aborted', 'AbortError')
    conversations.mockRejectedValueOnce(aborted)
    await expect(attachThreads(emptyScene(), null)).rejects.toThrow(aborted)
    expect(warned).not.toHaveBeenCalled()
  })
})
