import type { PresenterSyncMessage } from './use-presenter-channel'

/** A `BroadcastChannel` for jsdom, which does not have one. It records every post before delivering it,
 * so a test can ask how much traffic a hook produced rather than only what arrived — the difference
 * between "the presenter got the state" and "the show spoke to nobody". */
export class MockBroadcastChannel {
  name: string
  onmessage: ((event: MessageEvent) => void) | null = null
  closed = false

  constructor(name: string) {
    this.name = name
    openChannels.add(this)
  }

  postMessage(data: unknown) {
    if (this.closed) return
    posts.push({ name: this.name, data: data as PresenterSyncMessage })
    for (const channel of openChannels) {
      if (channel !== this && channel.name === this.name && !channel.closed && channel.onmessage) {
        queueMicrotask(() => {
          if (!channel.closed && channel.onmessage) channel.onmessage({ data } as MessageEvent)
        })
      }
    }
  }

  close() {
    this.closed = true
    openChannels.delete(this)
  }
}

let openChannels = new Set<MockBroadcastChannel>()
let posts: { name: string; data: PresenterSyncMessage }[] = []

/** Clears both registries. The posts must be cleared too, or a case counts its predecessor's traffic. */
export function resetChannelRegistry(): void {
  openChannels = new Set()
  posts = []
}

export function openChannelCount(): number {
  return openChannels.size
}

export function openChannelNames(): string[] {
  return [...openChannels].map((channel) => channel.name)
}

/** The broadcasts that carry state, as opposed to the handshake and the commands. */
export function syncPostCount(): number {
  return posts.filter((post) => post.data.type === 'sync').length
}

/** Lets every `queueMicrotask` delivery the mock does land before the assertion after it. */
export function flushed(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}
