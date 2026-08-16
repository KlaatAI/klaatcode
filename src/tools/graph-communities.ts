/**
 * Community detection over the file graph (pure, vscode-free; mirrored in the
 * CLI). Louvain modularity maximisation — the same family Graphify uses
 * (Leiden) — LLM-free and cheap: file graphs are hundreds of nodes, not
 * millions.
 *
 * WHY FILES, not symbols: communities exist to answer "which subsystem is
 * this?" — for grouping plan_exploration output, labelling graph-query
 * results, and colouring the G7 visualization. That question is asked at file
 * granularity, and a few hundred nodes keeps recomputation cheap enough to
 * run after every incremental reindex.
 *
 * DETERMINISM: node visiting order is sorted, tie-breaks are by lowest
 * community id, and there is no randomness — the same graph always yields the
 * same partition. Colours in the viz must not reshuffle on every save.
 */

export interface CommunityEdge {
  a: string
  b: string
  w: number
}

const MAX_LEVELS = 5
const MAX_PASSES = 20

/**
 * Louvain over an undirected weighted graph. Returns node → community id,
 * with ids renumbered 0..k-1 by descending community size.
 *
 * Isolated nodes (no edges — common with regex-extracted call graphs) adopt
 * the community most common among files in their directory, so "unconnected
 * but obviously together" files don't each become a one-file community.
 */
export function detectCommunities(nodes: string[], edges: CommunityEdge[]): Map<string, number> {
  const sorted = [...new Set(nodes)].sort()
  const index = new Map<string, number>(sorted.map((n, i) => [n, i]))
  const n = sorted.length
  if (n === 0) return new Map()

  // Aggregate parallel edges; drop self-loops and edges to unknown nodes.
  const adj: Map<number, number>[] = Array.from({ length: n }, () => new Map())
  for (const e of edges) {
    const a = index.get(e.a)
    const b = index.get(e.b)
    if (a === undefined || b === undefined || a === b || !(e.w > 0)) continue
    adj[a].set(b, (adj[a].get(b) ?? 0) + e.w)
    adj[b].set(a, (adj[b].get(a) ?? 0) + e.w)
  }

  // community assignment at the finest level, refined level by level.
  let assign = Array.from({ length: n }, (_, i) => i)
  let curAdj = adj
  let curSelf = new Array<number>(n).fill(0)
  let curCount = n

  for (let level = 0; level < MAX_LEVELS; level++) {
    const prevCount = curCount
    const result = _louvainOneLevel(curAdj, curSelf, curCount)
    if (!result.moved) break
    // Re-map the finest-level assignment through this level's grouping.
    assign = assign.map((c) => result.assign[c])
    if (result.count === prevCount) break // no reduction — stable partition
    const agg = _aggregate(curAdj, curSelf, result.assign, result.count)
    curAdj = agg.adj
    curSelf = agg.selfW
    curCount = agg.count
  }

  // Isolated nodes adopt their directory's dominant community.
  const isolated: number[] = []
  for (let i = 0; i < n; i++) if (adj[i].size === 0) isolated.push(i)
  if (isolated.length > 0 && isolated.length < n) {
    const dirOf = (p: string) => p.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
    const byDir = new Map<string, Map<number, number>>()
    for (let i = 0; i < n; i++) {
      if (adj[i].size === 0) continue
      const d = dirOf(sorted[i])
      const counts = byDir.get(d) ?? new Map<number, number>()
      counts.set(assign[i], (counts.get(assign[i]) ?? 0) + 1)
      byDir.set(d, counts)
    }
    for (const i of isolated) {
      const counts = byDir.get(dirOf(sorted[i]))
      if (!counts) continue
      let best = assign[i]
      let bestCount = 0
      for (const [c, count] of [...counts.entries()].sort((x, y) => x[0] - y[0])) {
        if (count > bestCount) { best = c; bestCount = count }
      }
      assign[i] = best
    }
  }

  // Renumber by community size (desc), path order as tie-break — stable ids.
  const sizes = new Map<number, number>()
  for (const c of assign) sizes.set(c, (sizes.get(c) ?? 0) + 1)
  const order = [...sizes.keys()].sort((a, b) => (sizes.get(b)! - sizes.get(a)!) || (a - b))
  const renumber = new Map<number, number>(order.map((c, i) => [c, i]))

  const out = new Map<string, number>()
  sorted.forEach((node, i) => out.set(node, renumber.get(assign[i])!))
  return out
}

function _louvainOneLevel(
  adj: Map<number, number>[],
  selfW: number[],
  n: number,
): { assign: number[]; count: number; moved: boolean } {
  // Self-loops (aggregated intra-community weight) count twice into a node's
  // degree — dropping them shrinks 2m level-over-level and over-merges across
  // weak bridges (the exact failure the barbell test guards against).
  const degree = adj.map((m, i) => [...m.values()].reduce((s, w) => s + w, 0) + 2 * (selfW[i] ?? 0))
  const m2 = degree.reduce((s, d) => s + d, 0) // = 2m, invariant across levels
  const assign = Array.from({ length: n }, (_, i) => i)
  const commTot = [...degree] // sum of degrees per community
  let movedAny = false

  if (m2 === 0) return { assign, count: n, moved: false }

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let moved = false
    for (let i = 0; i < n; i++) {
      if (adj[i].size === 0) continue
      const current = assign[i]
      // Weights from i into each neighbouring community.
      const links = new Map<number, number>()
      for (const [j, w] of adj[i]) {
        links.set(assign[j], (links.get(assign[j]) ?? 0) + w)
      }
      commTot[current] -= degree[i]
      let best = current
      let bestGain = (links.get(current) ?? 0) - (commTot[current] * degree[i]) / m2
      for (const [c, kIn] of [...links.entries()].sort((a, b) => a[0] - b[0])) {
        if (c === current) continue
        const gain = kIn - (commTot[c] * degree[i]) / m2
        if (gain > bestGain + 1e-12) { best = c; bestGain = gain }
      }
      commTot[best] += degree[i]
      if (best !== current) { assign[i] = best; moved = true; movedAny = true }
    }
    if (!moved) break
  }

  // Compact community ids to 0..k-1 (deterministic: first-seen in node order).
  const remap = new Map<number, number>()
  const compact = assign.map((c) => {
    if (!remap.has(c)) remap.set(c, remap.size)
    return remap.get(c)!
  })
  return { assign: compact, count: remap.size, moved: movedAny }
}

function _aggregate(
  adj: Map<number, number>[],
  selfW: number[],
  assign: number[],
  count: number,
): { adj: Map<number, number>[]; selfW: number[]; count: number } {
  const agg: Map<number, number>[] = Array.from({ length: count }, () => new Map())
  const aggSelf = new Array<number>(count).fill(0)
  for (let i = 0; i < adj.length; i++) {
    aggSelf[assign[i]] += selfW[i] ?? 0
    for (const [j, w] of adj[i]) {
      if (i > j) continue // undirected — count each pair once
      const a = assign[i]
      const b = assign[j]
      if (a === b) {
        aggSelf[a] += w // intra-community weight becomes self-loop weight
        continue
      }
      agg[a].set(b, (agg[a].get(b) ?? 0) + w)
      agg[b].set(a, (agg[b].get(a) ?? 0) + w)
    }
  }
  return { adj: agg, selfW: aggSelf, count }
}

/**
 * Human label per community, LLM-free: the most specific directory shared by
 * (most of) its files. Duplicate labels get a numeric suffix so they stay
 * distinguishable in a legend.
 */
export function labelCommunities(assignments: Map<string, number>): Map<number, string> {
  const files = new Map<number, string[]>()
  for (const [path, c] of assignments) {
    const list = files.get(c) ?? []
    list.push(path)
    files.set(c, list)
  }
  const labels = new Map<number, string>()
  const used = new Map<string, number>()
  for (const c of [...files.keys()].sort((a, b) => a - b)) {
    const paths = files.get(c)!.map((p) => p.replace(/\\/g, '/'))
    let label = _dominantDir(paths)
    const n = used.get(label) ?? 0
    used.set(label, n + 1)
    if (n > 0) label = `${label} (${n + 1})`
    labels.set(c, label)
  }
  return labels
}

function _dominantDir(paths: string[]): string {
  // Majority top-level-ish prefix: walk segments while >=60% of files agree.
  const segLists = paths.map((p) => p.split('/').slice(0, -1))
  const prefix: string[] = []
  for (let depth = 0; depth < 4; depth++) {
    const counts = new Map<string, number>()
    for (const segs of segLists) {
      if (segs.length > depth && prefix.every((s, i) => segs[i] === s)) {
        const seg = segs[depth]
        counts.set(seg, (counts.get(seg) ?? 0) + 1)
      }
    }
    let best: string | null = null
    let bestCount = 0
    for (const [seg, count] of [...counts.entries()].sort()) {
      if (count > bestCount) { best = seg; bestCount = count }
    }
    if (best === null || bestCount < paths.length * 0.6) break
    prefix.push(best)
  }
  return prefix.length > 0 ? prefix.join('/') : (paths.length === 1 ? paths[0] : 'root')
}
