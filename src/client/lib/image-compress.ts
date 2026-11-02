/**
 * Shrink a picture before it is attached.
 *
 * The provider bills an image by its pixels, and a screenshot or camera photo is usually far larger than
 * the model needs. The quality value controls both dimensions and JPEG quality, as the reference project's
 * one slider did: 60 means 60% of the original size and 60% quality, not two separate knobs. A transparent
 * image stays PNG; an animated image is left alone because one frame would lose the rest.
 */
export async function compressImageFile(file: File, qualityPercent: number): Promise<File> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.type === 'image/svg+xml') return file
  const quality = Math.min(1, Math.max(0.3, qualityPercent / 100))
  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(file)
    const scale = Math.min(1, quality)
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return file
    context.drawImage(bitmap, 0, 0, width, height)
    const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, quality))
    if (!blob || blob.size >= file.size) return file
    const extension = mime === 'image/png' ? 'png' : 'jpg'
    const name = file.name.replace(/\.[^.]+$/, '') || 'image'
    return new File([blob], `${name}.${extension}`, { type: mime, lastModified: file.lastModified })
  } catch {
    // A browser that cannot decode the picture is not a reason to lose it: the original uploads as it is.
    return file
  } finally {
    bitmap?.close()
  }
}
