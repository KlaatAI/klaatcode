/**
 * KlaatTUI — Terminal theme detection + named theme palettes.
 *
 * Queries the terminal's actual background color via OSC 11 (DA1 sequence)
 * and computes luminance to decide whether the terminal is in dark or light mode.
 *
 * Must be called BEFORE entering the alt-screen or raw mode, so stdin is
 * still in canonical mode and can receive the terminal's OSC response.
 *
 * Usage:
 *   const theme   = await detectTheme();   // "dark" | "light"
 *   const palette = getPalette(theme);
 *   // pass palette.accent, palette.dimText, etc. to render functions
 *
 * Falls back to "dark" after 200 ms if the terminal doesn't respond
 * (e.g. dumb terminals, terminals inside CI/CD pipes).
 */

// ─── Palette ──────────────────────────────────────────────────────────────────

export interface ThemePalette {
  /** Primary brand accent — light purple on dark, deep purple on light. */
  accent:       string;
  /** Dim secondary text (CSS/named color or hex). */
  dimText:      string;
  /** Bright user prompt color. */
  userColor:    string;
  /** Border / separator color. */
  border:       string;
  /** Active scrollbar thumb. */
  thumb:        string;
  /** Background override (null = terminal default). */
  bg:           string | null;

  // ── Numeric color slots (256-color palette indices) ──────────────────
  /** Input box cell background. */
  inputBg:      number;
  /** Main chat / message text. */
  chatFg:       number;
  /** Muted / secondary label text. */
  mutedFg:      number;
  /** Tool output text. */
  toolFg:       number;
  /** Inline code foreground. */
  codeFg:       number;
  /** Inline code / code block background. */
  codeBg:       number;
  /** Heading / bold text. */
  headingFg:    number | "white";
  /** Sidebar section label ("Session", "Context" …). */
  sidebarLabel: number;
  /** Sidebar value text. */
  sidebarValue: number;
  /** "You" user-message header. */
  userFg:       number;
  /** Assistant header marker. */
  assistantFg:  number;
}

export const DARK_PALETTE: ThemePalette = {
  accent:       "#d8b4fe",
  dimText:      "gray",
  userColor:    "yellow",
  border:       "#555",
  thumb:        "#555",
  bg:           null,
  inputBg:      235,
  chatFg:       253,
  mutedFg:      245,
  toolFg:       243,
  codeFg:       222,
  codeBg:       236,
  headingFg:    "white",
  sidebarLabel: 245,
  sidebarValue: 252,
  userFg:       219,
  assistantFg:  75,
};
/** Catppuccin Latte — light warm palette */
export const CATPPUCCIN_LATTE_PALETTE: ThemePalette = {
  accent:       "#8839ef",  // mauve
  dimText:      "#acb0be",  // surface2
  userColor:    "#40a02b",  // green
  border:       "#ccd0da",  // surface0
  thumb:        "#bcc0cc",
  bg:           null,
  inputBg:      255,
  chatFg:       236,
  mutedFg:      146,
  toolFg:       240,
  codeFg:       98,   // mauve approx
  codeBg:       254,
  headingFg:    16,
  sidebarLabel: 146,
  sidebarValue: 236,
  userFg:       34,   // green approx
  assistantFg:  98,   // mauve approx
};

/** Catppuccin Frappé — muted mid-tone palette */
export const CATPPUCCIN_FRAPPE_PALETTE: ThemePalette = {
  accent:       "#ca9ee6",  // mauve
  dimText:      "#626880",  // surface2
  userColor:    "#a6d189",  // green
  border:       "#414559",  // surface0
  thumb:        "#51576d",
  bg:           null,
  inputBg:      236,
  chatFg:       252,
  mutedFg:      60,
  toolFg:       245,
  codeFg:       182,  // mauve approx
  codeBg:       237,
  headingFg:    "white",
  sidebarLabel: 60,
  sidebarValue: 252,
  userFg:       150,  // green approx
  assistantFg:  182,  // mauve approx
};

/** Catppuccin Macchiato — dark with teal-tinged surface */
export const CATPPUCCIN_MACCHIATO_PALETTE: ThemePalette = {
  accent:       "#c6a0f6",  // mauve
  dimText:      "#5b6078",  // surface2
  userColor:    "#a6da95",  // green
  border:       "#363a4f",  // surface0
  thumb:        "#494d64",
  bg:           null,
  inputBg:      235,
  chatFg:       252,
  mutedFg:      60,
  toolFg:       245,
  codeFg:       183,  // mauve approx
  codeBg:       236,
  headingFg:    "white",
  sidebarLabel: 60,
  sidebarValue: 252,
  userFg:       150,  // green approx
  assistantFg:  183,  // mauve approx
};

export const LIGHT_PALETTE: ThemePalette = {
  accent:       "#7c3aed",
  dimText:      "#555",
  userColor:    "#92400e",
  border:       "#999",
  thumb:        "#aaa",
  bg:           null,
  inputBg:      254,
  chatFg:       235,
  mutedFg:      240,
  toolFg:       238,
  codeFg:       22,
  codeBg:       252,
  headingFg:    16,
  sidebarLabel: 240,
  sidebarValue: 235,
  userFg:       130,
  assistantFg:  56,
};

/** Dracula — deep dark purple with vivid accents */
export const DRACULA_PALETTE: ThemePalette = {
  accent:       "#bd93f9",  // purple
  dimText:      "#6272a4",  // comment
  userColor:    "#f1fa8c",  // yellow
  border:       "#44475a",  // selection
  thumb:        "#6272a4",
  bg:           null,
  inputBg:      236,
  chatFg:       253,
  mutedFg:      103,  // comment blue
  toolFg:       245,
  codeFg:       141,  // dracula purple
  codeBg:       237,
  headingFg:    "white",
  sidebarLabel: 103,
  sidebarValue: 253,
  userFg:       228,  // yellow
  assistantFg:  141,  // purple
};

/** Nord — cool arctic blue-grey */
export const NORD_PALETTE: ThemePalette = {
  accent:       "#88c0d0",  // nord8 frost
  dimText:      "#4c566a",  // nord3
  userColor:    "#ebcb8b",  // nord13 yellow
  border:       "#3b4252",  // nord1
  thumb:        "#4c566a",
  bg:           null,
  inputBg:      236,
  chatFg:       252,
  mutedFg:      60,   // nord3 mapped
  toolFg:       245,
  codeFg:       110,  // nord8 frost mapped
  codeBg:       237,
  headingFg:    "white",
  sidebarLabel: 60,
  sidebarValue: 252,
  userFg:       222,  // yellow
  assistantFg:  110,  // frost
};

/** Ayu Dark — warm dark with golden accent */
export const AYU_PALETTE: ThemePalette = {
  accent:       "#e6b450",  // golden
  dimText:      "#5c6773",
  userColor:    "#f28779",  // coral
  border:       "#1a1f29",
  thumb:        "#3d4751",
  bg:           null,
  inputBg:      234,
  chatFg:       252,
  mutedFg:      243,
  toolFg:       241,
  codeFg:       214,  // golden
  codeBg:       235,
  headingFg:    "white",
  sidebarLabel: 243,
  sidebarValue: 252,
  userFg:       209,  // coral
  assistantFg:  214,  // golden
};

/** Catppuccin Mocha */
export const CATPPUCCIN_PALETTE: ThemePalette = {
  accent:       "#cba6f7",  // mauve
  dimText:      "#585b70",  // surface2
  userColor:    "#a6e3a1",  // green
  border:       "#313244",  // surface0
  thumb:        "#45475a",
  bg:           null,
  inputBg:      235,
  chatFg:       252,
  mutedFg:      60,   // surface2 approx
  toolFg:       245,
  codeFg:       183,  // mauve approx
  codeBg:       236,
  headingFg:    "white",
  sidebarLabel: 60,
  sidebarValue: 252,
  userFg:       114,  // green approx
  assistantFg:  183,  // mauve approx
};

/** Gruvbox Dark */
export const GRUVBOX_PALETTE: ThemePalette = {
  accent:       "#d3869b",  // pink
  dimText:      "#504945",  // bg2
  userColor:    "#fabd2f",  // yellow
  border:       "#3c3836",  // bg1
  thumb:        "#504945",
  bg:           null,
  inputBg:      235,
  chatFg:       223,  // fg1
  mutedFg:      243,
  toolFg:       241,
  codeFg:       214,  // yellow
  codeBg:       236,
  headingFg:    "white",
  sidebarLabel: 243,
  sidebarValue: 223,
  userFg:       214,  // yellow
  assistantFg:  175,  // pink approx
};

/** Neon — electric blue with vibrant cyan/magenta accents */
export const NEON_PALETTE: ThemePalette = {
  accent:       "#00e5ff",  // electric cyan
  dimText:      "#4a5568",
  userColor:    "#ff6bcb",  // hot pink
  border:       "#1a2744",
  thumb:        "#2d4a7a",
  bg:           null,
  inputBg:      234,
  chatFg:       255,
  mutedFg:      244,
  toolFg:       245,
  codeFg:       51,   // bright cyan
  codeBg:       235,
  headingFg:    "white",
  sidebarLabel: 244,
  sidebarValue: 255,
  userFg:       213,  // hot pink
  assistantFg:  45,   // electric blue
};

/** Synthwave — retro 80s sunset gradient vibes */
export const SYNTHWAVE_PALETTE: ThemePalette = {
  accent:       "#ff7edb",  // hot magenta
  dimText:      "#495495",
  userColor:    "#fede5d",  // golden yellow
  border:       "#2a2139",
  thumb:        "#4a3560",
  bg:           null,
  inputBg:      234,
  chatFg:       253,
  mutedFg:      103,
  toolFg:       245,
  codeFg:       212,  // magenta-pink
  codeBg:       235,
  headingFg:    "white",
  sidebarLabel: 103,
  sidebarValue: 253,
  userFg:       227,  // golden
  assistantFg:  212,  // pink
};

/** Ember — warm fire tones with amber and burnt orange */
export const EMBER_PALETTE: ThemePalette = {
  accent:       "#ff9e64",  // warm amber
  dimText:      "#565f89",
  userColor:    "#73daca",  // mint contrast
  border:       "#292330",
  thumb:        "#3d3450",
  bg:           null,
  inputBg:      234,
  chatFg:       253,
  mutedFg:      244,
  toolFg:       245,
  codeFg:       209,  // salmon
  codeBg:       235,
  headingFg:    "white",
  sidebarLabel: 244,
  sidebarValue: 253,
  userFg:       114,  // mint
  assistantFg:  209,  // salmon-orange
};

/** Matrix — green phosphor terminal aesthetic */
export const MATRIX_PALETTE: ThemePalette = {
  accent:       "#00ff41",  // phosphor green
  dimText:      "#003b00",
  userColor:    "#39ff14",  // neon green
  border:       "#0d1a0d",
  thumb:        "#1a3a1a",
  bg:           null,
  inputBg:      233,
  chatFg:       156,  // soft green
  mutedFg:      22,   // dark green
  toolFg:       28,   // medium green
  codeFg:       46,   // bright green
  codeBg:       234,
  headingFg:    "white",
  sidebarLabel: 28,
  sidebarValue: 156,
  userFg:       48,   // bright mint
  assistantFg:  46,   // vivid green
};

/** Cobalt — deep blue workspace with electric highlights */
export const COBALT_PALETTE: ThemePalette = {
  accent:       "#ffc600",  // golden yellow
  dimText:      "#0088ff",
  userColor:    "#fb94ff",  // soft pink
  border:       "#122d42",
  thumb:        "#1f4662",
  bg:           null,
  inputBg:      234,
  chatFg:       255,
  mutedFg:      67,   // muted blue
  toolFg:       110,
  codeFg:       220,  // gold
  codeBg:       235,
  headingFg:    "white",
  sidebarLabel: 67,
  sidebarValue: 255,
  userFg:       213,  // pink
  assistantFg:  220,  // gold
};

/** Midnight — deep indigo with soft lavender and teal accents */
export const MIDNIGHT_PALETTE: ThemePalette = {
  accent:       "#7dd3fc",  // sky blue
  dimText:      "#475569",
  userColor:    "#c4b5fd",  // lavender
  border:       "#1e1b4b",
  thumb:        "#312e81",
  bg:           null,
  inputBg:      234,
  chatFg:       253,
  mutedFg:      60,
  toolFg:       245,
  codeFg:       117,  // light blue
  codeBg:       235,
  headingFg:    "white",
  sidebarLabel: 60,
  sidebarValue: 253,
  userFg:       183,  // lavender
  assistantFg:  117,  // sky blue
};

/** Tokyo Night — deep navy with cool blue and green accents */
export const TOKYO_NIGHT_PALETTE: ThemePalette = {
  accent:       "#7aa2f7",  // blue
  dimText:      "#7f87b2",  // dark foreground
  userColor:    "#9ece6a",  // green
  border:       "#3b4261",  // terminal black
  thumb:        "#545c7e",
  bg:           null,
  inputBg:      234,
  chatFg:       189,  // pale blue-white
  mutedFg:      103,  // muted lavender-blue
  toolFg:       110,  // cyan-blue
  codeFg:       111,  // bright blue
  codeBg:       235,
  headingFg:    "white",
  sidebarLabel: 103,
  sidebarValue: 189,
  userFg:       149,  // green
  assistantFg:  111,  // blue
};

export type Theme =
  | "dark"
  | "light"
  | "dracula"
  | "nord"
  | "ayu"
  | "catppuccin"
  | "catppuccin-latte"
  | "catppuccin-frappe"
  | "catppuccin-macchiato"
  | "gruvbox"
  | "neon"
  | "synthwave"
  | "ember"
  | "matrix"
  | "cobalt"
  | "midnight"
  | "tokyo-night";

export const THEME_NAMES: Theme[] = [
  "dark", "light", "dracula", "nord", "ayu",
  "catppuccin", "catppuccin-latte", "catppuccin-frappe", "catppuccin-macchiato",
  "gruvbox", "neon", "synthwave", "ember", "matrix", "cobalt", "midnight", "tokyo-night",
];

export const THEME_DESCRIPTIONS: Record<Theme, string> = {
  dark:       "Default dark — black bg, purple accent",
  light:      "Light mode — white bg, deep purple accent",
  dracula:    "Dracula — dark purple with vivid accents",
  nord:       "Nord — cool arctic blue-grey palette",
  ayu:        "Ayu Dark — warm dark with golden accent",
  catppuccin: "Catppuccin Mocha — pastel dark palette",
  "catppuccin-latte":    "Catppuccin Latte — warm light pastel palette",
  "catppuccin-frappe":   "Catppuccin Frappé — muted mid-tone pastel palette",
  "catppuccin-macchiato":"Catppuccin Macchiato — dark teal-tinged pastel palette",
  gruvbox:    "Gruvbox Dark — earthy retro palette",
  neon:       "Neon — electric blue with vibrant cyan glow",
  synthwave:  "Synthwave — retro 80s sunset magenta vibes",
  ember:      "Ember — warm fire tones, amber & burnt orange",
  matrix:     "Matrix — green phosphor terminal aesthetic",
  cobalt:     "Cobalt — deep blue with golden highlights",
  midnight:   "Midnight — indigo depths with sky blue & lavender",
  "tokyo-night": "Tokyo Night — deep navy with cool blue & green",
};

export function getPalette(theme: Theme): ThemePalette {
  switch (theme) {
    case "light":      return LIGHT_PALETTE;
    case "dracula":    return DRACULA_PALETTE;
    case "nord":       return NORD_PALETTE;
    case "ayu":        return AYU_PALETTE;
    case "catppuccin": return CATPPUCCIN_PALETTE;
    case "catppuccin-latte":      return CATPPUCCIN_LATTE_PALETTE;
    case "catppuccin-frappe":     return CATPPUCCIN_FRAPPE_PALETTE;
    case "catppuccin-macchiato":  return CATPPUCCIN_MACCHIATO_PALETTE;
    case "gruvbox":    return GRUVBOX_PALETTE;
    case "neon":       return NEON_PALETTE;
    case "synthwave":  return SYNTHWAVE_PALETTE;
    case "ember":      return EMBER_PALETTE;
    case "matrix":     return MATRIX_PALETTE;
    case "cobalt":     return COBALT_PALETTE;
    case "midnight":   return MIDNIGHT_PALETTE;
    case "tokyo-night": return TOKYO_NIGHT_PALETTE;
    default:           return DARK_PALETTE;
  }
}

// ─── Detection ────────────────────────────────────────────────────────────────

/**
 * Query the terminal's background color via OSC 11.
 * Returns "dark" or "light" based on luminance.
 * Resolves in < 200 ms; defaults to "dark" on timeout or non-TTY.
 */
export async function detectTheme(): Promise<Theme> {
  // Only attempt on real TTYs
  if (!process.stdout.isTTY || !process.stdin.isTTY) return "dark";

  return new Promise<Theme>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onData: ((chunk: Buffer | string) => void) | null = null;

    function finish(theme: Theme): void {
      if (done) return;
      done = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (onData) {
        process.stdin.removeListener("data", onData);
        onData = null;
      }
      // Restore canonical mode
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
      process.stdin.setEncoding("utf8");
      process.stdin.pause();
      resolve(theme);
    }

    onData = (chunk: Buffer | string) => {
      const data = typeof chunk === "string" ? chunk : chunk.toString("binary");
      // OSC 11 response: \x1b]11;rgb:RRRR/GGGG/BBBB\x07  or  ...\x1b\\
      const m = data.match(/\x1b\]11;rgb:([0-9a-f]{4})\/([0-9a-f]{4})\/([0-9a-f]{4})/i);
      if (!m) return;
      // 16-bit component values — take the high byte (first two hex digits)
      const r = parseInt(m[1]!.slice(0, 2), 16);
      const g = parseInt(m[2]!.slice(0, 2), 16);
      const b = parseInt(m[3]!.slice(0, 2), 16);
      // Relative luminance (ITU-R BT.709 coefficients)
      const lum = 0.2126 * (r / 255) + 0.7152 * (g / 255) + 0.0722 * (b / 255);
      finish(lum > 0.5 ? "light" : "dark");
    };

    // Enter raw mode temporarily so we receive the terminal's response
    try {
      process.stdin.setRawMode(true);
      process.stdin.setEncoding("binary");
      process.stdin.resume();
      process.stdin.on("data", onData);
    } catch {
      // Can't enter raw mode — give up
      finish("dark");
      return;
    }

    // Send OSC 11 query
    process.stdout.write("\x1b]11;?\x07");

    // Timeout: default to dark after 200 ms
    timer = setTimeout(() => finish("dark"), 200);
  });
}
