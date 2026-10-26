export type QrContentType = 'text' | 'url' | 'wifi' | 'vcard' | 'email' | 'phone'

export interface QrWifiContent {
  ssid: string
  password?: string
  encryption: 'WPA' | 'WEP' | 'none'
  hidden?: boolean
}

export interface QrVCardContent {
  firstName: string
  lastName?: string
  phone?: string
  mobile?: string
  email?: string
  organization?: string
  title?: string
  url?: string
  address?: string
}

export interface QrEmailContent {
  to: string
  subject?: string
  body?: string
}

export interface QrPhoneContent {
  phone: string
  message?: string
}

export type QrRecord = QrCodeRecord
export type QrTemplate = QrCodeTemplate
export type QrSettings = QrCodeSettings

export type QrExportFormat = 'png' | 'jpg' | 'jpeg' | 'svg' | 'webp'

export type QrErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H'

export type QrTemplateCategory = 'minimal' | 'frame' | 'artistic' | 'scenario'

export type QrPresetCategory = QrTemplateCategory

export type QrElementShape =
  | 'square'
  | 'dots'
  | 'circle'
  | 'rounded'
  | 'classy'
  | 'classy-rounded'
  | 'diamonds'

export type QrDotType =
  | 'square'
  | 'dots'
  | 'rounded'
  | 'classy'
  | 'classy-rounded'
  | 'extra-rounded'
  | 'diamonds'

export type QrEyeShape =
  | 'square'
  | 'rounded'
  | 'circle'
  | 'leaf'
  | 'pointed'
  | 'leaf-diagonal'
  | 'leaf-pointed'

export type QrCornerSquareType = 'dot' | 'square' | 'extra-rounded'

export type QrCornerDotType = 'dot' | 'square'

export type QrFrameType =
  | 'none'
  | 'dark-green'
  | 'red-blue'
  | 'three-color'
  | 'heart'
  | 'liquid-stamp'
  | 'pacman'
  | 'meme-bubble'
  | 'mushroom'

export type QrGradientType = 'linear' | 'radial'

export interface QrColorStop {
  offset: number
  color: string
}

export interface QrGradient {
  type: QrGradientType
  rotation?: number
  colorStops: QrColorStop[]
}

export type QrLogoShape = 'original' | 'rounded' | 'circle'

export interface QrLogoOptions {
  src?: string
  url?: string
  dataUrl?: string
  logoId?: string
  shape?: QrLogoShape
  size?: number
  sizeRatio?: number
  margin?: number
  shadow?: boolean
  hasShadow?: boolean
  hideBackgroundDots?: boolean
  clearBackground?: boolean
}

export interface QrTextOptions {
  enabled?: boolean
  content?: string
  text?: string
  fontFamily?: string
  fontSize?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  color?: string
  position?: 'bottom' | 'top'
}

export type QrCaptionOptions = QrTextOptions

export interface QrFrameOptions {
  type?: QrFrameType
  label?: string
  text?: string
  subtext?: string
  color?: string
  secondaryColor?: string
}

export interface QrDotsOptions {
  type: QrDotType
  color?: string
  gradient?: QrGradient
}

export interface QrCornersSquareOptions {
  type?: QrCornerSquareType
  color?: string
  gradient?: QrGradient
}

export interface QrCornersDotOptions {
  type?: QrCornerDotType
  color?: string
  gradient?: QrGradient
}

export interface QrBackgroundOptions {
  color?: string
  gradient?: QrGradient
}

export interface QrStylingOptions {
  width?: number
  height?: number
  margin?: number
  errorCorrectionLevel: QrErrorCorrectionLevel
  dotsOptions: QrDotsOptions
  cornersSquareOptions: QrCornersSquareOptions
  cornersDotOptions: QrCornersDotOptions
  backgroundOptions: QrBackgroundOptions
  logoOptions?: QrLogoOptions
  imageOptions?: QrLogoOptions
  frameOptions?: QrFrameOptions
  textOptions?: QrTextOptions
  caption?: QrCaptionOptions
  eyeShape?: QrEyeShape
  [key: string]: unknown
}

export type QrCodeOptions = QrStylingOptions

export interface OnlineLogo {
  id: string
  name: string
  nameKey: string
  category?: 'social' | 'payment' | 'util'
  svg: string
  dataUrl: string
}

export interface QrPreset {
  id: string
  name: string
  nameKey: string
  category: QrPresetCategory
  description?: string
  previewSvg?: string
  options: QrStylingOptions
}

export interface QrCodeRecord {
  id: string
  userId?: string
  title: string
  contentType: QrContentType
  contentRaw: string
  optionsJson: string
  r2Key: string
  fileType: QrExportFormat
  fileSize: number
  width: number
  height: number
  createdAt: number
  updatedAt: number
}

export interface QrCodeTemplate {
  id: string
  userId?: string
  name: string
  category: QrTemplateCategory
  previewSvg: string
  optionsJson: string
  isBuiltin: boolean
  sort: number
  createdAt: number
  updatedAt: number
}

export interface QrCodeSettings {
  defaultErrorCorrection: QrErrorCorrectionLevel
  defaultSize: number
  defaultFormat: QrExportFormat
  autoSaveHistory: boolean
  updatedAt: number
}
