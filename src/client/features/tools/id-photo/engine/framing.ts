export interface CropRect {
  cropX: number
  cropY: number
  cropWidth: number
  cropHeight: number
}

export interface Size {
  width: number
  height: number
}

export function rotatedBounds(width: number, height: number, rotation: number): Size {
  const radians = ((rotation ?? 0) * Math.PI) / 180
  const cos = Math.abs(Math.cos(radians))
  const sin = Math.abs(Math.sin(radians))
  return {
    width: Math.max(1, Math.round(width * cos + height * sin)),
    height: Math.max(1, Math.round(width * sin + height * cos)),
  }
}

export function clampCrop(rect: CropRect, layer: Size): CropRect {
  const cropWidth = Math.min(layer.width, Math.max(1, Math.round(rect.cropWidth)))
  const cropHeight = Math.min(layer.height, Math.max(1, Math.round(rect.cropHeight)))
  const cropX = Math.min(layer.width - cropWidth, Math.max(0, Math.round(rect.cropX)))
  const cropY = Math.min(layer.height - cropHeight, Math.max(0, Math.round(rect.cropY)))
  return { cropX, cropY, cropWidth, cropHeight }
}

export function cropBounds(layer: Size, targetAspect: number): { maxWidth: number; minWidth: number } {
  const maxWidth = Math.min(layer.width, layer.height * targetAspect)
  return { maxWidth, minWidth: Math.max(MIN_CROP_EDGE, maxWidth / MAX_ZOOM) }
}

export function cropAtWidth(layer: Size, targetAspect: number, requestedWidth: number): CropRect {
  const { maxWidth, minWidth } = cropBounds(layer, targetAspect)
  const cropWidth = Math.min(maxWidth, Math.max(Math.min(minWidth, maxWidth), requestedWidth))
  const cropHeight = cropWidth / targetAspect
  return clampCrop(
    {
      cropWidth,
      cropHeight,
      cropX: (layer.width - cropWidth) / 2,
      cropY: (layer.height - cropHeight) / 2,
    },
    layer,
  )
}

export function cropForZoom(layer: Size, targetAspect: number, zoom: number): CropRect {
  const { maxWidth } = cropBounds(layer, targetAspect)
  return cropAtWidth(layer, targetAspect, maxWidth / Math.min(Math.max(zoom, 1), MAX_ZOOM))
}

export function zoomPercentOf(rect: CropRect, layer: Size, targetAspect: number): number {
  const { maxWidth, minWidth } = cropBounds(layer, targetAspect)
  const span = maxWidth - minWidth
  if (span <= 0) return 0
  return Math.round(Math.min(100, Math.max(0, ((maxWidth - rect.cropWidth) / span) * 100)))
}

export function cropForZoomPercent(layer: Size, targetAspect: number, percent: number): CropRect {
  const { maxWidth, minWidth } = cropBounds(layer, targetAspect)
  const pct = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0
  return cropAtWidth(layer, targetAspect, maxWidth - (pct / 100) * (maxWidth - minWidth))
}

export function zoomCrop(
  rect: CropRect,
  layer: Size,
  targetAspect: number,
  factor: number,
  anchorX: number,
  anchorY: number,
): CropRect {
  const nextWidth = rect.cropWidth / factor
  if (nextWidth > layer.width || nextWidth / targetAspect > layer.height) return rect
  if (nextWidth < MIN_CROP_EDGE) return rect

  const nextHeight = nextWidth / targetAspect
  return clampCrop(
    {
      cropWidth: nextWidth,
      cropHeight: nextHeight,
      cropX: anchorX - (anchorX - rect.cropX) / rect.cropWidth * nextWidth,
      cropY: anchorY - (anchorY - rect.cropY) / rect.cropHeight * nextHeight,
    },
    layer,
  )
}

export function panCrop(rect: CropRect, layer: Size, dx: number, dy: number): CropRect {
  return clampCrop({ ...rect, cropX: rect.cropX - dx, cropY: rect.cropY - dy }, layer)
}

export function panPercent(rect: CropRect, layer: Size): { x: number; y: number } {
  const freeX = layer.width - rect.cropWidth
  const freeY = layer.height - rect.cropHeight
  return {
    x: freeX > 0 ? Math.round((rect.cropX / freeX) * 100) : 50,
    y: freeY > 0 ? Math.round((rect.cropY / freeY) * 100) : 50,
  }
}

export function percentToCrop(
  layer: Size,
  targetAspect: number,
  zoomPercent: number,
  panXPercent: number,
  panYPercent: number,
): CropRect {
  const rect = cropForZoomPercent(layer, targetAspect, zoomPercent)
  const freeX = Math.max(0, layer.width - rect.cropWidth)
  const freeY = Math.max(0, layer.height - rect.cropHeight)
  return clampCrop(
    {
      ...rect,
      cropX: freeX * clampRatio(panXPercent),
      cropY: freeY * clampRatio(panYPercent),
    },
    layer,
  )
}

export const MAX_ZOOM = 4
export const MIN_CROP_EDGE = 24

function clampRatio(percent: number): number {
  if (!Number.isFinite(percent)) return 0.5
  return Math.min(1, Math.max(0, percent / 100))
}
