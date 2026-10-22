import { useEffect, useRef } from 'react'
import { CLIENT_HEADER } from '@shared/constants'
import type { RealtimeMessage, TodosSyncResponse } from '@shared/types'
import { CLIENT_ID } from './api'
import { createBroadcast, localDb, type BroadcastPayload } from './db'
import { applyTodoSync } from '../features/todos/store'
import { acknowledgeOutboxBaseAdvanced, acknowledgeOutboxResult, useNotes } from '../store/notes'
import { useSession } from '../store/session'


const HEARTBEAT_MS = 25_000
const SAFETY_POLL_MS = 5 * 60_000
const MAX_BACKOFF_MS = 30_000
const LEADER_RECLAIM_MS = 60_000

export class SyncEngine {
  private socket: WebSocket | null = null
  private pollTimer = 0
  private heartbeatTimer = 0
  private reconnectTimer = 0
  private pullTimer = 0
  private leadershipTimer = 0
  private failures = 0
  private disposed = false
  private isLeader = false
  private ownClaimAt = 0
  private bestClaim: { clientId: string; at: number } | null = null
  private scheduledPullShouldBroadcast = false
  private pullDueAt = 0
  private lastPullAt = 0
  private lastPong = 0
  /** The newest task `updated_at` this tab has folded in; sent back as the task delta's `since`. */
  private todosCursor = 0
  private todosCursorReady: Promise<void> | null = null
  private todosPull: Promise<void> | null = null
  private broadcast = createBroadcast((payload) => this.onBroadcast(payload))

  constructor(
    private realtimeEnabled: boolean,
    private pollIntervalMs: number,
  ) {}

  /**
   * Applies live setting changes (realtime toggle, poll interval) without
   * tearing down the engine, its WebSocket, or its leadership claim.
   */
  updateConfig(realtimeEnabled: boolean, pollIntervalMs: number): void {
    const interval = Math.max(5000, pollIntervalMs)
    if (interval !== this.pollIntervalMs) {
      this.pollIntervalMs = interval
      this.startPolling()
    }
    if (realtimeEnabled === this.realtimeEnabled) return
    this.realtimeEnabled = realtimeEnabled
    if (realtimeEnabled) {
      if (this.isLeader) this.connect()
    } else {
      window.clearTimeout(this.reconnectTimer)
      window.clearInterval(this.heartbeatTimer)
      this.socket?.close()
      this.socket = null
    }
  }

  start(): void {
    this.claimLeadership()
    document.addEventListener('visibilitychange', this.onVisibility)
    window.addEventListener('focus', this.onFocus)
    window.addEventListener('online', this.onOnline)
    window.addEventListener('offline', this.onOffline)
    window.addEventListener('pagehide', this.onPageHide)
    this.startPolling()
    // The first task delta is asked for beside the note bootstrap rather than behind it: the board a
    // reader lands on should be the one the server holds, not the last page this tab happened to hold.
    void this.pullTodos()
  }

  dispose(): void {
    this.disposed = true
    document.removeEventListener('visibilitychange', this.onVisibility)
    window.removeEventListener('focus', this.onFocus)
    window.removeEventListener('online', this.onOnline)
    window.removeEventListener('offline', this.onOffline)
    window.removeEventListener('pagehide', this.onPageHide)
    window.clearInterval(this.pollTimer)
    window.clearInterval(this.heartbeatTimer)
    window.clearTimeout(this.reconnectTimer)
    window.clearTimeout(this.pullTimer)
    this.pullTimer = 0
    this.pullDueAt = 0
    window.clearTimeout(this.leadershipTimer)
    this.socket?.close()
    this.socket = null
    this.broadcast.close()
  }


  private claimLeadership(): void {
    const claim = { type: 'claim-leader' as const, clientId: CLIENT_ID, at: Date.now() }
    this.ownClaimAt = claim.at
    this.bestClaim = claim
    this.broadcast.post(claim)
    window.clearTimeout(this.leadershipTimer)
    this.leadershipTimer = window.setTimeout(() => {
      if (this.disposed) return
      const winner = this.bestClaim
      this.setLeadership(
        Boolean(
          winner &&
            winner.clientId === CLIENT_ID &&
            winner.at === claim.at &&
            this.ownClaimAt === claim.at,
        ),
      )
    }, 260)
  }

  private onBroadcast(payload: BroadcastPayload): void {
    if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') return
    // The three re-reads below are the answer to another tab's edit, not to anything this tab's reader
    // asked for. A refused fetch here leaves this tab showing the profile or theme it already had until
    // the next auth check or a reload, which is the same stale state as a tab that never got the notice;
    // there is no action here to fail, and a toast about another window's save is noise.
    if (payload.type === 'profile-changed') {
      if (payload.clientId !== CLIENT_ID) {
        void useSession.getState().refresh().catch(() => {})
      }
      this.schedulePull(payload.clientId === CLIENT_ID ? 700 : 300, false)
      return
    }
    if (payload.type === 'settings-changed') {
      if (payload.clientId !== CLIENT_ID) {
        void useSession.getState().refreshSettings().catch(() => {})
      }
      this.schedulePull(payload.clientId === CLIENT_ID ? 700 : 400, false)
      return
    }
    if (payload.type === 'site-changed') {
      if (payload.clientId !== CLIENT_ID) {
        void useSession.getState().refresh().catch(() => {})
      }
      return
    }
    if (payload.type === 'outbox-result') {
      if (payload.targetClientId === CLIENT_ID) acknowledgeOutboxResult(payload)
      return
    }
    if (payload.type === 'outbox-base-advanced') {
      if (payload.clientId !== CLIENT_ID) void acknowledgeOutboxBaseAdvanced(payload)
      return
    }
    if (payload.type === 'claim-leader') {
      if (
        payload.clientId === CLIENT_ID ||
        !Number.isFinite(payload.at) ||
        !payload.clientId
      ) {
        return
      }
      if (!this.bestClaim || compareClaims(payload, this.bestClaim) > 0) this.bestClaim = payload
      if (
        this.isLeader &&
        compareClaims(payload, { clientId: CLIENT_ID, at: this.ownClaimAt }) > 0
      ) {
        this.setLeadership(false)
      }
      return
    }
    if (payload.type === 'pulled' && payload.clientId !== CLIENT_ID) {
      if (payload.cursor > useNotes.getState().cursor) this.schedulePull(150, false)
      return
    }
    if (payload.type === 'todos-pulled' && payload.clientId !== CLIENT_ID) {
      // Another tab folded in a task delta this one has not seen. One request, no note pull: the
      // task page on its own is cheaper than the library.
      if (payload.cursor > this.todosCursor) void this.pullTodos(false)
      return
    }
    if (payload.type === 'local-write') {


      this.schedulePull(payload.clientId === CLIENT_ID ? 700 : 400, false)
      // A queued task write is replayed by whichever tab holds the queue lock; this notice is how
      // the others find out a task moved without waiting for their own poll.
      void this.pullTodos()
    }
  }

  private setLeadership(isLeader: boolean): void {
    if (this.isLeader === isLeader) {
      if (isLeader && this.realtimeEnabled && !this.socket) this.connect()
      return
    }
    this.isLeader = isLeader
    if (isLeader) {
      // Taking over the tab group is also taking over the writes the previous leader may have left:
      // the outbox lock is shared by every tab, and a task write has no note store of its own to wait
      // for. The delta is read here too, so a tab that takes over shows what the queue produced.
      void useNotes.getState().replayPending().catch(() => {})
      void this.pullTodos()
      if (this.realtimeEnabled) this.connect()
      return
    }
    window.clearTimeout(this.reconnectTimer)
    window.clearInterval(this.heartbeatTimer)
    this.socket?.close()
    this.socket = null
  }


  private connect(): void {
    if (this.disposed || this.socket) return
    try {
      const url = new URL('/api/sync/ws', location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new WebSocket(url.toString())
      this.socket = socket

      socket.onopen = () => {
        if (this.disposed || !this.isLeader || this.socket !== socket) {
          socket.close()
          return
        }
        this.failures = 0
        this.lastPong = Date.now()
        this.startHeartbeat()

        this.schedulePull(50)
      }

      socket.onmessage = (event) => {
        if (this.disposed || this.socket !== socket) return
        let message: RealtimeMessage
        try {
          const parsed: unknown = JSON.parse(String(event.data))
          if (!isRealtimeMessage(parsed)) return
          message = parsed
        } catch {
          return
        }
        if (message.type === 'pong') {
          this.lastPong = Date.now()
          return
        }
        if (message.type === 'changed') {
          if (message.origin === CLIENT_ID) return
          if (message.cursor > useNotes.getState().cursor) this.schedulePull(180)
          // A task write does not move the note cursor, so the hub's notice arrives with the cursor
          // this tab already has. That is the signal to ask the task stream on its own.
          else void this.pullTodos()
        }
      }

      socket.onclose = () => {
        if (this.socket !== socket) return
        this.socket = null
        window.clearInterval(this.heartbeatTimer)
        if (!this.disposed && this.isLeader) this.scheduleReconnect()
      }

      socket.onerror = () => {
        socket.close()
      }
    } catch {
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    this.failures += 1
    const exponent = Math.min(this.failures - 1, 16)
    const delay = Math.min(MAX_BACKOFF_MS, 800 * 2 ** exponent)
    window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay)
  }

  private startHeartbeat(): void {
    window.clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = window.setInterval(() => {
      if (this.socket?.readyState !== WebSocket.OPEN) return
      if (Date.now() - this.lastPong > HEARTBEAT_MS * 3) {
        this.socket.close()
        return
      }
      this.socket.send(JSON.stringify({ type: 'ping' } satisfies RealtimeMessage))
    }, HEARTBEAT_MS)
  }


  private startPolling(): void {
    window.clearInterval(this.pollTimer)
    this.pollTimer = window.setInterval(() => {
      if (document.hidden || !this.isLeader) return

      const wsHealthy = this.socket?.readyState === WebSocket.OPEN
      if (wsHealthy && Date.now() - this.lastPong < HEARTBEAT_MS * 2) {
        if (Date.now() - this.lastPullAt < SAFETY_POLL_MS) return
      }
      void this.pull(true)
    }, this.pollIntervalMs)
  }

  private schedulePull(delay: number, shouldBroadcast = true): void {
    if (this.disposed) return
    this.scheduledPullShouldBroadcast ||= shouldBroadcast
    const dueAt = Date.now() + Math.max(0, delay)
    if (this.pullTimer && this.pullDueAt <= dueAt) return
    window.clearTimeout(this.pullTimer)
    this.pullDueAt = dueAt
    this.pullTimer = window.setTimeout(() => {
      this.pullTimer = 0
      this.pullDueAt = 0
      const announce = this.scheduledPullShouldBroadcast
      this.scheduledPullShouldBroadcast = false
      void this.pull(announce)
    }, delay)
  }

  private async pull(shouldBroadcast: boolean): Promise<void> {
    if (this.disposed) return
    const cursorBefore = useNotes.getState().cursor
    let pulled = false
    // This is the timer's work, not a reader's. `pulled` stays false, so `lastPullAt` below is not advanced
    // and the next scheduled tick — or the visibility and focus handlers — asks again; the note store keeps
    // its own offline status for the UI. Letting either rejection out here would end the engine's loop.
    try {
      await useNotes.getState().pull()
      pulled = true
    } catch {

    }
    try {

      await useNotes.getState().replayPending()
    } catch {

    }
    // Tasks travel on their own cursor; asking here keeps both streams moving together after a wake,
    // a focus or a poll, and the run coalesces with any task pull already in flight.
    await this.pullTodos(shouldBroadcast)
    if (pulled) {
      this.lastPullAt = Date.now()
      const cursor = useNotes.getState().cursor
      if (shouldBroadcast && cursor > cursorBefore) {
        this.broadcast.post({ type: 'pulled', cursor, clientId: CLIENT_ID })
      }
    }
  }

  /**
   * Fold the task delta into every tab's listing.
   *
   * This is deliberately not part of the note pull: tasks have their own clock and their own page,
   * and a reader on the board should not pay for a note-library read to see a checkbox someone else
   * ticked. One run is in flight at a time; callers that arrive during it share its answer.
   */
  private pullTodos(shouldBroadcast = true): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.todosPull) return this.todosPull
    const tracked = this.fetchTodos(shouldBroadcast).finally(() => {
      if (this.todosPull === tracked) this.todosPull = null
    })
    this.todosPull = tracked
    return tracked
  }

  private async ensureTodosCursor(): Promise<void> {
    if (!this.todosCursorReady) {
      this.todosCursorReady = localDb.getTodosCursor()
        .then((cursor) => { this.todosCursor = Math.max(this.todosCursor, cursor) })
        .catch(() => {})
    }
    await this.todosCursorReady
  }

  private async fetchTodos(shouldBroadcast: boolean): Promise<void> {
    await this.ensureTodosCursor()
    // No network, no request to fail: the queue and the page stay as they are until `online`.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    const since = this.todosCursor
    // Timer, focus and online alike call this without awaiting it. A failed request is the same
    // answer as an unreachable note pull: keep what is on screen and ask again on the next tick.
    try {
      const response = await fetch(`/api/sync/todos?since=${since}`, {
        headers: {
          [CLIENT_HEADER]: '1',
          'X-Inkstone-Origin': CLIENT_ID,
          Accept: 'application/json',
        },
        credentials: 'same-origin',
      })
      if (response.status === 401) {
        location.reload()
        return
      }
      if (!response.ok) throw new Error(`task sync answered ${response.status}`)
      const payload: unknown = await response.json()
      if (!isTodosSyncResponse(payload)) throw new Error('task sync answered an unreadable page')
      applyTodoSync(payload)
      if (payload.cursor > this.todosCursor) {
        this.todosCursor = payload.cursor
        await localDb.setTodosCursor(payload.cursor).catch(() => {})
        if (shouldBroadcast)
          this.broadcast.post({ type: 'todos-pulled', clientId: CLIENT_ID, cursor: payload.cursor })
      }
    } catch (error) {
      console.warn('[inkstone] task sync pull skipped:', error instanceof Error ? error.message : error)
    }
  }

  private onVisibility = () => {
    if (!document.hidden) {
      this.schedulePull(120)
      void this.pullTodos()
      if (this.isLeader && this.realtimeEnabled && !this.socket) this.connect()
    }
  }

  private onFocus = () => {
    // Claims are "latest wins", so re-claiming on every focus made the tab you touched last
    // the permanent leader: each Alt-Tab tore down the previous leader's WebSocket and
    // re-ran a full pull. One reclaim per minute still takes over after the leader closes.
    if (!this.isLeader && Date.now() - this.ownClaimAt > LEADER_RECLAIM_MS) this.claimLeadership()
    this.schedulePull(200)
    void this.pullTodos()
  }

  private onOnline = () => {
    useNotes.getState().setOnline(true)
    this.failures = 0
    this.schedulePull(50)
    // The queue is replayed as soon as the browser says the network is back; waiting for the first
    // poll would leave a task the reader already ticked off still queued.
    void useNotes.getState().replayPending().catch(() => {})
    void this.pullTodos()
    if (this.isLeader && this.realtimeEnabled) this.connect()
  }

  private onOffline = () => {
    useNotes.getState().setOnline(false)
  }


  private onPageHide = () => {
    void useNotes.getState().flush({ immediate: true })
  }
}

/**
 * The smallest shape the task merge reads before trusting a page.
 *
 * The route is this app's own, but a proxy error page or a half-written response must not be folded
 * into the listing: an id, a title and a status are what the merge decides on.
 */
function isTodosSyncResponse(value: unknown): value is TodosSyncResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const page = value as Partial<TodosSyncResponse>
  return Array.isArray(page.todos) &&
    page.todos.every((task) => {
      if (!task || typeof task !== 'object') return false
      const row = task as { id?: unknown; title?: unknown; status?: unknown }
      return typeof row.id === 'string' && typeof row.title === 'string' &&
        (row.status === 'todo' || row.status === 'in_progress' || row.status === 'done')
    }) &&
    Array.isArray(page.deleted) &&
    page.deleted.every((id) => typeof id === 'string') &&
    typeof page.cursor === 'number' && Number.isSafeInteger(page.cursor) && page.cursor >= 0 &&
    typeof page.serverTime === 'number'
}

function isRealtimeMessage(value: unknown): value is RealtimeMessage {  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const message = value as Record<string, unknown>
  if (message.type === 'ping') return true
  if (message.type === 'pong') {
    return typeof message.serverTime === 'number' && Number.isFinite(message.serverTime)
  }
  return message.type === 'changed' &&
    typeof message.cursor === 'number' &&
    Number.isSafeInteger(message.cursor) &&
    message.cursor >= 0 &&
    (message.origin === null || typeof message.origin === 'string')
}

function compareClaims(
  left: { clientId: string; at: number },
  right: { clientId: string; at: number },
): number {
  return left.at - right.at || left.clientId.localeCompare(right.clientId)
}

export function useSyncEngine(): void {
  const realtime = useSession((s) => s.site?.realtimeEnabled ?? false)
  const enabled = useSession((s) => s.settings.sync.realtime)
  const interval = useSession((s) => s.settings.sync.pollIntervalMs)
  const bootstrap = useNotes((s) => s.bootstrap)
  const realtimeEnabled = realtime && enabled
  const engineRef = useRef<SyncEngine | null>(null)

  // The engine is created exactly once; later setting changes are pushed
  // through updateConfig instead of rebuilding the whole engine.
  useEffect(() => {
    let disposed = false
    // The `then` below is the engine start, and it has to run whether or not the boot fetch answered: an
    // un-observed rejection here would skip it and leave this tab with no sync at all, which is worse for
    // the reader than the un-hydrated library the store already shows. The engine first tick pulls again.
    void bootstrap()
      .catch(() => {

      })
      .then(() => {
        if (disposed) return
        const state = useSession.getState()
        engineRef.current = new SyncEngine(
          Boolean(state.site?.realtimeEnabled) && state.settings.sync.realtime,
          Math.max(5000, state.settings.sync.pollIntervalMs),
        )
        engineRef.current.start()
      })

    return () => {
      disposed = true
      engineRef.current?.dispose()
      engineRef.current = null
    }
  }, [bootstrap])

  useEffect(() => {
    engineRef.current?.updateConfig(realtimeEnabled, interval)
  }, [realtimeEnabled, interval])
}
