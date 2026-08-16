/**
 * Interactive code-graph visualization (G7) — pure, vscode-free; mirrored in
 * the CLI. One generator, two hosts:
 *
 *   VS Code  → webview HTML (vscodeBridge: click posts {type:'open', file})
 *   CLI      → graph.html written to disk and opened in the browser
 *
 * SELF-CONTAINED by hard requirement: inline CSS + JS, zero external
 * resources — the webview CSP forbids CDNs and the CLI export must work
 * offline. The force layout is ~80 lines of plain JS (grid-bucketed
 * repulsion + edge springs + community gravity), which is all a few hundred
 * file nodes need; a D3 dependency would buy nothing but a supply chain.
 *
 * Node colour = G4 community (deterministic — same graph, same colours),
 * node size = degree (god nodes visibly larger), click = open (VS Code) /
 * highlight neighbours (browser), legend toggles communities, search dims
 * non-matches.
 */

export interface GraphVizNode {
  file: string
  community: number
  communityLabel: string
  degree: number
  symbolCount: number
}

export interface GraphVizEdge {
  a: string
  b: string
  w: number
}

export interface GraphVizData {
  projectName: string
  nodes: GraphVizNode[]
  edges: GraphVizEdge[]
  /** Draw node names beside the dots — for small graphs (persona/memory view)
   *  where the text IS the content. Code graphs leave this off (hover works). */
  showLabels?: boolean
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function renderGraphHtml(data: GraphVizData, opts?: { vscodeBridge?: boolean }): string {
  const bridge = opts?.vscodeBridge === true
  // <-escape so a pathological "</script>" in a path can't break out.
  const json = JSON.stringify(data).replace(/</g, '\\u003c')

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${esc(data.projectName)} — KlaatAI Code Graph</title><style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #14161f;
               color: #cfd3e0; font: 12px/1.4 system-ui, sans-serif; }
  #wrap { position: relative; width: 100%; height: 100%; }
  canvas { display: block; width: 100%; height: 100%; cursor: grab; }
  canvas.dragging { cursor: grabbing; }
  #hud { position: absolute; top: 10px; left: 12px; pointer-events: none; }
  #hud h1 { margin: 0 0 2px; font-size: 14px; color: #e8eaf2; }
  #hud .sub { opacity: .6; font-size: 11px; }
  #search { position: absolute; top: 10px; right: 12px; width: 200px; padding: 5px 8px;
            background: #1d2030; border: 1px solid #333850; border-radius: 6px;
            color: #e8eaf2; outline: none; }
  #search:focus { border-color: #5a6aef; }
  #legend { position: absolute; bottom: 10px; left: 12px; max-height: 45%;
            overflow-y: auto; background: #1a1d2add; border: 1px solid #2a2e42;
            border-radius: 8px; padding: 6px 8px; }
  #legend .row { display: flex; align-items: center; gap: 6px; padding: 2px 4px;
                 border-radius: 4px; cursor: pointer; white-space: nowrap; }
  #legend .row:hover { background: #262a3d; }
  #legend .row.off { opacity: .35; }
  #legend .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  #legend .n { opacity: .55; margin-left: auto; padding-left: 10px; }
  #tip { position: absolute; display: none; pointer-events: none; background: #1d2030;
         border: 1px solid #3a3f5c; border-radius: 6px; padding: 6px 9px; max-width: 380px;
         box-shadow: 0 4px 16px #0008; }
  #tip .f { color: #e8eaf2; word-break: break-all; }
  #tip .m { opacity: .6; font-size: 11px; margin-top: 2px; }
</style></head>
<body>
<div id="wrap">
  <canvas id="cv"></canvas>
  <div id="hud"><h1></h1><div class="sub"></div></div>
  <input id="search" type="search" placeholder="search files…" spellcheck="false">
  <div id="legend"></div>
  <div id="tip"><div class="f"></div><div class="m"></div></div>
</div>
<script type="application/json" id="graph-data">${json}</script>
<script>
(function () {
  'use strict';
  var DATA = JSON.parse(document.getElementById('graph-data').textContent);
  var BRIDGE = ${bridge ? 'true' : 'false'};
  var vscode = BRIDGE && typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;

  var cv = document.getElementById('cv');
  var ctx = cv.getContext('2d');
  var tip = document.getElementById('tip');

  // ── deterministic colours: golden-angle hue walk over community ids ──
  function colorOf(c) { return 'hsl(' + ((c * 137.508 + 210) % 360) + ' 62% 62%)'; }

  // ── model ──
  var nodes = DATA.nodes.map(function (n, i) { return {
    i: i, file: n.file, comm: n.community, label: n.communityLabel,
    deg: n.degree, syms: n.symbolCount,
    r: Math.min(11, 2.5 + Math.sqrt(n.degree || 0) * 1.3),
    x: 0, y: 0, vx: 0, vy: 0,
  }; });
  var byFile = {};
  nodes.forEach(function (n) { byFile[n.file] = n; });
  var edges = DATA.edges
    .map(function (e) { return { s: byFile[e.a], t: byFile[e.b], w: e.w }; })
    .filter(function (e) { return e.s && e.t; });
  var neigh = nodes.map(function () { return []; });
  edges.forEach(function (e) { neigh[e.s.i].push(e.t.i); neigh[e.t.i].push(e.s.i); });

  // ── deterministic seeded layout start: communities around a ring ──
  var seed = 42;
  function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
  var comms = {};
  nodes.forEach(function (n) { (comms[n.comm] = comms[n.comm] || []).push(n); });
  var commIds = Object.keys(comms).map(Number).sort(function (a, b) { return a - b; });
  var R = 90 + Math.sqrt(nodes.length) * 22;
  commIds.forEach(function (c, k) {
    var ang = (k / Math.max(1, commIds.length)) * Math.PI * 2;
    var cx = Math.cos(ang) * R, cy = Math.sin(ang) * R;
    comms[c].forEach(function (n) {
      var a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * (30 + Math.sqrt(comms[c].length) * 9);
      n.x = cx + Math.cos(a) * d; n.y = cy + Math.sin(a) * d;
    });
  });

  // ── force simulation: grid-bucketed repulsion + springs + community pull ──
  var CELL = 46;
  function tick(alpha) {
    var grid = {};
    nodes.forEach(function (n) {
      var key = Math.floor(n.x / CELL) + ':' + Math.floor(n.y / CELL);
      (grid[key] = grid[key] || []).push(n);
    });
    nodes.forEach(function (n) {
      var gx = Math.floor(n.x / CELL), gy = Math.floor(n.y / CELL);
      for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
        var cell = grid[(gx + dx) + ':' + (gy + dy)];
        if (!cell) continue;
        for (var q = 0; q < cell.length; q++) {
          var m = cell[q];
          if (m.i <= n.i) continue;
          var ddx = n.x - m.x, ddy = n.y - m.y;
          var d2 = ddx * ddx + ddy * ddy || 0.01;
          if (d2 > CELL * CELL * 2.25) continue;
          var f = (alpha * 340) / d2;
          var fx = ddx * f, fy = ddy * f;
          n.vx += fx; n.vy += fy; m.vx -= fx; m.vy -= fy;
        }
      }
    });
    edges.forEach(function (e) {
      var ddx = e.t.x - e.s.x, ddy = e.t.y - e.s.y;
      var d = Math.sqrt(ddx * ddx + ddy * ddy) || 0.01;
      var want = 34 + e.s.r + e.t.r;
      var k = alpha * 0.06 * Math.min(3, e.w) * (d - want) / d;
      e.s.vx += ddx * k; e.s.vy += ddy * k; e.t.vx -= ddx * k; e.t.vy -= ddy * k;
    });
    // community gravity keeps clusters coherent; weak global centering.
    var cent = {};
    nodes.forEach(function (n) {
      var c = cent[n.comm] = cent[n.comm] || { x: 0, y: 0, k: 0 };
      c.x += n.x; c.y += n.y; c.k++;
    });
    nodes.forEach(function (n) {
      var c = cent[n.comm];
      n.vx += (c.x / c.k - n.x) * alpha * 0.012 - n.x * alpha * 0.0022;
      n.vy += (c.y / c.k - n.y) * alpha * 0.012 - n.y * alpha * 0.0022;
      n.vx *= 0.82; n.vy *= 0.82;
      // Clamp per-tick movement: spring force grows with distance, and
      // unclamped that oscillates the whole graph into a line.
      var sp = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
      var maxs = 2 + 12 * alpha;
      if (sp > maxs) { n.vx *= maxs / sp; n.vy *= maxs / sp; }
      n.x += n.vx; n.y += n.vy;
    });
  }

  // ── view / interaction state ──
  var view = { x: 0, y: 0, k: 1 };
  var hover = null, selected = null;
  var hiddenComms = {};
  var query = '';

  function fit() {
    var w = cv.clientWidth, h = cv.clientHeight;
    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    nodes.forEach(function (n) {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    });
    var k = Math.min(2, 0.9 * Math.min(w / (maxX - minX + 80), h / (maxY - minY + 80)));
    view.k = k > 0 && isFinite(k) ? k : 1;
    view.x = w / 2 - ((minX + maxX) / 2) * view.k;
    view.y = h / 2 - ((minY + maxY) / 2) * view.k;
  }

  function visible(n) {
    if (hiddenComms[n.comm]) return false;
    return true;
  }
  function dimmed(n) {
    if (query && n.file.toLowerCase().indexOf(query) === -1) return true;
    if (selected !== null && n.i !== selected && neigh[selected].indexOf(n.i) === -1) return true;
    return false;
  }

  function draw() {
    var w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== w * devicePixelRatio) { cv.width = w * devicePixelRatio; cv.height = h * devicePixelRatio; }
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.translate(view.x, view.y);
    ctx.scale(view.k, view.k);

    ctx.lineWidth = 0.6 / view.k;
    edges.forEach(function (e) {
      if (!visible(e.s) || !visible(e.t)) return;
      var dim = dimmed(e.s) || dimmed(e.t);
      ctx.strokeStyle = dim ? 'rgba(120,128,160,0.05)' : 'rgba(150,160,200,' + Math.min(0.34, 0.1 + e.w * 0.05) + ')';
      ctx.beginPath(); ctx.moveTo(e.s.x, e.s.y); ctx.lineTo(e.t.x, e.t.y); ctx.stroke();
    });
    nodes.forEach(function (n) {
      if (!visible(n)) return;
      var dim = dimmed(n);
      ctx.globalAlpha = dim ? 0.16 : 1;
      ctx.fillStyle = colorOf(n.comm);
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 7); ctx.fill();
      if (n.i === selected || n === hover) {
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.4 / view.k; ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });
    if (DATA.showLabels) {
      ctx.font = (11 / view.k) + 'px system-ui, sans-serif';
      nodes.forEach(function (n) {
        if (!visible(n) || dimmed(n)) return;
        var txt = n.file.length > 42 ? n.file.slice(0, 40) + '…' : n.file;
        ctx.fillStyle = n.deg > 2 ? '#e8eaf2' : 'rgba(207,211,224,0.8)';
        ctx.fillText(txt, n.x + n.r + 4 / view.k, n.y + 3.5 / view.k);
      });
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ── boot: settle the layout, then paint ──
  var ticks = Math.max(140, Math.min(320, 26000 / Math.max(1, nodes.length)));
  for (var t = 0; t < ticks; t++) tick(1 - t / ticks);
  fit();
  draw();

  // ── hud / legend ──
  document.querySelector('#hud h1').textContent = DATA.projectName;
  document.querySelector('#hud .sub').textContent =
    nodes.length + ' files · ' + edges.length + ' links · ' + commIds.length + ' communities';
  var legend = document.getElementById('legend');
  commIds.forEach(function (c) {
    var row = document.createElement('div');
    row.className = 'row';
    var lab = (comms[c][0] && comms[c][0].label) || ('community ' + c);
    row.innerHTML = '<span class="dot" style="background:' + colorOf(c) + '"></span>' +
      '<span></span><span class="n">' + comms[c].length + '</span>';
    row.children[1].textContent = lab;
    row.addEventListener('click', function () {
      hiddenComms[c] = !hiddenComms[c];
      row.classList.toggle('off', !!hiddenComms[c]);
      draw();
    });
    legend.appendChild(row);
  });

  // ── pointer interaction ──
  function toWorld(px, py) { return { x: (px - view.x) / view.k, y: (py - view.y) / view.k }; }
  function pick(px, py) {
    var p = toWorld(px, py);
    var best = null, bestD = 1e9;
    nodes.forEach(function (n) {
      if (!visible(n)) return;
      var dx = n.x - p.x, dy = n.y - p.y, d = dx * dx + dy * dy;
      var rr = (n.r + 4 / view.k); rr *= rr;
      if (d < rr && d < bestD) { best = n; bestD = d; }
    });
    return best;
  }

  var drag = null, moved = false;
  cv.addEventListener('mousedown', function (e) {
    drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    moved = false;
    cv.classList.add('dragging');
  });
  window.addEventListener('mousemove', function (e) {
    if (drag) {
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3) moved = true;
      view.x = drag.vx + (e.clientX - drag.x);
      view.y = drag.vy + (e.clientY - drag.y);
      draw();
      return;
    }
    var n = pick(e.clientX, e.clientY);
    if (n !== hover) { hover = n; draw(); }
    if (n) {
      tip.style.display = 'block';
      tip.style.left = Math.min(innerWidth - 400, e.clientX + 14) + 'px';
      tip.style.top = (e.clientY + 14) + 'px';
      tip.querySelector('.f').textContent = n.file;
      tip.querySelector('.m').textContent =
        '[' + n.label + '] · ' + n.syms + ' symbols · ' + n.deg + ' links' +
        (BRIDGE ? ' · click to open' : '');
    } else {
      tip.style.display = 'none';
    }
  });
  window.addEventListener('mouseup', function (e) {
    cv.classList.remove('dragging');
    if (drag && !moved) {
      var n = pick(e.clientX, e.clientY);
      if (n && vscode) vscode.postMessage({ type: 'open', file: n.file });
      selected = n ? n.i : null;
      draw();
    }
    drag = null;
  });
  cv.addEventListener('wheel', function (e) {
    e.preventDefault();
    var k = Math.max(0.15, Math.min(8, view.k * (e.deltaY < 0 ? 1.12 : 0.89)));
    var p = toWorld(e.clientX, e.clientY);
    view.x = e.clientX - p.x * k;
    view.y = e.clientY - p.y * k;
    view.k = k;
    draw();
  }, { passive: false });
  document.getElementById('search').addEventListener('input', function (e) {
    query = e.target.value.trim().toLowerCase();
    draw();
  });
  window.addEventListener('resize', draw);
})();
</script>
</body></html>`
}
