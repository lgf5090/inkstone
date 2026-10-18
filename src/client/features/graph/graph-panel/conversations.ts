/**
 * Conversations as part of the reader's graph.
 *
 * The graph has always drawn what points at a note, and a thread that was started from a note — or held
 * inside one as `![[chat:<id>]]` — does exactly that. Until now neither fact was drawn at all: the note's
 * backlink panel listed the threads as rows, and the graph showed the embed as a hollow node because no
 * *note* answers to a title like `chat:01h…`. The reader looking at the shape of their vault could not see
 * the conversations in it.
 *
 * This is the graph's own merge, done in the graph's own module, out of two reads that belong to the
 * assistant. Nothing here asks the notes app to know about threads: the route's answer stays what it was,
 * and the threads are added to it the way the panel adds tag nodes — as nodes this feature draws.
 */
import type { AssistantConversation } from '@shared/assistant'
import { api } from '../../../lib/api'
import { chatEmbedId } from '../../../lib/markdown/chat-embed'
import type { SceneNode, SceneResponse } from './types'

/** The id prefix a conversation node carries: the same `chat:<id>` a note's own embed is written with. */
const NODE_PREFIX = 'chat:'

/**
 * How many threads are asked for.
 *
 * The route's own ceiling for one page, which is the point: the graph is a bounded picture, and the newest
 * threads are the ones a reader expects to find hanging off the newest notes. A page of older work whose
 * thread is not in this answer simply draws without it — nothing is invented to fill the gap.
 */
const GRAPH_THREAD_PAGE = 100

/** One thread the graph can draw: the id that opens it, the name it wears, the page it names. */
export interface GraphThread {
  id: string
  title: string
  /** The page this thread was started from, which is one of the two kinds of edge the graph has. */
  noteId: string | null
}

/** The id a conversation is drawn under, and the id its node hands back when it is pressed. */
export function conversationNodeId(threadId: string): string {
  return `${NODE_PREFIX}${threadId}`
}

/** The thread a node stands for, or null for every node that is not a conversation. */
export function conversationIdOf(node: SceneNode): string | null {
  if (node.kind !== 'conversation') return null
  return node.id.startsWith(NODE_PREFIX) ? node.id.slice(NODE_PREFIX.length) : null
}

/**
 * The thread an empty-looking node is actually pointing at.
 *
 * A `![[chat:<id>]]` embed arrives from the notes graph as an unresolved node — the link index has a target
 * key and no note behind it — and its title is the embed's own text. That is the second fact this merge
 * reads, and `chatEmbedId` is the renderer's published answer to "is this target a conversation", so the
 * graph cannot drift from what the note itself draws.
 */
function embeddedThreadId(node: SceneNode): string | null {
  return node.kind === 'unresolved' ? chatEmbedId(node.title) : null
}

/** The threads the graph is drawn from: the newest page, plus the centre note's own when there is one. */
export async function graphThreads(centreNoteId: string | null, signal?: AbortSignal): Promise<GraphThread[]> {
  const page = await api.assistant.conversations({ limit: String(GRAPH_THREAD_PAGE) }, signal)
  if (!centreNoteId) return page.conversations.map(toGraphThread)
  // A local graph is asked about one page, and its threads are not necessarily the vault's newest hundred.
  const own = await api.assistant.conversations({
    noteId: centreNoteId,
    limit: String(GRAPH_THREAD_PAGE),
  }, signal)
  const byId = new Map(page.conversations.map((entry) => [entry.id, entry]))
  for (const entry of own.conversations) byId.set(entry.id, entry)
  return [...byId.values()].map(toGraphThread)
}

function toGraphThread(conversation: AssistantConversation): GraphThread {
  return { id: conversation.id, title: conversation.title, noteId: conversation.noteId ?? null }
}

/**
 * The scene the panel draws, with the reader's threads in it — and the reason it has none.
 *
 * Two reads back the picture, and only the notes one is allowed to fail the panel: the graph answers "what
 * points at what", so a conversation read that broke would otherwise blank a drawing that is entirely about
 * notes. The scene comes back either way, with the failure spelled out for the surface to say rather than
 * quietly draw a smaller graph.
 */
export async function attachThreads(scene: SceneResponse, centreNoteId: string | null, signal?: AbortSignal): Promise<{ scene: SceneResponse, problem: string | null }> {
  try {
    return { scene: withConversations(scene, await graphThreads(centreNoteId, signal)), problem: null }
  } catch (error) {
    // A cancelled read is the panel going away, not a fact about the reader's threads: rethrown unheard,
    // because reporting it would dress an ordinary close up as a broken assistant.
    if ((error as { name?: string } | null)?.name === 'AbortError') throw error
    // Logged at the one place the two reads are joined, so a reader on the narrow panel — which has room
    // for the sentence but not for the reason — can still find out what broke.
    console.warn('[inkstone] the conversations could not be read for the graph', error)
    return { scene, problem: error instanceof Error ? error.message : String(error) }
  }
}

/** A node's neighbour counts, moved by one edge that was not in the route's answer. */
function addDegree(node: SceneNode, side: 'in' | 'out'): void {
  node.degree += 1
  if (side === 'in') node.inDegree += 1
  else node.outDegree += 1
}

function conversationNode(thread: GraphThread): SceneNode {
  return {
    id: conversationNodeId(thread.id),
    title: thread.title,
    kind: 'conversation',
    degree: 0,
    inDegree: 0,
    outDegree: 0,
    // A thread has no folder and no tags: it is not filed in the vault, and inventing a place for it would
    // colour it by a folder it does not belong to.
    folderId: null,
    folderName: null,
    folderColor: null,
    tags: [],
  }
}

/**
 * The graph the panel draws: the route's answer, with the threads in it.
 *
 * Three rules keep the picture true.
 *
 *  - A thread is added when the page it names is on this canvas, or when a hollow node on this canvas points
 *    at it. A node whose only edge goes to a page that is not drawn would be a floating dot.
 *  - A hollow `chat:<id>` node becomes the conversation only while the assistant still has that thread. A
 *    note embedding a deleted conversation keeps showing the gap, because that is the fact the reader has.
 *  - With nothing to add, the same object comes back. The panels re-render on every keystroke of a filter;
 *    rebuilding an unchanged graph into a new array would throw away the layout the physics just settled.
 */
export function withConversations(response: SceneResponse, threads: readonly GraphThread[]): SceneResponse {
  if (!threads.length) return response
  const noteIds = new Set(response.nodes.filter((node) => node.kind === 'note').map((node) => node.id))
  const ghosts = new Map<string, string>()
  for (const node of response.nodes) {
    const embedded = embeddedThreadId(node)
    if (embedded) ghosts.set(embedded, node.id)
  }
  const known = new Set<string>()
  // Copied rather than mutated: the counts below move with the edges this merge adds, and the caller's answer
  // is React state that other surfaces — the legend, the neighbour list, the export — read as it stands.
  const nodes: SceneNode[] = response.nodes
    .filter((node) => {
      // The hollow node leaves only when it is being replaced, so an unknown thread still reads as a hole.
      const embedded = embeddedThreadId(node)
      return !(embedded && threads.some((thread) => thread.id === embedded))
    })
    .map((node) => ({ ...node }))
  const edges = response.edges.map((edge) => ({ ...edge }))
  const byId = new Map(nodes.map((node) => [node.id, node]))

  const place = (thread: GraphThread): SceneNode | null => {
    const existing = byId.get(conversationNodeId(thread.id))
    if (existing) return existing
    if (known.has(thread.id)) return null
    known.add(thread.id)
    const node = conversationNode(thread)
    nodes.push(node)
    byId.set(node.id, node)
    return node
  }

  for (const thread of threads) {
    const ghost = ghosts.get(thread.id)
    const namesANote = thread.noteId !== null && noteIds.has(thread.noteId)
    if (!ghost && !namesANote) continue
    const node = place(thread)
    if (!node) continue
    if (ghost) {
      // The embed's edge already counted on the page that carries it, so only the node it now leads to
      // changes: same source, same number of neighbours, one real thing behind the dot instead of a hole.
      for (const edge of edges) {
        if (edge.target !== ghost) continue
        edge.target = node.id
        addDegree(node, 'in')
      }
    }
    if (!namesANote || !thread.noteId) continue
    if (edges.some((edge) => edge.source === node.id && edge.target === thread.noteId)) continue
    const page = byId.get(thread.noteId)
    if (!page) continue
    // Direction is the thread's own: it was started *from* the page, the way an origin chip says.
    edges.push({ source: node.id, target: thread.noteId })
    addDegree(node, 'out')
    addDegree(page, 'in')
  }
  return {
    nodes,
    edges,
    meta: { ...response.meta, totalNodes: response.meta.totalNodes + known.size },
  }
}

/** The threads in an answer, in the order the panel lists them: the newest names first. */
export function conversationNodes(response: SceneResponse): SceneNode[] {
  return response.nodes.filter((node) => node.kind === 'conversation')
}

/**
 * Open the thread a node stands for.
 *
 * Loaded dynamically for both panels, and for the reason the note embed does the same: the graph lives in
 * the notebook, and a reader who came to look at the shape of their vault should not pay for the
 * assistant's bundle until they actually press a thread.
 */
export function openGraphConversation(threadId: string): void {
  void import('../../chat/start-chat').then((module) => module.openConversationInChat(threadId))
}
