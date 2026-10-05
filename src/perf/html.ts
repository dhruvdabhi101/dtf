import type { PerfData, PerfSummary } from './report.ts';

/**
 * A self-contained HTML page for one perf recording: CPU, memory, I/O and
 * network over time, with phases shaded and chaos faults marked, plus the
 * summary tables. No scripts or external assets, so it opens from a CI
 * artifact as-is.
 */

const COLORS = ['#2f6fdb', '#d9480f', '#2b8a3e', '#9c36b5', '#e67700', '#0b7285', '#c2255c'];
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

type Line = { name: string; pts: [number, number][] };

function chart(title: string, unit: string, lines: Line[], data: PerfData): string {
  const W = 960, H = 220, L = 56, R = 12, T = 12, B = 26;
  const t0 = data.startedAt, t1 = Math.max(data.endedAt, t0 + 1);
  const all = lines.flatMap((l) => l.pts.map((p) => p[1]));
  const ymax = niceMax(Math.max(1e-9, ...all));
  const x = (t: number) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const y = (v: number) => T + (1 - v / ymax) * (H - T - B);

  const bands = data.phases.map((p, i) =>
    `<rect x="${x(p.start).toFixed(1)}" y="${T}" width="${Math.max(1, x(p.end) - x(p.start)).toFixed(1)}" height="${H - T - B}" class="band b${i % 2}"/>` +
    `<text x="${(x(p.start) + 4).toFixed(1)}" y="${T + 12}" class="bandlabel">${esc(p.name)}</text>`).join('');
  const faults = pairFaults(data);
  const faultMarks = faults.map((f) =>
    `<rect x="${x(f.start).toFixed(1)}" y="${H - B - 6}" width="${Math.max(2, x(f.end) - x(f.start)).toFixed(1)}" height="6" class="fault"><title>${esc(f.label)}</title></rect>`).join('');
  const marks = data.events.filter((e) => e.kind === 'mark').map((e) =>
    `<line x1="${x(e.at).toFixed(1)}" x2="${x(e.at).toFixed(1)}" y1="${T}" y2="${H - B}" class="mark"><title>${esc(e.label)}</title></line>`).join('');

  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = ymax * f;
    return `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid"/><text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" class="axis" text-anchor="end">${fmtNum(v)}</text>`;
  }).join('');
  const secs = (t1 - t0) / 1000;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) =>
    `<text x="${(L + f * (W - L - R)).toFixed(1)}" y="${H - 8}" class="axis" text-anchor="middle">${fmtDur(secs * f)}</text>`).join('');

  const paths = lines.map((l, i) => {
    if (!l.pts.length) return '';
    const d = l.pts.map((p, j) => `${j ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
    return `<path d="${d}" fill="none" stroke="${COLORS[i % COLORS.length]}" stroke-width="1.6"/>`;
  }).join('');
  const legend = lines.map((l, i) => `<span class="key"><i style="background:${COLORS[i % COLORS.length]}"></i>${esc(l.name)}</span>`).join('');

  return `<section><h2>${esc(title)} <small>${esc(unit)}</small></h2><div class="legend">${legend}</div>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${bands}${grid}${ticks}${marks}${paths}${faultMarks}</svg></section>`;
}

function pairFaults(data: PerfData): { label: string; start: number; end: number }[] {
  const open = new Map<string, number>();
  const out: { label: string; start: number; end: number }[] = [];
  for (const e of data.events) {
    if (e.kind === 'fault-start') open.set(e.label, e.at);
    if (e.kind === 'fault-end') {
      const s = open.get(e.label);
      if (s !== undefined) { out.push({ label: e.label, start: s, end: e.at }); open.delete(e.label); }
    }
  }
  for (const [label, start] of open) out.push({ label, start, end: data.endedAt });
  return out;
}

function niceMax(v: number): number {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
const fmtNum = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
const fmtDur = (s: number) => (s >= 120 ? `${(s / 60).toFixed(1)}m` : `${s.toFixed(0)}s`);
const n1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '-');

function tables(s: PerfSummary): string {
  const rows = Object.entries(s.targets).flatMap(([label, phases]) => Object.entries(phases).map(([phase, p]) => {
    const net = p.net ?? s.proxy?.[phase];
    return `<tr><td>${esc(label)}</td><td>${esc(phase)}</td><td>${n1(p.cpu.mean)}</td><td>${n1(p.cpu.p95)}</td><td>${n1(p.cpu.max)}</td><td>${n1(p.memMB.max)}</td><td>${n1(p.memMB.growth)}</td><td>${n1(p.memMB.slopePerHour)}</td><td>${n1(p.handles.growth)}</td><td>${n1(p.ioWriteMBps.mean)}</td><td>${net ? n1(net.bytesPerMin / 1024) : '-'}</td><td>${p.procsMax}</td></tr>`;
  })).join('');
  const hosts = s.proxyHosts ? Object.entries(s.proxyHosts).sort((a, b) => (b[1].bytesDown + b[1].bytesUp) - (a[1].bytesDown + a[1].bytesUp)).slice(0, 40)
    .map(([h, v]) => `<tr><td>${esc(h)}</td><td>${v.connections}</td><td>${n1(v.bytesUp / 1024)}</td><td>${n1(v.bytesDown / 1024)}</td><td>${v.errors}</td></tr>`).join('') : '';
  return `<section><h2>Summary <small>CPU is % of one core; ${s.cores} cores</small></h2><table>
<tr><th>target</th><th>phase</th><th>cpu mean</th><th>cpu p95</th><th>cpu max</th><th>mem max MB</th><th>mem Δ MB</th><th>mem MB/h</th><th>handles Δ</th><th>disk write MB/s</th><th>net KB/min</th><th>procs</th></tr>${rows}</table></section>` +
    (hosts ? `<section><h2>Traffic through the dtf proxy <small>by host</small></h2><table><tr><th>host</th><th>connections</th><th>sent KB</th><th>received KB</th><th>errors</th></tr>${hosts}</table></section>` : '');
}

export function renderHtml(data: PerfData, summary: PerfSummary): string {
  const series = (f: (p: PerfData['series'][string][number]) => number | undefined) =>
    data.targets.map((label) => ({ name: label, pts: (data.series[label] ?? []).flatMap((p) => { const v = f(p); return v === undefined ? [] : [[p.t, v] as [number, number]]; }) }));
  const perSec = (bytes: number | undefined, dt: number) => (bytes === undefined ? undefined : bytes / Math.max(dt, 1) * 1000);

  const charts = [
    chart('CPU', '% of one core', series((p) => p.cpu), data),
    chart('Memory', 'private MB', series((p) => p.memMB), data),
    chart('Disk writes', 'MB/s', series((p) => p.ioWriteBytes / 1048576 / Math.max(p.dtMs, 1) * 1000), data),
    chart('Handles', 'count', series((p) => p.handles), data),
    chart('System CPU', '% of machine', [{ name: 'system', pts: data.system.map((p) => [p.t, p.cpu]) }], data),
    chart('System memory', 'used MB', [{ name: 'system', pts: data.system.map((p) => [p.t, p.memUsedMB]) }], data),
  ];
  if (data.targets.some((l) => data.series[l]?.some((p) => p.netRxBytes !== undefined))) {
    charts.push(chart('Network (per process)', 'KB/s', series((p) => { const v = perSec((p.netRxBytes ?? 0) + (p.netTxBytes ?? 0), p.dtMs); return v === undefined ? undefined : v / 1024; }), data));
  }
  if (data.proxy) {
    charts.push(chart('App traffic via dtf proxy', 'KB/s', [
      { name: 'received', pts: data.proxy.map((p) => [p.t, p.downBytes / Math.max(p.dtMs, 1) * 1000 / 1024]) },
      { name: 'sent', pts: data.proxy.map((p) => [p.t, p.upBytes / Math.max(p.dtMs, 1) * 1000 / 1024]) },
    ], data));
  }
  if (data.system.some((p) => p.netRxBytes !== undefined)) {
    charts.push(chart('Machine network (all adapters)', 'KB/s', [
      { name: 'received', pts: data.system.map((p) => [p.t, (p.netRxBytes ?? 0) / Math.max(p.dtMs, 1) * 1000 / 1024]) },
      { name: 'sent', pts: data.system.map((p) => [p.t, (p.netTxBytes ?? 0) / Math.max(p.dtMs, 1) * 1000 / 1024]) },
    ], data));
  }

  const faults = pairFaults(data);
  const events = faults.length
    ? `<section><h2>Faults</h2><ul>${faults.map((f) => `<li>${esc(f.label)}: ${fmtDur((f.start - data.startedAt) / 1000)} → ${fmtDur((f.end - data.startedAt) / 1000)}</li>`).join('')}</ul></section>`
    : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(data.name)} perf</title><style>
:root{--bg:#fff;--fg:#1d2126;--muted:#6b7280;--grid:#e5e7eb;--band0:rgba(47,111,219,.06);--band1:rgba(47,111,219,.12);--fault:#e03131}
@media (prefers-color-scheme: dark){:root{--bg:#15171a;--fg:#e6e8eb;--muted:#9aa1ab;--grid:#2c3036;--band0:rgba(120,160,255,.07);--band1:rgba(120,160,255,.14)}}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:0;padding:20px 16px;max-width:1000px;margin-inline:auto}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 6px}small{color:var(--muted);font-weight:400}
svg{width:100%;height:auto;display:block}.grid{stroke:var(--grid)}.axis{fill:var(--muted);font-size:11px}
.band.b0{fill:var(--band0)}.band.b1{fill:var(--band1)}.bandlabel{fill:var(--muted);font-size:11px}.fault{fill:var(--fault)}.mark{stroke:var(--muted);stroke-dasharray:3 3}
.legend{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted);font-size:12px}.key i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
table{border-collapse:collapse;width:100%;font-size:12.5px;display:block;overflow-x:auto}td,th{border-bottom:1px solid var(--grid);padding:4px 8px;text-align:right;white-space:nowrap}td:first-child,td:nth-child(2),th:first-child,th:nth-child(2){text-align:left}
</style></head><body>
<h1>${esc(data.name)}</h1><div><small>${new Date(data.startedAt).toISOString()} · ${fmtDur((data.endedAt - data.startedAt) / 1000)} · every ${data.intervalMs} ms · ${esc(data.platform)} · warm-up ${fmtDur(data.warmupMs / 1000)} excluded from "all"</small></div>
${tables(summary)}${events}${charts.join('\n')}
</body></html>`;
}
