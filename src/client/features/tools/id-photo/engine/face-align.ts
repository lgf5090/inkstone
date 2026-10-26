export interface FaceBoundingBox {
  x: number
  y: number
  width: number
  height: number
}

export interface AlignmentCropResult {
  cropX: number
  cropY: number
  cropWidth: number
  cropHeight: number
  targetWidth: number
  targetHeight: number
}

/**
 * Calculates optimal crop rectangle based on image aspect ratio, face bounding box,
 * and standard passport/ID photo head ratio rules (head accounts for target ratio of total height).
 */
export function calculateOptimalCrop(
  imageWidth: number,
  imageHeight: number,
  targetWidthPx: number,
  targetHeightPx: number,
  faceBox?: FaceBoundingBox,
  headRatio = 0.72,
): AlignmentCropResult {
  const targetAspect = targetWidthPx / targetHeightPx

  if (!faceBox) {
    // Center crop based on target aspect ratio
    let cropWidth: number
    let cropHeight: number

    if (imageWidth / imageHeight > targetAspect) {
      cropHeight = imageHeight
      cropWidth = Math.round(cropHeight * targetAspect)
    } else {
      cropWidth = imageWidth
      cropHeight = Math.round(cropWidth / targetAspect)
    }

    const cropX = Math.max(0, Math.round((imageWidth - cropWidth) / 2))
    const cropY = Math.max(0, Math.round((imageHeight - cropHeight) / 2))

    return {
      cropX,
      cropY,
      cropWidth,
      cropHeight,
      targetWidth: targetWidthPx,
      targetHeight: targetHeightPx,
    }
  }

  // Face-aware intelligent framing
  const faceCenterX = faceBox.x + faceBox.width / 2

  // Total crop height should make face height equal to headRatio * cropHeight
  const estimatedHeadHeight = faceBox.height * 1.25 // Include hair crown to chin
  let cropHeight = Math.round(estimatedHeadHeight / headRatio)
  let cropWidth = Math.round(cropHeight * targetAspect)

  // Clamp if exceeds image boundaries
  if (cropHeight > imageHeight || cropWidth > imageWidth) {
    const scale = Math.min(imageHeight / cropHeight, imageWidth / cropWidth)
    cropHeight = Math.floor(cropHeight * scale)
    cropWidth = Math.floor(cropWidth * scale)
  }

  // Position: top margin typically 10-15% of crop height above crown
  const crownY = Math.max(0, faceBox.y - faceBox.height * 0.25)
  let cropY = Math.round(crownY - cropHeight * 0.12)
  let cropX = Math.round(faceCenterX - cropWidth / 2)

  // Bounds checks
  if (cropX < 0) cropX = 0
  if (cropY < 0) cropY = 0
  if (cropX + cropWidth > imageWidth) cropX = imageWidth - cropWidth
  if (cropY + cropHeight > imageHeight) cropY = imageHeight - cropHeight

  return {
    cropX: Math.max(0, cropX),
    cropY: Math.max(0, cropY),
    cropWidth,
    cropHeight,
    targetWidth: targetWidthPx,
    targetHeight: targetHeightPx,
  }
}
