export interface TocOptions {
  minDepth?: number;
  maxDepth?: number;
}

/**
 * Generate a markdown table of contents for a markdown document.
 * See SPEC.md at the repository root — it is the single source of truth.
 */
export function generateToc(markdown: string, options: TocOptions = {}): string {
  const minDepth = options.minDepth ?? 1;
  const maxDepth = options.maxDepth ?? 6;
  if (
    !Number.isInteger(minDepth) ||
    !Number.isInteger(maxDepth) ||
    minDepth < 1 ||
    maxDepth > 6 ||
    minDepth > maxDepth
  ) {
    throw new RangeError(
      `invalid depth range: minDepth=${minDepth}, maxDepth=${maxDepth}`
    );
  }

  const lines = markdown.split(/\r?\n/);
  const headings: { depth: number; display: string; base: string }[] = [];

  let inFence = false;
  let fenceChar = "";

  for (const line of lines) {
    const stripped = line.replace(/^[ \t]+/, "");
    if (inFence) {
      const core = stripped.replace(/[ \t]+$/, "");
      if (core.length >= 3 && [...core].every((c) => c === fenceChar)) {
        inFence = false;
      }
      continue;
    }
    const fence = /^(`{3,}|~{3,})/.exec(stripped);
    if (fence) {
      inFence = true;
      fenceChar = fence[1][0];
      continue;
    }

    const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/.exec(line);
    if (!m) continue;
    let text = (m[2] ?? "").replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
    if (text === "") continue;
    if (/^[# \t]+$/.test(text)) continue; // only hashes/whitespace: empty heading
    text = text.replace(/[ \t]+#+[ \t]*$/, "");
    text = text.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
    if (text === "") continue;

    const display = stripInline(text);
    headings.push({ depth: m[1].length, display, base: slugify(display) });
  }

  const counts = new Map<string, number>();
  const out: string[] = [];
  for (const h of headings) {
    const n = counts.get(h.base) ?? 0;
    counts.set(h.base, n + 1);
    const slug = n === 0 ? h.base : `${h.base}-${n}`;
    if (h.depth < minDepth || h.depth > maxDepth) continue;
    out.push(`${"  ".repeat(h.depth - minDepth)}- [${h.display}](#${slug})`);
  }
  return out.join("\n");
}

function stripInline(text: string): string {
  let t = text.replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, "$1");
  t = t.replace(/`/g, "");
  t = t.replace(/\*\*/g, "");
  t = t.replace(/__/g, "");
  t = t.replace(/\*/g, "");
  return t;
}

function slugify(display: string): string {
  return display
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, "")
    .replace(/ /g, "-");
}
