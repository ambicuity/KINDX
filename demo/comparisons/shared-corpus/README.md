# Shared Corpus

The evaluation corpus used by all comparison tests lives at:

```
specs/eval-docs/
```

From this directory:
```
../../specs/eval-docs/
```

## Files

| File | Topic | Size |
|------|-------|------|
| api-design-principles.md | REST API design, versioning, HTTP methods | ~3KB |
| distributed-systems-overview.md | CAP theorem, consensus, Raft, Paxos | ~3KB |
| machine-learning-primer.md | ML basics, overfitting, F1/precision/recall | ~3KB |
| product-launch-retrospective.md | Project Phoenix, beta bugs, post-mortem | ~3KB |
| remote-work-policy.md | WFH guidelines, VPN, team gatherings | ~3KB |
| startup-fundraising-memo.md | Series A, investor pitch, Sequoia | ~3KB |

All test scripts reference these same 6 files via `shared-queries.json`.
