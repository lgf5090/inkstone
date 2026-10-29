import { parseCloudDrivePrefs, type CloudDrivePrefs } from '@shared/clouddrive/model'

const VERSION = 'v1'

export function cloudDrivePrefsKey(userId: string): string {
  return `inkstone.clouddrive.prefs.${VERSION}.${userId}`
}

export function readCloudDrivePrefs(userId: string): CloudDrivePrefs {
  try {
    const raw = localStorage.getItem(cloudDrivePrefsKey(userId))
    return parseCloudDrivePrefs(raw ? JSON.parse(raw) : null)
  } catch {
    return parseCloudDrivePrefs(null)
  }
}

export function writeCloudDrivePrefs(userId: string, prefs: CloudDrivePrefs): void {
  try {
    localStorage.setItem(cloudDrivePrefsKey(userId), JSON.stringify(prefs))
  } catch {
    // A full or disabled localStorage only costs the preference, never the drive itself.
    console.warn('[inkstone] CloudDrive preferences could not be saved')
  }
}

export function cloudDriveCssVars(prefs: CloudDrivePrefs): Record<string, string> {
  return {
    '--cd-density': String(prefs.density),
    '--cd-gap': `${prefs.gap}px`,
    '--cd-icon-size': `${prefs.iconSize}px`,
    '--cd-row-height': `${Math.round(36 + (prefs.density / 100) * 28)}px`,
  }
}
