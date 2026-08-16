/**
 * Unchanged-read short-circuit (pure, vscode-free; mirrored in the CLI).
 *
 * A re-read of the exact same range of an unmutated file within a short window
 * is pure waste: the content is still in the model's context (every compaction
 * layer — client and gateway — keeps the last ~6 turns intact). Returning a
 * ~20-token notice instead of a full page is the cheapest fix for what W3.1
 * telemetry counts as `true_rereads`.
 *
 * The window matters: beyond it, the gateway's skeletonizer may have compacted
 * the earlier read out of context and explicitly tells the model to "re-read
 * the file for full content" — a short-circuit there would fight the compactor
 * and strand the model. So: same range + same mtime + recent → skip; anything
 * else → serve the read.
 *
 * mtime equality doubles as invalidation: the model's own writes and external
 * edits both change mtime, so no forget() wiring is needed at mutation sites.
 */

/** Re-reads inside this window are redundant; beyond it they may be context recovery. */
export const REDUNDANT_READ_WINDOW_MS = 180_000

/** Ranges remembered per path — enough for a paging walk, bounded for memory. */
const MAX_RANGES_PER_PATH = 8

interface RangeRecord {
  offset: number
  limit: number
  /** Last line actually shown (may be < offset+limit-1 when byte-capped). */
  shownEnd: number
  totalLines: number
  atMs: number
}

interface PathRecord {
  mtimeMs: number
  ranges: RangeRecord[]
}

export interface RedundantVerdict {
  redundant: boolean
  /** Populated when redundant, for building the notice. */
  shownEnd?: number
  totalLines?: number
  secondsAgo?: number
}

export class ReadDedupTracker {
  private _paths = new Map<string, PathRecord>()

  /** Record a served read. `shownEnd` is the last line number actually returned. */
  note(
    path: string,
    mtimeMs: number,
    offset: number,
    limit: number,
    shownEnd: number,
    totalLines: number,
    nowMs: number,
  ): void {
    let rec = this._paths.get(path)
    if (!rec || rec.mtimeMs !== mtimeMs) {
      rec = { mtimeMs, ranges: [] }
      this._paths.set(path, rec)
    }
    rec.ranges = rec.ranges.filter(r => !(r.offset === offset && r.limit === limit))
    rec.ranges.push({ offset, limit, shownEnd, totalLines, atMs: nowMs })
    if (rec.ranges.length > MAX_RANGES_PER_PATH) rec.ranges.shift()
  }

  /**
   * Is this read redundant right now? Redundant means either an identical
   * (offset, limit) pair, or a range fully CONTAINED in one already served
   * (a model paging 350-449 then asking 380-479 gets nothing new — seen in
   * the wild). Paging to genuinely new lines is never short-circuited: any
   * requested line past a served range's shownEnd serves the read.
   */
  check(path: string, mtimeMs: number, offset: number, limit: number, nowMs: number): RedundantVerdict {
    const rec = this._paths.get(path)
    if (!rec || rec.mtimeMs !== mtimeMs) return { redundant: false }
    const requestedEnd = offset + Math.max(1, limit) - 1
    const match = rec.ranges.find(r =>
      (r.offset === offset && r.limit === limit) ||
      (offset >= r.offset && requestedEnd <= r.shownEnd),
    )
    if (!match) return { redundant: false }
    if (nowMs - match.atMs > REDUNDANT_READ_WINDOW_MS) return { redundant: false }
    return {
      redundant: true,
      shownEnd: match.shownEnd,
      totalLines: match.totalLines,
      secondsAgo: Math.max(1, Math.round((nowMs - match.atMs) / 1000)),
    }
  }

  clear(): void {
    this._paths.clear()
  }
}

/** The ~20-token replacement for a redundant page. Must stay actionable. */
export function redundantReadNotice(
  relPath: string,
  offset: number,
  verdict: RedundantVerdict,
): string {
  const end = verdict.shownEnd ?? offset
  const total = verdict.totalLines ?? end
  const ago = verdict.secondsAgo ?? 0
  return (
    `${relPath} is unchanged — you already read lines ${offset}-${end} of ${total} ` +
    `${ago}s ago (still in your context). Skipped to save tokens. ` +
    `Use a different offset/limit for another range; a fresh read is served automatically once the file changes.`
  )
}
