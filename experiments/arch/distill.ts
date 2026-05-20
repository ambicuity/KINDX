import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isConfidenceAllowed } from "./config.js";
import type {
  DistilledArchArtifact,
  ArchConfidence,
  ArchGraphJson,
  ArchHint,
} from "./contracts.js";

type DistillInput = {
  sourceRoot: string;
  graphJsonPath: string;
  reportPath?: string;
  reportText?: string | null;
  graph: ArchGraphJson;
  outputDir: string;
  minConfidence: "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
};

function confidence(value: string | undefined): ArchConfidence | undefined {
  if (!value) return undefined;
  const v = value.toUpperCase();
  if (v === "EXTRACTED" || v === "INFERRED" || v === "AMBIGUOUS") return v;
  return undefined;
}

export function distillArchArtifacts(input: DistillInput): DistilledArchArtifact {
  const out = resolve(input.outputDir);
  mkdirSync(out, { recursive: true });
  const docsDir = resolve(out, "docs");
  mkdirSync(docsDir, { recursive: true });

  const confidenceBreakdown = {
    EXTRACTED: 0,
    INFERRED: 0,
    AMBIGUOUS: 0,
  };
  for (const link of input.graph.links) {
    const c = confidence(link.confidence);
    if (c) confidenceBreakdown[c] += 1;
  }

  const communities = new Map<number, { labels: string[]; sourceFiles: Set<string> }>();
  for (const node of input.graph.nodes) {
    const cid = typeof node.community === "number" ? node.community : null;
    if (cid === null) continue;
    if (!communities.has(cid)) {
      communities.set(cid, { labels: [], sourceFiles: new Set<string>() });
    }
    const entry = communities.get(cid)!;
    if (node.label) entry.labels.push(node.label);
    if (node.source_file) entry.sourceFiles.add(node.source_file);
  }

  const validNodes = input.graph.nodes.filter((n) => n.id);
  const validLinks = input.graph.links.filter((l) => l.source && l.target);

  const degree = new Map<string, number>();
  for (const link of validLinks) {
    degree.set(link.source, (degree.get(link.source) ?? 0) + 1);
    degree.set(link.target, (degree.get(link.target) ?? 0) + 1);
  }

  const nodeById = new Map(validNodes.map((n) => [n.id, n] as const));

  const godNodes = Array.from(degree.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([id, edges]) => {
      const node = nodeById.get(id);
      return {
        id,
        label: node?.label || id,
        edges,
        sourceFile: node?.source_file || "",
      };
    });

  const surprising = input.graph.links
    .filter((link) => isConfidenceAllowed(link.confidence, input.minConfidence))
    .filter((link) => {
      const relation = (link.relation || "").toLowerCase();
      return relation !== "contains" && relation !== "imports" && relation !== "imports_from";
    })
    .slice(0, 40)
    .map((link) => {
      const src = nodeById.get(link.source);
      const tgt = nodeById.get(link.target);
      return {
        source: src?.label || link.source,
        target: tgt?.label || link.target,
        relation: link.relation || "related_to",
        confidence: confidence(link.confidence),
        sourceFiles: [src?.source_file, tgt?.source_file].filter((v): v is string => !!v),
      };
    });

  const overviewLines = [
    `# Arch Distilled Overview`,
    "",
    `Source root: ${input.sourceRoot}`,
    `Graph JSON: ${input.graphJsonPath}`,
    `Nodes: ${input.graph.nodes.length}`,
    `Edges: ${input.graph.links.length}`,
    `Communities: ${communities.size}`,
    `Confidence: EXTRACTED=${confidenceBreakdown.EXTRACTED}, INFERRED=${confidenceBreakdown.INFERRED}, AMBIGUOUS=${confidenceBreakdown.AMBIGUOUS}`,
    "",
    `## Top Nodes`,
    ...godNodes.map((n, i) => `${i + 1}. ${n.label} (${n.edges} edges) ${n.sourceFile ? `[${n.sourceFile}]` : ""}`),
  ];

  writeFileSync(resolve(docsDir, "overview.md"), overviewLines.join("\n"), "utf-8");

  const communityLines = ["# Arch Communities", ""];
  for (const [cid, info] of Array.from(communities.entries()).sort((a, b) => b[1].labels.length - a[1].labels.length)) {
    const sample = info.labels.slice(0, 8).join(", ");
    communityLines.push(`## Community ${cid}`);
    communityLines.push(`Members: ${info.labels.length}`);
    communityLines.push(`Sources: ${Array.from(info.sourceFiles).slice(0, 8).join(", ")}`);
    if (sample) communityLines.push(`Sample nodes: ${sample}`);
    communityLines.push("");
  }
  writeFileSync(resolve(docsDir, "communities.md"), communityLines.join("\n"), "utf-8");

  const surprisingLines = ["# Arch Surprising Connections", ""];
  for (const edge of surprising) {
    surprisingLines.push(`- ${edge.source} --${edge.relation}--> ${edge.target}${edge.confidence ? ` [${edge.confidence}]` : ""}`);
  }
  writeFileSync(resolve(docsDir, "surprising_edges.md"), surprisingLines.join("\n"), "utf-8");

  if (input.reportText) {
    writeFileSync(resolve(docsDir, "graph_report.md"), input.reportText, "utf-8");
  }

  const hints: ArchHint[] = [];

  hints.push({
    id: "report",
    kind: "report",
    title: "Arch report summary",
    body: (input.reportText || overviewLines.join("\n")).slice(0, 3000),
    scoreSignals: ["architecture", "community", "dependency", "call graph"],
    sourceFiles: [],
  });

  for (const [cid, info] of communities.entries()) {
    hints.push({
      id: `community_${cid}`,
      kind: "community",
      title: `Community ${cid}`,
      body: `Community ${cid} includes ${info.labels.length} nodes. Sample: ${info.labels.slice(0, 8).join(", ")}.`,
      scoreSignals: ["community", "module", "architecture", "boundary"],
      sourceFiles: Array.from(info.sourceFiles),
    });
  }

  for (const n of godNodes.slice(0, 8)) {
    hints.push({
      id: `god_${n.id}`,
      kind: "god_node",
      title: n.label,
      body: `${n.label} is a high-centrality node with ${n.edges} edges.${n.sourceFile ? ` Source: ${n.sourceFile}.` : ""}`,
      scoreSignals: ["core abstraction", "dependency", "hotspot", n.label.toLowerCase()],
      sourceFiles: n.sourceFile ? [n.sourceFile] : [],
    });
  }

  for (const edge of surprising.slice(0, 12)) {
    hints.push({
      id: `edge_${edge.source}_${edge.target}`.replace(/[^a-zA-Z0-9_]/g, "_"),
      kind: "surprising_edge",
      title: `${edge.source} -> ${edge.target}`,
      body: `${edge.source} has relation '${edge.relation}' with ${edge.target}.`,
      scoreSignals: [edge.relation.toLowerCase(), edge.source.toLowerCase(), edge.target.toLowerCase()],
      confidence: edge.confidence,
      sourceFiles: edge.sourceFiles,
    });
  }

  const hintsPath = resolve(out, "hints.json");
  writeFileSync(hintsPath, JSON.stringify(hints, null, 2), "utf-8");

  const files = [
    resolve(docsDir, "overview.md"),
    resolve(docsDir, "communities.md"),
    resolve(docsDir, "surprising_edges.md"),
    hintsPath,
  ];
  if (input.reportText) {
    files.push(resolve(docsDir, "graph_report.md"));
  }

  const artifact: DistilledArchArtifact = {
    sourceRoot: input.sourceRoot,
    graphJsonPath: input.graphJsonPath,
    reportPath: input.reportPath,
    generatedAt: new Date().toISOString(),
    nodeCount: input.graph.nodes.length,
    edgeCount: input.graph.links.length,
    communityCount: communities.size,
    files,
    hintsPath,
    confidenceBreakdown,
  };

  writeFileSync(resolve(out, "manifest.json"), JSON.stringify(artifact, null, 2), "utf-8");
  return artifact;
}
