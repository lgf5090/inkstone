/**
 * A Worker's logs, read when the drawer opens.
 *
 * The route asks Cloudflare for the script's tails; whatever comes back is printed as text because
 * Cloudflare's log shape is not stable enough to table. The loading, empty and failed states are all
 * visible here rather than in the screen, so one failed fetch never blanks the list behind it.
 */
import { useEffect, useState } from 'react'
import { Drawer } from '../../../../components/overlay'
import { cfErrorText } from '../../api/client'
import { workersApi } from '../../api/workers'
import { useCfT } from '../../i18n'
import { stringifyOrPretty } from '../../lib/format'

export function LogsDrawer({
  open,
  onClose,
  accountId,
  name,
}: {
  open: boolean
  onClose: () => void
  accountId: string
  name: string
}) {
  const t = useCfT()
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setContent('')
    setFailed(false)
    setLoading(true)
    void workersApi.getLogs(accountId, name)
      .then((data) => {
        if (!cancelled) setContent(stringifyOrPretty(data))
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setFailed(true)
        setContent(t('cloudflare.workers.get_log_failed', { error: cfErrorText(error) }))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, accountId, name, t])

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={640}
      title={t('cloudflare.workers.log_drawer_title', { name })}
    >
      <div className="space-y-2 p-3">
        {content && (
          <pre className="max-h-[70vh] overflow-auto rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-3 font-mono text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-secondary)]">
            {content}
          </pre>
        )}
        {!content && !loading && !failed && (
          <p className="text-[length:var(--text-13)] text-[var(--text-tertiary)]">
            {t('cloudflare.workers.no_logs')}
          </p>
        )}
        {loading && (
          <p className="py-8 text-center text-[length:var(--text-13)] text-[var(--text-tertiary)]">
            {t('common.loading')}
          </p>
        )}
      </div>
    </Drawer>
  )
}
