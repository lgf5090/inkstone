import { useEffect, useState } from 'react'
import { Modal } from '../../../../components/overlay'
import { Button } from '../../../../components/primitives'
import { t } from '../../../../lib/i18n'
import { useUiStore } from '../../../../lib/ui-store'
import type { ShortLink } from '@shared/tools/shortlinks/types'
import { useShortlinksStore } from '../store'
import { shortlinksApi } from '../api'

export function ManageBundleLinksModal() {
  const open = useShortlinksStore((s) => s.manageBundleLinksModalOpen)
  const setOpen = useShortlinksStore((s) => s.setManageBundleLinksModalOpen)
  const activeBundleId = useShortlinksStore((s) => s.activeBundleId)
  const bundles = useShortlinksStore((s) => s.bundles)
  const activeBundleLinks = useShortlinksStore((s) => s.activeBundleLinks)
  const selectBundle = useShortlinksStore((s) => s.selectBundle)
  const fetchBundles = useShortlinksStore((s) => s.fetchBundles)

  const [allUserLinks, setAllUserLinks] = useState<ShortLink[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const bundle = bundles.find((b) => b.id === activeBundleId)

  useEffect(() => {
    if (open && activeBundleId) {
      setLoading(true)
      shortlinksApi
        .getLinks({ limit: 100 })
        .then((res) => {
          setAllUserLinks(res.links || (res as any).items || [])
          setSelectedIds(new Set(activeBundleLinks.map((l) => l.id)))
        })
        .finally(() => setLoading(false))
    }
  }, [open, activeBundleId, activeBundleLinks])

  const handleToggle = (id: number) => {
    const next = new Set(selectedIds)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    setSelectedIds(next)
  }

  const handleSave = async () => {
    if (!activeBundleId) return
    setSaving(true)
    try {
      const currentIds = new Set(activeBundleLinks.map((l) => l.id))
      const toAdd = Array.from(selectedIds).filter((id) => !currentIds.has(id))
      const toRemove = Array.from(currentIds).filter((id) => !selectedIds.has(id))

      if (toAdd.length > 0) {
        await shortlinksApi.addLinksToBundle(activeBundleId, toAdd)
      }
      for (const id of toRemove) {
        await shortlinksApi.removeLinkFromBundle(activeBundleId, id)
      }

      useUiStore.getState().toast(t('tools.shortlinks.settings.save_success'), 'success')
      setOpen(false)
      void selectBundle(activeBundleId)
      void fetchBundles()
    } catch (err) {
      useUiStore.getState().toast((err as Error).message, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title={`${t('tools.shortlinks.bundles.manage_links')}${bundle ? ` - ${bundle.name}` : ''}`}
      width={560}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={handleSave} disabled={saving || loading}>
            {t('common.save')}
          </Button>
        </div>
      }
    >
      <div className="py-2 space-y-3">
        {loading ? (
          <div className="py-8 text-center text-[var(--text-tertiary)] text-[length:var(--text-13)]">
            {t('common.loading')}
          </div>
        ) : (allUserLinks || []).length === 0 ? (
          <div className="py-8 text-center text-[var(--text-tertiary)] text-[length:var(--text-13)]">
            {t('tools.shortlinks.links.empty')}
          </div>
        ) : (
          <div className="max-h-72 overflow-y-auto space-y-1 pr-1">
            {allUserLinks.map((l) => {
              const isChecked = selectedIds.has(l.id)
              const primarySlug = l.slugs.find((s) => s.is_primary)?.slug || l.slugs[0]?.slug
              return (
                <label
                  key={l.id}
                  className="flex items-center gap-3 p-2 rounded-[var(--r-md)] hover:bg-[var(--bg-hover)] cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => handleToggle(l.id)}
                    className="size-4 rounded accent-[var(--accent)]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">
                        /{primarySlug}
                      </span>
                      {l.label && (
                        <span className="truncate text-[length:var(--text-12)] text-[var(--text-secondary)]">
                          {l.label}
                        </span>
                      )}
                    </div>
                    <div className="truncate text-[length:var(--text-11)] text-[var(--text-tertiary)] font-mono">
                      {l.url}
                    </div>
                  </div>
                </label>
              )
            })}
          </div>
        )}
      </div>
    </Modal>
  )
}
