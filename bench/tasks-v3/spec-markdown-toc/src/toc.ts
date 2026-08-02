export interface TocOptions {
  minDepth?: number;
  maxDepth?: number;
}

/**
 * Generate a markdown table of contents for a markdown document.
 * See SPEC.md at the repository root — it is the single source of truth.
 */
export function generateToc(markdown: string, options: TocOptions = {}): string {
  throw new Error("Not implemented: see SPEC.md");
}
