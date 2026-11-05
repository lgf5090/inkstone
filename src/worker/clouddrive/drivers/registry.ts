/**
 * The driver factory table for the ported providers. Keeping it in one module lets `factory.ts`
 * stay about the vault, the compare-and-swap and the re-authorization signal.
 */
import type { DriverContext, MountDriver } from './contract'
import { createDropboxDriver } from './dropbox'
import { createGoogleDriveDriver } from './google-drive'
import { createOneDriveDriver } from './onedrive'
import { createYandexDriver } from './yandex'

export type DriverFactory = (ctx: DriverContext) => MountDriver

export const driverFactories: Readonly<Record<string, DriverFactory>> = {
  dropbox: createDropboxDriver,
  google_drive: createGoogleDriveDriver,
  onedrive: createOneDriveDriver,
  yandex: createYandexDriver,
}
