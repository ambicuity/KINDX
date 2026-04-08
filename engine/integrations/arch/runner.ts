import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

export type ArchBuildOptions = {
  pythonBin: string;
  archRepoPath: string;
  sourceRoot: string;
  outputDir: string;
};

export type ArchBuildResult = {
  ok: boolean;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  graphJsonPath: string;
  reportPath: string;
};

export function checkArchRepo(path: string): { ok: boolean; reason?: string } {
  const repoPath = resolve(path);
  if (!existsSync(repoPath)) {
    return { ok: false, reason: `Arch repository not found at ${repoPath}` };
  }
  const modulePath = resolve(repoPath, "arch", "__init__.py");
  if (!existsSync(modulePath)) {
    return { ok: false, reason: `Arch module not found at ${modulePath}` };
  }
  return { ok: true };
}

function buildPythonScript(): string {
  return [
    "from pathlib import Path",
    "import json",
    "import sys",
    "repo = Path(sys.argv[1]).resolve()",
    "source_root = Path(sys.argv[2]).resolve()",
    "out_dir = Path(sys.argv[3]).resolve()",
    "sys.path.insert(0, str(repo))",
    "from arch.detect import detect",
    "from arch.extract import extract, collect_files",
    "from arch.build import build_from_json",
    "from arch.cluster import cluster, score_all",
    "from arch.analyze import god_nodes, surprising_connections, suggest_questions",
    "from arch.report import generate",
    "from arch.export import to_json",
    "out_dir.mkdir(parents=True, exist_ok=True)",
    "detection = detect(source_root)",
    "code_files = [Path(p) for p in detection.get('files', {}).get('code', [])]",
    "if len(code_files) == 0:",
    "    code_files = collect_files(source_root)",
    "extraction = extract(code_files)",
    "G = build_from_json(extraction)",
    "communities = cluster(G)",
    "cohesion = score_all(G, communities)",
    "labels = {cid: f'Community {cid}' for cid in communities}",
    "gods = god_nodes(G)",
    "surprises = surprising_connections(G, communities)",
    "questions = suggest_questions(G, communities, labels)",
    "report = generate(",
    "    G,",
    "    communities,",
    "    cohesion,",
    "    labels,",
    "    gods,",
    "    surprises,",
    "    detection,",
    "    {'input': extraction.get('input_tokens', 0), 'output': extraction.get('output_tokens', 0)},",
    "    str(source_root),",
    "    suggested_questions=questions,",
    ")",
    "graph_path = out_dir / 'graph.json'",
    "report_path = out_dir / 'GRAPH_REPORT.md'",
    "to_json(G, communities, str(graph_path))",
    "report_path.write_text(report, encoding='utf-8')",
    "print(json.dumps({'graph_json': str(graph_path), 'report': str(report_path), 'nodes': G.number_of_nodes(), 'edges': G.number_of_edges(), 'communities': len(communities)}))",
  ].join("\n");
}

export async function runArchBuild(options: ArchBuildOptions): Promise<ArchBuildResult> {
  const repoPath = resolve(options.archRepoPath);
  const sourceRoot = resolve(options.sourceRoot);
  const outputDir = resolve(options.outputDir);
  const graphJsonPath = resolve(outputDir, "graph.json");
  const reportPath = resolve(outputDir, "GRAPH_REPORT.md");

  const script = buildPythonScript();
  const args = ["-c", script, repoPath, sourceRoot, outputDir];
  const command = `${options.pythonBin} -c <arch_pipeline> ${repoPath} ${sourceRoot} ${outputDir}`;

  const child = spawn(options.pythonBin, args, {
    cwd: sourceRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise<number>((resolveCode) => {
    child.on("close", (code) => resolveCode(code ?? 1));
  });

  return {
    ok: exitCode === 0,
    command,
    stdout,
    stderr,
    exitCode,
    graphJsonPath,
    reportPath,
  };
}
