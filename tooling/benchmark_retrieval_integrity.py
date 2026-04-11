#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer


@dataclass(frozen=True)
class EvalCase:
    query: str
    expected_doc: str
    bucket: str


def read_cases(path: Path) -> list[EvalCase]:
    raw = json.loads(path.read_text())
    out: list[EvalCase] = []
    for item in raw:
        out.append(EvalCase(
            query=str(item["query"]),
            expected_doc=str(item["expected_doc"]),
            bucket=str(item.get("bucket", "general")),
        ))
    return out


def load_corpus(corpus_dir: Path) -> tuple[list[str], list[str]]:
    files: list[str] = []
    texts: list[str] = []
    for path in sorted(corpus_dir.rglob("*.md")):
        files.append(path.name)
        texts.append(path.read_text(encoding="utf-8", errors="ignore"))
    if not files:
        raise SystemExit(f"No markdown files found under {corpus_dir}")
    return files, texts


def run_kindx(query: str, top_k: int, collection: str | None) -> list[str]:
    cmd = ["kindx", "query", query, "--json", "-n", str(top_k)]
    if collection:
        cmd.extend(["-c", collection])
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip())
    parsed = json.loads(proc.stdout)
    return [Path(item["file"].replace("kindx://", "")).name for item in parsed]


def run_float_baseline(query: str, top_k: int, files: list[str], tfidf: TfidfVectorizer, matrix: np.ndarray) -> list[str]:
    qv = tfidf.transform([query]).toarray()[0].astype(np.float32)
    denom = np.linalg.norm(qv) + 1e-8
    sims = []
    for idx in range(matrix.shape[0]):
        dv = matrix[idx]
        sim = float(np.dot(qv, dv) / (denom * (np.linalg.norm(dv) + 1e-8)))
        sims.append((sim, files[idx]))
    sims.sort(reverse=True)
    return [name for _, name in sims[:top_k]]


def mrr_rank(results: list[str], expected: str) -> float:
    for idx, item in enumerate(results, start=1):
        if expected.lower() in item.lower():
            return 1.0 / idx
    return 0.0


def hit_at_k(results: list[str], expected: str, k: int) -> float:
    return 1.0 if any(expected.lower() in item.lower() for item in results[:k]) else 0.0


def summarize(rows: list[dict[str, Any]], label: str, top_k: int) -> dict[str, Any]:
    overall_hit = sum(r[f"hit@{top_k}"] for r in rows) / max(len(rows), 1)
    overall_mrr = sum(r["mrr"] for r in rows) / max(len(rows), 1)
    by_bucket: dict[str, dict[str, float]] = {}
    buckets = sorted({r["bucket"] for r in rows})
    for bucket in buckets:
        bucket_rows = [r for r in rows if r["bucket"] == bucket]
        by_bucket[bucket] = {
            f"hit@{top_k}": sum(r[f"hit@{top_k}"] for r in bucket_rows) / len(bucket_rows),
            "mrr": sum(r["mrr"] for r in bucket_rows) / len(bucket_rows),
        }
    return {
        "label": label,
        f"hit@{top_k}": round(overall_hit, 4),
        "mrr": round(overall_mrr, 4),
        "by_bucket": {k: {kk: round(vv, 4) for kk, vv in v.items()} for k, v in by_bucket.items()},
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="KINDX retrieval integrity benchmark (sqlite-vec path vs float32 baseline approximation)")
    ap.add_argument("--cases", required=True, help="Path to JSON query cases")
    ap.add_argument("--corpus", required=True, help="Directory with markdown corpus")
    ap.add_argument("--collection", default=None, help="Optional KINDX collection name for query runs")
    ap.add_argument("--top-k", type=int, default=10)
    ap.add_argument("--fail-relative-drop", type=float, default=0.10, help="Fail threshold for relative hit@k drop in typo/CJK buckets")
    args = ap.parse_args()

    cases = read_cases(Path(args.cases))
    files, texts = load_corpus(Path(args.corpus))

    tfidf = TfidfVectorizer(stop_words="english")
    matrix = tfidf.fit_transform(texts).toarray().astype(np.float32)

    kindx_rows: list[dict[str, Any]] = []
    baseline_rows: list[dict[str, Any]] = []

    for case in cases:
      kindx_results = run_kindx(case.query, args.top_k, args.collection)
      base_results = run_float_baseline(case.query, args.top_k, files, tfidf, matrix)
      kindx_rows.append({
          "query": case.query,
          "bucket": case.bucket,
          f"hit@{args.top_k}": hit_at_k(kindx_results, case.expected_doc, args.top_k),
          "mrr": mrr_rank(kindx_results, case.expected_doc),
      })
      baseline_rows.append({
          "query": case.query,
          "bucket": case.bucket,
          f"hit@{args.top_k}": hit_at_k(base_results, case.expected_doc, args.top_k),
          "mrr": mrr_rank(base_results, case.expected_doc),
      })

    kindx_summary = summarize(kindx_rows, "kindx", args.top_k)
    baseline_summary = summarize(baseline_rows, "float32_baseline_approx", args.top_k)

    def rel_drop(bucket: str) -> float:
        k = f"hit@{args.top_k}"
        base = baseline_summary["by_bucket"].get(bucket, {}).get(k, 0.0)
        got = kindx_summary["by_bucket"].get(bucket, {}).get(k, 0.0)
        if base <= 0:
            return 0.0
        return max(0.0, (base - got) / base)

    typo_drop = rel_drop("typo")
    cjk_drop = rel_drop("cjk")
    status = "pass"
    failures: list[str] = []
    if typo_drop > args.fail_relative_drop:
        status = "fail"
        failures.append(f"typo relative drop {typo_drop:.3f} > {args.fail_relative_drop:.3f}")
    if cjk_drop > args.fail_relative_drop:
        status = "fail"
        failures.append(f"cjk relative drop {cjk_drop:.3f} > {args.fail_relative_drop:.3f}")

    report = {
        "status": status,
        "threshold_relative_drop": args.fail_relative_drop,
        "top_k": args.top_k,
        "kindx": kindx_summary,
        "baseline": baseline_summary,
        "relative_drop": {
            "typo": round(typo_drop, 4),
            "cjk": round(cjk_drop, 4),
        },
        "failures": failures,
    }

    print(json.dumps(report, indent=2))
    if status != "pass":
        raise SystemExit(2)


if __name__ == "__main__":
    main()
