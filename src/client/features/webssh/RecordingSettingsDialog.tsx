import { useEffect, useState } from 'react'
import { Button } from '../../components/primitives'
import { SettingRow, Switch } from '../../components/form'
import { Modal } from '../../components/overlay'
import { ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'
import { websshApi } from './api'

export function RecordingSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [enabled, setEnabled] = useState(false)
  const [days, setDays] = useState(30)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    websshApi.recordingSettings()
      .then((view) => {
        if (cancelled) return
        setEnabled(view.recording.enabled)
        setDays(view.recording.retentionDays)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof ApiError ? caught.message : t('webssh.error.generic'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const view = await websshApi.updateRecordingSettings(enabled)
      setEnabled(view.recording.enabled)
      setDays(view.recording.retentionDays)
      onClose()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('webssh.error.generic'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('webssh.recording.title')}
      description={t('webssh.recording.description')}
      width={460}
      footer={
        <>
          <Button onClick={onClose}>{t('webssh.actions.cancel')}</Button>
          <Button variant="primary" onClick={() => void save()} loading={saving} disabled={loading || saving}>
            {t('webssh.actions.save')}
          </Button>
        </>
      }
    >
      <SettingRow
        title={t('webssh.recording.enabled')}
        description={t('webssh.recording.enabled_hint', { days })}
      >
        <Switch
          checked={enabled}
          onChange={setEnabled}
          disabled={loading || saving}
          label={t('webssh.recording.enabled')}
        />
      </SettingRow>
      {error && <p className="mt-2 text-[length:var(--text-11-5)] text-[var(--danger)]">{error}</p>}
    </Modal>
  )
}
