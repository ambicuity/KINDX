type CounterKey = string;
type HistogramKey = string;

const counters = new Map<CounterKey, number>();
const histograms = new Map<HistogramKey, {
  buckets: number[];
  counts: number[];
  sum: number;
  count: number;
}>();

function makeLabels(labels?: Record<string, string | number | boolean>): string {
  if (!labels) return "";
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  const rendered = entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `{${rendered.join(",")}}`;
}

function key(name: string, labels?: Record<string, string | number | boolean>): string {
  return `${name}${makeLabels(labels)}`;
}

export function incCounter(name: string, value = 1, labels?: Record<string, string | number | boolean>): void {
  const k = key(name, labels);
  counters.set(k, (counters.get(k) || 0) + value);
}

export function observeHistogram(
  name: string,
  value: number,
  buckets: number[],
  labels?: Record<string, string | number | boolean>
): void {
  const k = key(name, labels);
  const sorted = [...buckets].sort((a, b) => a - b);
  let h = histograms.get(k);
  if (!h) {
    h = {
      buckets: sorted,
      counts: sorted.map(() => 0),
      sum: 0,
      count: 0,
    };
    histograms.set(k, h);
  }
  h.sum += value;
  h.count += 1;
  for (let i = 0; i < h.buckets.length; i++) {
    const b = h.buckets[i];
    if (b !== undefined && value <= b) h.counts[i] = (h.counts[i] || 0) + 1;
  }
}

export function renderPrometheusMetrics(extraGauges?: Array<{ name: string; value: number; labels?: Record<string, string | number | boolean> }>): string {
  const lines: string[] = [];
  const counterKeys = [...counters.keys()].sort();
  for (const k of counterKeys) {
    lines.push(`${k} ${counters.get(k) || 0}`);
  }

  const histKeys = [...histograms.keys()].sort();
  for (const k of histKeys) {
    const h = histograms.get(k);
    if (!h) continue;
    const base = k;
    const hasLabels = base.includes("{");
    const suffix = hasLabels ? base.slice(base.indexOf("{")) : "";
    const metric = hasLabels ? base.slice(0, base.indexOf("{")) : base;
    for (let i = 0; i < h.buckets.length; i++) {
      const b = h.buckets[i];
      const cumulative = h.counts[i] || 0;
      if (b === undefined) continue;
      const bucketLabels = suffix
        ? `${suffix.slice(0, -1)},le="${b}"}`
        : `{le="${b}"}`;
      lines.push(`${metric}_bucket${bucketLabels} ${cumulative}`);
    }
    const infLabels = suffix
      ? `${suffix.slice(0, -1)},le="+Inf"}`
      : `{le="+Inf"}`;
    lines.push(`${metric}_bucket${infLabels} ${h.count}`);
    lines.push(`${metric}_sum${suffix} ${h.sum}`);
    lines.push(`${metric}_count${suffix} ${h.count}`);
  }

  if (extraGauges) {
    for (const g of extraGauges) {
      lines.push(`${key(g.name, g.labels)} ${g.value}`);
    }
  }
  return lines.join("\n") + "\n";
}
