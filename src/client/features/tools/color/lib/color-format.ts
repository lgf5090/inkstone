import type { ColorSettings, ColorSpaceValues } from '@shared/tools/color/types'

export interface ColorSpaceItem {
  key: ColorSettings['defaultFormat'] | 'hsv' | 'oklab'
  label: string
  value: string
}

/**
 * The spaces the studio shows, in the order the panel lists them.
 *
 * The formatting used to live in the panel while `getColorSpaceValues` built the same strings again in a
 * different shape, so the value a reader copied was not the value the shared module had computed.
 */
export function colorSpaceItems(values: ColorSpaceValues): ColorSpaceItem[] {
  return [
    { key: 'hex', label: 'HEX', value: values.hex.toUpperCase() },
    { key: 'rgb', label: 'RGB', value: `rgb(${values.rgb.r}, ${values.rgb.g}, ${values.rgb.b})` },
    { key: 'hsl', label: 'HSL', value: `hsl(${values.hsl.h}, ${values.hsl.s}%, ${values.hsl.l}%)` },
    { key: 'hsv', label: 'HSV', value: `hsv(${values.hsv.h}, ${values.hsv.s}%, ${values.hsv.v}%)` },
    { key: 'cmyk', label: 'CMYK', value: `cmyk(${values.cmyk.c}%, ${values.cmyk.m}%, ${values.cmyk.y}%, ${values.cmyk.k}%)` },
    { key: 'lab', label: 'CIE-LAB', value: `lab(${values.lab.l} ${values.lab.a} ${values.lab.b})` },
    {
      key: 'oklab',
      label: 'OKLab',
      value: `oklab(${values.oklab.l.toFixed(3)} ${values.oklab.a.toFixed(3)} ${values.oklab.b.toFixed(3)})`,
    },
  ]
}

/** The item a copy action should produce for the reader's chosen default format. */
export function formatColorValues(
  values: ColorSpaceValues,
  format: ColorSettings['defaultFormat'],
): ColorSpaceItem {
  const items = colorSpaceItems(values)
  return items.find((item) => item.key === format) ?? items[0]
}
