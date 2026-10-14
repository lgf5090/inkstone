/**
 * The contract of `contrast.mjs`, which is written in plain JavaScript because it runs under bare
 * node in the build-time gates. Declaring it here rather than letting every importer fall back to
 * `any` is what keeps `tsc` able to see a changed signature: the tests run the real implementation,
 * so a declaration that drifts from the code shows up as a failing assertion, not as a silent pass.
 *
 * Colours travel as `{ rgb, alpha }` so a translucent tint can be composited over the surface
 * underneath it (`over`) before it is compared (`contrastRatio`).
 */

export interface ParsedColor {
  rgb: number[]
  alpha: number
}

export declare function parseColor(value: string): ParsedColor | null

export declare function radians(degrees: string | number): number

export declare function oklabToRgb(l: number, a: number, b: number): number[]

export declare function linearToSrgb(value: number): number

export declare function relativeLuminance(rgb: number[]): number

export declare function contrastRatio(foreground: number[], background: number[]): number

export declare function over(top: ParsedColor, bottom: number[]): number[]

export declare function near(rgb: number[], other: number[]): boolean

export declare function toHex(rgb: number[]): string
