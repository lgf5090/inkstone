import React, { useEffect, useRef, useState } from 'react'
import { Camera, CameraOff } from 'lucide-react'
import { t } from '../../../../lib/i18n'
import { preprocessImageToCanvas, scanCanvas, type PreprocessOptions, type ScanResult } from './scan-pipeline'

interface CameraScannerProps {
  onScan: (result: ScanResult) => void
  preprocessOptions?: PreprocessOptions
}

export const CameraScanner: React.FC<CameraScannerProps> = ({ onScan, preprocessOptions }) => {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('')
  const [isScanning, setIsScanning] = useState<boolean>(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const streamRef = useRef<MediaStream | null>(null)

  useEffect(() => {
    let isMounted = true

    async function loadCameras() {
      try {
        const allDevices = await navigator.mediaDevices.enumerateDevices()
        if (!isMounted) return
        const videoDevs = allDevices.filter((d) => d.kind === 'videoinput')
        setDevices(videoDevs)
        if (videoDevs.length > 0 && !selectedDeviceId) {
          setSelectedDeviceId(videoDevs[0].deviceId)
        }
      } catch (err) {
        if (isMounted) {
          setErrorMessage(t('tools.qrcode.scanner.camera_permission_denied'))
        }
      }
    }

    loadCameras()

    return () => {
      isMounted = false
    }
  }, [selectedDeviceId])

  useEffect(() => {
    let isMounted = true

    async function startStream() {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop())
        streamRef.current = null
      }

      setErrorMessage(null)

      try {
        const constraints: MediaStreamConstraints = {
          video: selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : { facingMode: 'environment' },
          audio: false,
        }
        const stream = await navigator.mediaDevices.getUserMedia(constraints)
        if (!isMounted) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
        }
      } catch (err) {
        if (isMounted) {
          setErrorMessage(t('tools.qrcode.scanner.camera_start_failed'))
        }
      }
    }

    startStream()

    return () => {
      isMounted = false
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop())
        streamRef.current = null
      }
    }
  }, [selectedDeviceId])

  useEffect(() => {
    let timer: number
    let isCancelled = false

    async function tick() {
      if (!isCancelled && isScanning && videoRef.current && videoRef.current.readyState >= 2) {
        try {
          const processedCanvas = preprocessImageToCanvas(videoRef.current, preprocessOptions)
          const result = await scanCanvas(processedCanvas)
          if (result && !isCancelled) {
            onScan(result)
          }
        } catch {
          // Ignore frame decode errors
        }
      }
      if (!isCancelled) {
        timer = window.setTimeout(tick, 250)
      }
    }

    timer = window.setTimeout(tick, 500)

    return () => {
      isCancelled = true
      clearTimeout(timer)
    }
  }, [isScanning, onScan, preprocessOptions])

  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4">
      <div className="relative aspect-square w-full max-w-[420px] overflow-hidden rounded-xl bg-black">
        <video
          ref={videoRef}
          playsInline
          muted
          className="h-full w-full object-cover"
        />

        {isScanning && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="relative h-60 w-60 rounded-xl border-2 border-primary-500/80 shadow-[0_0_15px_rgba(59,130,246,0.5)]">
              <div className="absolute top-0 left-0 right-0 h-0.5 bg-primary-400 animate-pulse shadow-md" />
            </div>
          </div>
        )}

        {errorMessage && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 p-4 text-center text-xs text-red-300">
            <CameraOff size={32} className="mb-2 text-red-400" />
            <p>{errorMessage}</p>
          </div>
        )}
      </div>

      <div className="flex w-full max-w-[420px] items-center justify-between gap-3">
        {devices.length > 1 && (
          <select
            value={selectedDeviceId}
            onChange={(e) => setSelectedDeviceId(e.target.value)}
            className="flex-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
          >
            {devices.map((d, index) => (
              <option key={d.deviceId || index} value={d.deviceId}>
                {d.label || `Camera ${index + 1}`}
              </option>
            ))}
          </select>
        )}

        <button
          type="button"
          onClick={() => setIsScanning((prev) => !prev)}
          className="flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
        >
          {isScanning ? (
            <>
              <CameraOff size={14} />
              <span>{t('tools.qrcode.scanner.pause_camera')}</span>
            </>
          ) : (
            <>
              <Camera size={14} />
              <span>{t('tools.qrcode.scanner.resume_camera')}</span>
            </>
          )}
        </button>
      </div>
    </div>
  )
}
