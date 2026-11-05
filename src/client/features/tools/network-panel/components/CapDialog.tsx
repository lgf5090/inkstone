/**
 * The two ceilings, in one dialog shape.
 *
 * A data cap and a bandwidth cap are both "a number and a unit", and both leave blank for no ceiling.
 * The stored value is always a byte count or a byte rate; the unit is only what the reader typed.
 */
import { useEffect, useState } from 'react'
import { Button } from '../../../../components/primitives'
import { Modal } from '../../../../components/overlay'
import { Field, Input, Segmented } from '../../../../components/form'
import { formatBandwidth, formatBytes } from '@shared/tools/network-panel/engine'
import { t } from '../../../../lib/i18n'

export type CapKind = 'data' | 'speed'

const DATA_UNITS = ['MB', 'GB', 'TB'] as const
const SPEED_UNITS = ['Mbps', 'Gbps'] as const

type DataUnit = (typeof DATA_UNITS)[number]
type SpeedUnit = (typeof SPEED_UNITS)[number]

function dataUnitBytes(unit: DataUnit): number {
  return unit === 'MB' ? 1024 ** 2 : unit === 'GB' ? 1024 ** 3 : 1024 ** 4
}

function speedUnitBytes(unit: SpeedUnit): number {
  return (unit === 'Mbps' ? 1024 ** 2 : 1024 ** 3) / 8
}

export function CapDialog({
  open,
  kind,
  value,
  onClose,
  onApply,
}: {
  open: boolean
  kind: CapKind
  /** The stored ceiling: bytes for data, bytes per second for a speed. */
  value: number
  onClose: () => void
  onApply: (value: number) => void
}) {
  const [amount, setAmount] = useState('')
  const [dataUnit, setDataUnit] = useState<DataUnit>('GB')
  const [speedUnit, setSpeedUnit] = useState<SpeedUnit>('Mbps')

  useEffect(() => {
    if (!open) return
    setAmount('')
    setDataUnit('GB')
    setSpeedUnit('Mbps')
  }, [open, kind])

  const isData = kind === 'data'
  const units = isData ? DATA_UNITS : SPEED_UNITS
  const currentLabel = isData
    ? value > 0 ? formatBytes(value) : t('tools.network_panel.cap.unlimited')
    : value > 0 ? formatBandwidth(value) : t('tools.network_panel.cap.unlimited')

  const apply = () => {
    const numeric = Number(amount)
    if (!amount.trim() || !Number.isFinite(numeric) || numeric <= 0) {
      onApply(0)
      onClose()
      return
    }
    const bytes = Math.floor(numeric * (isData ? dataUnitBytes(dataUnit) : speedUnitBytes(speedUnit)))
    onApply(Math.max(0, bytes))
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isData ? t('tools.network_panel.cap.data_title') : t('tools.network_panel.cap.speed_title')}
      description={t('tools.network_panel.cap.current', { value: currentLabel })}
      width={380}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={apply}>{t('tools.network_panel.cap.apply')}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field
          label={t('tools.network_panel.cap.amount')}
          hint={isData ? t('tools.network_panel.cap.data_hint') : t('tools.network_panel.cap.speed_hint')}
        >
          <Input
            type="number"
            min={1}
            step="any"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder={t('tools.network_panel.cap.blank')}
            autoComplete="off"
          />
        </Field>
        <div role="group" aria-label={t('tools.network_panel.cap.unit')}>
          <Segmented
            label={t('tools.network_panel.cap.unit')}
            value={isData ? dataUnit : speedUnit}
            onChange={(unit) => {
              if (isData) setDataUnit(unit as DataUnit)
              else setSpeedUnit(unit as SpeedUnit)
            }}
            options={units.map((unit) => ({ value: unit, label: unit }))}
          />
        </div>
      </div>
    </Modal>
  )
}
