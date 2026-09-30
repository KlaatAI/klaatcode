export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseHexColor(hex: string): RgbaColor | null {
  if (typeof hex !== "string") return null;
  let clean = hex.trim();
  if (clean.startsWith("#")) {
    clean = clean.slice(1);
  }

  if (!/^[0-9a-fA-F]+$/.test(clean)) {
    return null;
  }

  let r = 0;
  let g = 0;
  let b = 0;
  let a = 1;

  if (clean.length === 3) {
    r = parseInt(clean[0]! + clean[0]!, 16);
    g = parseInt(clean[1]! + clean[1]!, 16);
    b = parseInt(clean[2]! + clean[2]!, 16);
  } else if (clean.length === 4) {
    r = parseInt(clean[0]! + clean[0]!, 16);
    g = parseInt(clean[1]! + clean[1]!, 16);
    b = parseInt(clean[2]! + clean[2]!, 16);
    const rawA = parseInt(clean[3]! + clean[3]!, 16);
    a = Math.round((rawA / 255) * 1000) / 1000;
  } else if (clean.length === 6) {
    r = parseInt(clean.slice(0, 2), 16);
    g = parseInt(clean.slice(2, 4), 16);
    b = parseInt(clean.slice(4, 6), 16);
  } else if (clean.length === 8) {
    r = parseInt(clean.slice(0, 2), 16);
    g = parseInt(clean.slice(2, 4), 16);
    b = parseInt(clean.slice(4, 6), 16);
    const rawA = parseInt(clean.slice(6, 8), 16);
    a = Math.round((rawA / 255) * 1000) / 1000;
  } else {
    return null;
  }

  return { r, g, b, a };
}
