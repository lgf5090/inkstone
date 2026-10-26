export type IdPhotoExportFormat = 'jpg' | 'jpeg' | 'png' | 'webp'

export type IdPhotoCategory =
  | 'cn_standard'
  | 'exam_cert'
  | 'intl_passport'
  | 'visa'
  | 'custom'

export interface IdPhotoSpec {
  id: string
  name: string
  category: IdPhotoCategory
  countryCode: string // e.g. 'CN', 'US', 'GB', 'JP', 'KR', 'EU'
  countryNameKey: string
  flagEmoji?: string // e.g. '🇨🇳', '🇺🇸', '🇬🇧', '🇯🇵', '🇰🇷'
  widthMm: number
  heightMm: number
  widthPx: number
  heightPx: number
  dpi: number
  recommendedBgColors: readonly string[] // hex color codes
  faceRatioMin: number // 0.0 - 1.0, e.g. 0.70
  faceRatioMax: number // 0.0 - 1.0, e.g. 0.80
  fileSizeMinKb?: number
  fileSizeMaxKb?: number
  aspectRatioLabel?: string
  descriptionKey?: string
  isBuiltin?: boolean
  isFavorite?: boolean
}

export interface IdPhotoAdjustOptions {
  specId: string
  spec?: IdPhotoSpec
  bgColor: string
  bgType: 'solid' | 'gradient'
  bgGradientEndColor?: string
  feathering: number // 0 - 100 edge smoothing
  brightness: number // -100 - 100
  contrast: number // -100 - 100
  smoothness: number // 0 - 100 (skin smoothing)
  whitening: number // 0 - 100 (skin whitening)
  sharpness: number // 0 - 100
  attireId?: string // formal attire template id
  attireScale?: number // 0.5 - 2.0
  attireOffsetX?: number // px
  attireOffsetY?: number // px
  cropX?: number
  cropY?: number
  cropWidth?: number
  cropHeight?: number
  rotation?: number // degrees -180 to 180
}

export interface IdPhotoRecord {
  id: string
  userId: string
  title: string
  specId: string
  specName: string
  widthPx: number
  heightPx: number
  widthMm: number
  heightMm: number
  dpi: number
  bgColor: string
  optionsJson: string
  r2Key: string
  printR2Key?: string
  fileType: string
  fileSize: number
  createdAt: number
  updatedAt: number
}

export interface IdPhotoUserSettings {
  userId: string
  defaultSpecId: string
  defaultBgColor: string
  defaultDpi: number
  defaultExportFormat: string
  autoSaveHistory: boolean
  autoFaceAlign: boolean
  printPaperSize: '5inch' | '6inch' | 'a4'
  updatedAt: number
}

export interface IdPhotoComplianceReport {
  score: number // 0 - 100
  passed: boolean
  checks: {
    id: string
    titleKey: string
    passed: boolean
    level: 'pass' | 'warning' | 'fail'
    message: string
    currentValue?: string | number
    expectedValue?: string | number
  }[]
}

export interface PrintSheetOptions {
  paperSize: '5inch' | '6inch' | 'a4'
  orientation: 'portrait' | 'landscape'
  gapMm: number
  marginMm: number
  showCropMarks: boolean
  dpi: number
}
