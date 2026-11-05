/**
 * The driver factory table for the ported providers. Keeping it in one module lets `factory.ts`
 * stay about the vault, the compare-and-swap and the re-authorization signal.
 */
import type { DriverContext, MountDriver } from './contract'
import { create115OpenDriver } from './115open'
import { create123OpenDriver } from './123-open'
import { create189TvDriver } from './189-tv'
import { createAliyunDriveOpenDriver } from './aliyundrive-open'
import { createBaiduNetdiskDriver } from './baidu-netdisk'
import { createDegooDriver } from './degoo'
import { createDropboxDriver } from './dropbox'
import { createFebBoxDriver } from './febbox'
import { createGitHubDriver } from './github'
import { createGoogleDriveDriver } from './google-drive'
import { createGooglePhotoDriver } from './google-photo'
import { createGuangyapanDriver } from './guangyapan'
import { createHalalCloudOpenDriver } from './halalcloud-open'
import { createMediaFireDriver } from './mediafire'
import { createOneDriveDriver } from './onedrive'
import { createOneDriveAppDriver } from './onedrive-app'
import { createPikPakDriver } from './pikpak'
import { createPikPakShareDriver } from './pikpak-share'
import { createQuarkOpenDriver } from './quark-open'
import { createThunderDriver } from './thunder'
import { createWopanDriver } from './wopan'
import { createYandexDriver } from './yandex'

export type DriverFactory = (ctx: DriverContext) => MountDriver

export const driverFactories: Readonly<Record<string, DriverFactory>> = {
  '115open': create115OpenDriver,
  '123_open': create123OpenDriver,
  '189_tv': create189TvDriver,
  aliyundrive_open: createAliyunDriveOpenDriver,
  baidu_netdisk: createBaiduNetdiskDriver,
  degoo: createDegooDriver,
  dropbox: createDropboxDriver,
  febbox: createFebBoxDriver,
  github: createGitHubDriver,
  google_drive: createGoogleDriveDriver,
  google_photo: createGooglePhotoDriver,
  guangyapan: createGuangyapanDriver,
  halalcloud_open: createHalalCloudOpenDriver,
  mediafire: createMediaFireDriver,
  onedrive: createOneDriveDriver,
  onedrive_app: createOneDriveAppDriver,
  pikpak: createPikPakDriver,
  pikpak_share: createPikPakShareDriver,
  quark_open: createQuarkOpenDriver,
  thunder: createThunderDriver,
  wopan: createWopanDriver,
  yandex: createYandexDriver,
}
