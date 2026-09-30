// parseHexColor(hex): Parses a hex color string into an RGBA object.
//
// Supported formats (case-insensitive, optional leading '#'):
//   - 3-digit: RGB (e.g. "F00" or "#F00" -> { r: 255, g: 0, b: 0, a: 1 })
//   - 4-digit: RGBA (e.g. "#F008" -> { r: 255, g: 0, b: 0, a: 0.533 })
//   - 6-digit: RRGGBB (e.g. "#336699" -> { r: 51, g: 102, b: 153, a: 1 })
//   - 8-digit: RRGGBBAA (e.g. "33669980" -> { r: 51, g: 102, b: 153, a: 0.502 })
//
// Notes:
//   - Each 3-digit/4-digit component character 'C' expands to 'CC' (e.g. 'F' -> 0xFF = 255).
//   - Alpha channel 'a' is a number between 0 and 1, rounded to 3 decimal places (Math.round((alpha / 255) * 1000) / 1000).
//   - Returns null for invalid inputs (non-hex characters, invalid lengths, empty string).
//
// TODO: not implemented yet.
export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseHexColor(_hex: string): RgbaColor | null {
  return null;
}
