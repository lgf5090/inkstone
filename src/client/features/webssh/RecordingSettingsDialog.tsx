import { useEffect, useState } from 'react'
import type { WebsshRegionHint } from '@shared/webssh/types'
import { Button } from '../../components/primitives'
import { Input, SettingRow, Switch } from '../../components/form'
import { Modal } from '../../components/overlay'
import { SelectMenu } from '../../components/select-menu'
import { ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'
import { websshApi } from './api'
import { regionOptions } from './egress-regions'

export function RecordingSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [enabled, setEnabled] = useState(false)
  const [autoTrustFirst, setAutoTrustFirst] = useState(true)
  const [days, setDays] = useState(30)
  const [defaultRegion, setDefaultRegion] = useState<'auto' | WebsshRegionHint>('auto')
  const [regionCandidates, setRegionCandidates] = useState('apac, weur, enam, wnam')
  const [fallbackEnabled, setFallbackEnabled] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([websshApi.recordingSettings(), websshApi.egressSettings()])
      .then(([view, egress]) => {
        if (cancelled) return
        setEnabled(view.recording.enabled)
        setAutoTrustFirst(view.hostKeys?.autoTrustFirst ?? true)
        setDays(view.recording.retentionDays)
        setDefaultRegion(egress.defaultRegion)
        setRegionCandidates(egress.regionCandidates.join(', '))
        setFallbackEnabled(egress.fallbackEnabled)
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
      let view = await websshApi.updateRecordingSettings(enabled)
      view = await websshApi.updateHostKeySettings(autoTrustFirst)
      setEnabled(view.recording.enabled)
      setAutoTrustFirst(view.hostKeys.autoTrustFirst)
      setDays(view.recording.retentionDays)
      const candidates = regionCandidates
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean) as WebsshRegionHint[]
      const egress = await websshApi.updateEgressSettings({
        defaultRegion,
        regionCandidates: candidates,
        fallbackEnabled,
      })
      setDefaultRegion(egress.defaultRegion)
      setRegionCandidates(egress.regionCandidates.join(', '))
      setFallbackEnabled(egress.fallbackEnabled)
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
      title={t('webssh.session_settings.title')}
      description={t('webssh.session_settings.description')}
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
      <SettingRow
        title={t('webssh.settings.auto_trust')}
        description={t('webssh.settings.auto_trust_hint')}
      >
        <Switch
          checked={autoTrustFirst}
          onChange={setAutoTrustFirst}
          disabled={loading || saving}
          label={t('webssh.settings.auto_trust')}
        />
      </SettingRow>
      <SettingRow
        title={t('webssh.egress.settings.default_region')}
        description={t('webssh.egress.settings.default_region_hint')}
      >
        <div className="w-[190px]">
          <SelectMenu
            label={t('webssh.egress.settings.default_region')}
            value={defaultRegion}
            onChange={(value) => setDefaultRegion(value as 'auto' | WebsshRegionHint)}
            options={[
              { value: 'auto', label: t('webssh.egress.region.auto') },
              ...regionOptions(),
            ]}
            disabled={loading || saving}
            width={190}
          />
        </div>
      </SettingRow>
      <SettingRow
        title={t('webssh.egress.settings.fallback')}
        description={t('webssh.egress.settings.fallback_hint')}
      >
        <Switch
          checked={fallbackEnabled}
          onChange={setFallbackEnabled}
          disabled={loading || saving}
          label={t('webssh.egress.settings.fallback')}
        />
      </SettingRow>
      <SettingRow
        title={t('webssh.egress.settings.candidates')}
        description={t('webssh.egress.settings.candidates_hint')}
      >
        <Input
          value={regionCandidates}
          onChange={(event) => setRegionCandidates(event.target.value)}
          disabled={loading || saving}
          spellCheck={false}
          className="w-[190px]"
        />
      </SettingRow>
      <p className="mt-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
        {t('webssh.egress.settings.region_note')}
      </p>
      <p className="mt-1 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
        {t('webssh.egress.settings.relay_unavailable')}
      </p>
      {error && <p className="mt-2 text-[length:var(--text-11-5)] text-[var(--danger)]">{error}</p>}
    </Modal>
  )
}
