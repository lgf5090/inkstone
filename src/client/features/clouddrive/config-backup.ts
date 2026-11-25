import { CLIENT_HEADER } from '@shared/constants'

export async function downloadCloudDriveConfigBackup(): Promise<void> {
  const response = await fetch('/api/clouddrive/config/export', {
    credentials: 'same-origin',
    headers: { [CLIENT_HEADER]: '1' },
  })
  if (!response.ok) throw new Error(`CloudDrive config export failed (${response.status})`)
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'clouddrive-config.json'
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
