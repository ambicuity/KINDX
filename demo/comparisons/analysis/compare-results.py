#!/usr/bin/env python3
"""
Compare results across all competitor test runs.
Reads JSON result files from the results/ directory and generates comparison tables.

Usage:
    python3 compare-results.py [results_dir]
"""

import json
import os
import sys
from pathlib import Path

RESULTS_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "results"


def load_results():
    """Load all result JSON files from the results directory."""
    results = {}
    if not RESULTS_DIR.exists():
        print(f"Results directory not found: {RESULTS_DIR}")
        return results

    for f in sorted(RESULTS_DIR.glob("*.json")):
        try:
            with open(f) as fh:
                data = json.load(fh)
                tool = data.get("tool", f.stem)
                results[tool] = data
        except (json.JSONDecodeError, KeyError) as e:
            print(f"WARNING: Failed to load {f}: {e}")
    return results


def best_mode(tool_data):
    """Find the best performing mode for a tool."""
    agg = tool_data.get("aggregate", {})
    best = None
    best_mrr = -1
    for mode in ["hybrid", "vector", "bm25"]:
        if mode in agg and agg[mode].get("mrr", 0) > best_mrr:
            best_mrr = agg[mode]["mrr"]
            best = mode
    return best or "vector"


def print_retrieval_comparison(results):
    """Print retrieval quality comparison table."""
    print("\n## Retrieval Quality Comparison\n")
    print("| Tool | Best Mode | Hit@1 | Hit@3 | MRR | Median Latency |")
    print("|------|-----------|-------|-------|-----|----------------|")

    rows = []
    for tool, data in results.items():
        mode = best_mode(data)
        agg = data.get("aggregate", {}).get(mode, {})
        rows.append((
            tool,
            mode,
            agg.get("hit_at_1", 0),
            agg.get("hit_at_3", 0),
            agg.get("mrr", 0),
            agg.get("median_latency_ms", 0),
        ))

    # Sort by MRR descending
    rows.sort(key=lambda r: r[4], reverse=True)
    for tool, mode, h1, h3, mrr, lat in rows:
        lat_str = f"{lat}ms" if lat > 0 else "N/A"
        print(f"| {tool} | {mode} | {h1} | {h3} | {mrr} | {lat_str} |")


def print_capability_comparison(results):
    """Print capability matrix."""
    caps = [
        "bm25", "vector", "hybrid", "reranking", "mcp_server",
        "cli_query", "json_output", "csv_output", "xml_output",
        "agent_invocable", "air_gapped", "local_gguf",
    ]

    tools = sorted(results.keys())
    print("\n## Capability Matrix\n")

    header = "| Capability | " + " | ".join(tools) + " |"
    sep = "|------------|" + "|".join(["---" for _ in tools]) + "|"
    print(header)
    print(sep)

    for cap in caps:
        row = f"| {cap} |"
        for tool in tools:
            val = results[tool].get("capabilities", {}).get(cap, False)
            icon = "Y" if val else "-"
            row += f" {icon} |"
        print(row)


def print_setup_comparison(results):
    """Print setup friction comparison."""
    print("\n## Setup Friction Comparison\n")
    print("| Tool | Steps | Install Time | Index Time | Models (MB) | Commands |")
    print("|------|-------|-------------|------------|-------------|----------|")

    rows = []
    for tool, data in results.items():
        setup = data.get("setup", {})
        rows.append((
            tool,
            setup.get("total_setup_steps", 0),
            setup.get("install_time_seconds", 0),
            setup.get("index_time_seconds", 0),
            setup.get("models_downloaded_mb", 0),
            len(setup.get("install_commands", [])),
        ))

    rows.sort(key=lambda r: r[1])
    for tool, steps, install, index, models, cmds in rows:
        print(f"| {tool} | {steps} | {install}s | {index}s | {models} | {cmds} |")


def print_per_query_breakdown(results):
    """Print per-query hit rates across tools."""
    # Find tool with most detailed results
    all_queries = set()
    for data in results.values():
        for r in data.get("results", []):
            all_queries.add(r["query_id"])

    if not all_queries:
        return

    print("\n## Per-Query Breakdown (Hit@1, best mode)\n")
    tools = sorted(results.keys())
    header = "| Query | " + " | ".join(tools) + " |"
    sep = "|-------|" + "|".join(["---" for _ in tools]) + "|"
    print(header)
    print(sep)

    for qid in sorted(all_queries):
        row = f"| Q{qid} |"
        for tool in tools:
            data = results[tool]
            mode = best_mode(data)
            hit = False
            for r in data.get("results", []):
                if r["query_id"] == qid and r["mode"] == mode:
                    hit = r.get("hit_at_1", False)
                    break
            icon = "Y" if hit else "-"
            row += f" {icon} |"
        print(row)


def main():
    results = load_results()

    if not results:
        print("No results found. Run tests first with run-all.sh")
        sys.exit(0)

    print(f"# Comparison Results — {len(results)} tools\n")
    print(f"Results loaded: {', '.join(sorted(results.keys()))}")

    print_retrieval_comparison(results)
    print_capability_comparison(results)
    print_setup_comparison(results)
    print_per_query_breakdown(results)

    # Write to file
    output_path = RESULTS_DIR / "comparison.md"
    # Re-run with output redirected
    print(f"\n---\nFull comparison written to stdout. Pipe to file with:")
    print(f"  python3 {__file__} > {output_path}")


if __name__ == "__main__":
    main()
