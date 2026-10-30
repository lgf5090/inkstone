import { beforeEach, describe, expect, it } from 'vitest'
import { useTransferStore, type TransferItem } from '../src/client/features/clouddrive/transfers/useTransferStore'

const HISTORY_VERSION = 'v1'

function historyKey(userId: string): string {
  return `inkstone.clouddrive.transfers.${HISTORY_VERSION}.${userId}`
}

function item(id: string, status: TransferItem['status'], name: string): TransferItem {
  return {
    id,
    kind: 'upload',
    name,
    mime: 'text/plain',
    size: 4,
    transferred: status === 'success' ? 4 : 0,
    status,
    errorKey: null,
    createdAt: 1,
    finishedAt: status === 'success' ? 2 : null,
    mountId: 'primary',
    parentPath: '/',
    entryId: null,
    sessionId: null,
  }
}

beforeEach(() => {
  localStorage.clear()
  useTransferStore.setState({ items: [] })
})

describe('CloudDrive transfer history hydration', () => {
  it('keeps a live successful transfer instead of dropping it between the two lists', () => {
    const userId = 'hydrate-success-live'
    const live = item('tr-1', 'success', 'live.txt')
    localStorage.setItem(historyKey(userId), JSON.stringify([live]))
    useTransferStore.setState({ items: [live] })

    useTransferStore.getState().hydrate(userId)

    expect(useTransferStore.getState().items.map((entry) => entry.id)).toEqual(['tr-1'])
  })

  it('merges history with an active transfer and does not duplicate a shared id', () => {
    const userId = 'hydrate-active-history'
    const active = item('tr-active', 'running', 'active.bin')
    const older = item('tr-old', 'success', 'old.txt')
    localStorage.setItem(historyKey(userId), JSON.stringify([older]))
    useTransferStore.setState({ items: [active] })

    useTransferStore.getState().hydrate(userId)

    expect(useTransferStore.getState().items.map((entry) => entry.id).sort()).toEqual(['tr-active', 'tr-old'])
  })
})
