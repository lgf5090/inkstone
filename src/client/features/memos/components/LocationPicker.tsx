import { lazy, Suspense, useEffect, useRef, useState, type ReactElement } from 'react'
import { Search } from 'lucide-react'
import type { MemoLocation } from '@shared/memos/types'
import { Button } from '../../../components/primitives'
import { Field, Input } from '../../../components/form'
import { LoadingBlock } from '../../../components/feedback'
import { Modal } from '../../../components/overlay'
import { InlineErrorBoundary } from '../../../components/ErrorBoundary'
import { localeTag, t } from '../../../lib/i18n'
import {
  coordinateLabel,
  formatCoordinate,
  parseCoordinateInput,
  reverseGeocodePlaceName,
} from '../location'

const LocationPickerMap = lazy(() =>
  import('./LocationPickerMap').then((module) => ({ default: module.LocationPickerMap })))

export interface LocationPickerProps {
  value: MemoLocation | null
  onChange: (value: MemoLocation | null) => void
  onClose: () => void
  enableReverseGeocode?: boolean
}

type ReverseStatus = 'idle' | 'pending' | 'empty' | 'error'

export function LocationPicker({
  value,
  onChange,
  onClose,
  enableReverseGeocode = false,
}: LocationPickerProps): ReactElement {
  const [latitudeText, setLatitudeText] = useState(() => (value ? formatCoordinate(value.latitude) : ''))
  const [longitudeText, setLongitudeText] = useState(() => (value ? formatCoordinate(value.longitude) : ''))
  const [placeholder, setPlaceholder] = useState(value?.placeholder ?? '')
  const [reverseStatus, setReverseStatus] = useState<ReverseStatus>('idle')
  const reverseController = useRef<AbortController | null>(null)
  const latitude = parseCoordinateInput(latitudeText, 'latitude')
  const longitude = parseCoordinateInput(longitudeText, 'longitude')
  const latitudeInvalid = latitudeText.trim() !== '' && latitude === null
  const longitudeInvalid = longitudeText.trim() !== '' && longitude === null
  const point = latitude !== null && longitude !== null
    ? { latitude, longitude }
    : null

  useEffect(() => () => {
    reverseController.current?.abort()
  }, [])

  const cancelReverse = (): void => {
    reverseController.current?.abort()
    reverseController.current = null
    setReverseStatus('idle')
  }

  const pickPoint = (nextLatitude: number, nextLongitude: number): void => {
    cancelReverse()
    setLatitudeText(formatCoordinate(nextLatitude))
    setLongitudeText(formatCoordinate(nextLongitude))
  }

  const changeLatitude = (next: string): void => {
    cancelReverse()
    setLatitudeText(next)
  }

  const changeLongitude = (next: string): void => {
    cancelReverse()
    setLongitudeText(next)
  }

  const lookUpPlace = async (): Promise<void> => {
    if (!point) return
    reverseController.current?.abort()
    const controller = new AbortController()
    reverseController.current = controller
    setReverseStatus('pending')
    try {
      const name = await reverseGeocodePlaceName({
        latitude: point.latitude,
        longitude: point.longitude,
        language: localeTag(),
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      if (!name) {
        setReverseStatus('empty')
        return
      }
      setPlaceholder(name)
      setReverseStatus('idle')
    } catch {
      if (controller.signal.aborted) return
      setReverseStatus('error')
    }
  }

  const clearDraft = (): void => {
    cancelReverse()
    setLatitudeText('')
    setLongitudeText('')
    setPlaceholder('')
  }

  const apply = (): void => {
    if (!point) return
    onChange({
      placeholder: placeholder.trim(),
      latitude: point.latitude,
      longitude: point.longitude,
    })
    onClose()
  }

  const empty = latitudeText === '' && longitudeText === '' && placeholder === ''

  return (
    <Modal
      open
      onClose={onClose}
      title={t('memos.location.title')}
      description={t('memos.location.description')}
      width={560}
      footer={(
        <>
          <Button variant="ghost" className="mr-auto" disabled={empty} onClick={clearDraft}>
            {t('memos.location.clear')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('memos.common.cancel')}
          </Button>
          <Button variant="primary" disabled={!point} onClick={apply}>
            {t('memos.location.apply')}
          </Button>
        </>
      )}
    >
      <div className="space-y-3">
        <div className="h-[240px] overflow-hidden rounded-[var(--r-md)] border border-[var(--border-default)]">
          <InlineErrorBoundary label={t('memos.map.unavailable')}>
            <Suspense fallback={<LoadingBlock label={t('memos.common.loading')} />}>
              <LocationPickerMap
                point={point}
                label={t('memos.location.map_label')}
                onPick={pickPoint}
              />
            </Suspense>
          </InlineErrorBoundary>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={t('memos.location.latitude')}
            required
            hint={latitudeInvalid
              ? <span role="alert" className="text-[var(--danger)]">{t('memos.location.invalid_latitude')}</span>
              : t('memos.location.range_hint')}
          >
            <Input
              value={latitudeText}
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              invalid={latitudeInvalid}
              onChange={(event) => changeLatitude(event.target.value)}
            />
          </Field>
          <Field
            label={t('memos.location.longitude')}
            required
            hint={longitudeInvalid
              ? <span role="alert" className="text-[var(--danger)]">{t('memos.location.invalid_longitude')}</span>
              : t('memos.location.range_hint')}
          >
            <Input
              value={longitudeText}
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              invalid={longitudeInvalid}
              onChange={(event) => changeLongitude(event.target.value)}
            />
          </Field>
        </div>
        <Field label={t('memos.location.place')}>
          <Input
            value={placeholder}
            autoComplete="off"
            placeholder={t('memos.location.place_placeholder')}
            onChange={(event) => setPlaceholder(event.target.value)}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <p role="status" aria-live="polite" className="min-w-0 flex-1 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            {point
              ? t('memos.location.selected_point', { coordinates: coordinateLabel(point.latitude, point.longitude) })
              : t('memos.location.no_point')}
          </p>
          {enableReverseGeocode ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<Search size={13} aria-hidden="true" />}
              loading={reverseStatus === 'pending'}
              disabled={!point}
              onClick={() => void lookUpPlace()}
            >
              {t(reverseStatus === 'pending' ? 'memos.location.reverse_pending' : 'memos.location.reverse')}
            </Button>
          ) : null}
        </div>
        {reverseStatus === 'empty' ? (
          <p role="status" className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            {t('memos.location.reverse_empty')}
          </p>
        ) : null}
        {reverseStatus === 'error' ? (
          <p role="alert" className="text-[length:var(--text-11-5)] text-[var(--danger)]">
            {t('memos.location.reverse_failed')}
          </p>
        ) : null}
      </div>
    </Modal>
  )
}
