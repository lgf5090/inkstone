import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CloudDriveEntry } from '@shared/clouddrive/model'
import { useSession } from '../../../store/session'
import { clouddriveApi } from '../api'
import { listOffline } from '../offline/store'
import type { EntryIndicators } from './types'

const VERSION_PROBE_CONCURRENCY = 4
const EMPTY_IDS: ReadonlySet<string> = new Set()

/**
 * Status facts that are not part of a directory listing. Shares and offline copies each have one
 * list endpoint; versions are per file, so only files whose timestamp changed after upload are probed.
 * That is the same condition that can produce a predecessor version, and avoids a request per row for
 * the common untouched-file case. Unknown results stay absent rather than being reported as false.
 */
export function useEntryIndicators(
  entries: CloudDriveEntry[],
  external: boolean,
  revision: number,
): EntryIndicators & { reload: () => void; refreshVersions: (ids: string[]) => void } {
  const userId = useSession((state) => state.user?.id ?? '')
  const [sharedIds, setSharedIds] = useState<ReadonlySet<string>>(EMPTY_IDS)
  const [offlineIds, setOfflineIds] = useState<ReadonlySet<string>>(EMPTY_IDS)
  const [versionCounts, setVersionCounts] = useState<Readonly<Record<string, number>>>({})
  const [reloadKey, setReloadKey] = useState(0)
  const [versionRevision, setVersionRevision] = useState(0)
  const versionCache = useRef(new Map<string, number>())
  const versionRequests = useRef(new Set<string>())
  const versionGeneration = useRef(0)

  const reload = useCallback(() => setReloadKey((key) => key + 1), [])
  const refreshVersions = useCallback((ids: string[]) => {
    versionGeneration.current += 1
    for (const id of ids) {
      versionCache.current.delete(id)
      versionRequests.current.delete(id)
    }
    setVersionCounts((current) => {
      const next = { ...current }
      for (const id of ids) delete next[id]
      return next
    })
    setVersionRevision((key) => key + 1)
  }, [])

  useEffect(() => {
    versionCache.current.clear()
    versionRequests.current.clear()
    versionGeneration.current += 1
    setVersionCounts({})
  }, [userId])

  useEffect(() => {
    if (external) {
      setSharedIds(EMPTY_IDS)
      return
    }
    let active = true
    clouddriveApi.shares()
      .then((result) => {
        if (!active) return
        const rows = result.shares as { fileId?: unknown; revokedAt?: unknown; isEnabled?: unknown }[]
        setSharedIds(new Set(rows
          .filter((row) => typeof row.fileId === 'string' && row.fileId.length > 0)
          .filter((row) => row.revokedAt !== null && row.isEnabled !== false)
          .map((row) => row.fileId as string)))
      })
      .catch((error) => {
        // Badges supplement the listing; a failed status lookup must not block opening the folder.
        console.warn('[inkstone] CloudDrive share badges could not be read', error)
      })
    return () => { active = false }
  }, [external, reloadKey, revision])

  useEffect(() => {
    if (external || !userId) {
      setOfflineIds(EMPTY_IDS)
      return
    }
    let active = true
    listOffline(userId)
      .then((rows) => {
        if (active) setOfflineIds(new Set(rows.map((row) => row.id)))
      })
      .catch((error) => {
        // IndexedDB can be disabled; the online listing remains usable without offline badges.
        console.warn('[inkstone] CloudDrive offline badges could not be read', error)
      })
    return () => { active = false }
  }, [external, reloadKey, revision, userId])

  useEffect(() => {
    if (external || !userId) return
    const candidates = entries.filter((entry) => (
      entry.kind === 'file'
      && entry.storageKind !== 'external'
      && entry.modifiedAt !== entry.uploadedAt
      && !versionCache.current.has(entry.id)
      && !versionRequests.current.has(entry.id)
    ))
    if (candidates.length === 0) return
    let active = true
    const generation = versionGeneration.current
    const probe = async (entry: CloudDriveEntry) => {
      versionRequests.current.add(entry.id)
      try {
        const result = await clouddriveApi.versions(entry.id)
        if (active && generation === versionGeneration.current) {
          versionCache.current.set(entry.id, result.versions.length)
        }
        return { id: entry.id, count: result.versions.length }
      } catch (error) {
        console.warn('[inkstone] CloudDrive version badge could not be read', entry.id, error)
        return null
      } finally {
        versionRequests.current.delete(entry.id)
      }
    }
    const run = async () => {
      for (let offset = 0; offset < candidates.length; offset += VERSION_PROBE_CONCURRENCY) {
        const chunk = candidates.slice(offset, offset + VERSION_PROBE_CONCURRENCY)
        const results = (await Promise.all(chunk.map(probe))).filter((result) => result !== null)
        if (!active || generation !== versionGeneration.current) return
        if (results.length > 0) {
          setVersionCounts((current) => {
            const next = { ...current }
            for (const result of results) next[result.id] = result.count
            return next
          })
        }
      }
    }
    void run()
    return () => { active = false }
  }, [entries, external, userId, versionRevision])

  return useMemo<EntryIndicators & { reload: () => void; refreshVersions: (ids: string[]) => void }>(() => ({
    sharedIds,
    offlineIds,
    versionCounts,
    reload,
    refreshVersions,
  }), [offlineIds, refreshVersions, reload, sharedIds, versionCounts])
}
