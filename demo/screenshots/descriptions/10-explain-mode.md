# Screenshot 10: Explain Mode

## Description

Shows the retrieval trace produced by `--explain` on a hybrid query.

## Command

```bash
$ kindx query "distributed consensus" -c my-docs --explain -n 3
```

## Expected Terminal Output

```text
$ kindx query "distributed consensus" -c my-docs --explain -n 3
Hybrid Search: "distributed consensus" (3 results)

  #1  [0.97] kindx://my-docs/consensus-algorithms.md
      "Distributed consensus is the problem of getting multiple nodes to
       agree on a single value..."
      Retrieval: BM25=18.7 (rank 1) + Vector=0.95 (rank 1) -> RRF=0.97

  #2  [0.88] kindx://my-docs/distributed-systems.md
      "Consensus protocols are the foundation for strong consistency
       guarantees in a distributed system..."
      Retrieval: BM25=14.3 (rank 2) + Vector=0.87 (rank 3) -> RRF=0.88

  #3  [0.88] kindx://my-docs/raft-implementation.md
      "Raft decomposes consensus into leader election, log replication,
       and safety..."
      Retrieval: BM25=11.1 (rank 3) + Vector=0.91 (rank 2) -> RRF=0.88
```

## Annotations

- **`--explain` flag:** Adds per-result scoring details to the normal hybrid search output.
- **Hybrid trace:** You can see the lexical rank, vector rank, and fused score for each result.
- **Result limit:** Use `-n` to control how many explained results are shown.
- **Debugging value:** Explain mode is most useful when tuning collections or validating ranking behavior locally.
