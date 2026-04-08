# Sprint Retrospective — Sprint 2025-S5

**Date:** 2025-03-14
**Sprint Duration:** 2025-03-03 to 2025-03-14
**Facilitator:** Lisa Wang
**Attendees:** Sarah Chen, Marcus Johnson, Priya Patel, Alex Rivera, Jordan Kim, David Park

---

## Sprint Summary

Completed 34 of 38 story points (89%). Shipped the data pipeline MVP and the first iteration of the dashboard UI. Two items carried over to the next sprint.

---

## What Went Well

- **Data pipeline delivered on schedule.** Marcus hit the March 7 milestone with a day to spare. Kafka consumer throughput exceeded expectations at 12k events/sec.
- **Cross-team pairing.** Alex and David paired on the chart components, which reduced design-to-implementation feedback loops from days to hours.
- **CI/CD improvements.** Jordan's new GitHub Actions pipeline catches integration issues early. Zero broken-main incidents this sprint.
- **Documentation culture.** The team wrote ADRs for all major decisions, making onboarding a new contractor seamless.

## What Didn't Go Well

- **ClickHouse query tuning took longer than expected.** Some aggregation queries ran 10x slower than benchmarks due to suboptimal table engine choice. Cost us ~2 days.
- **Scope creep on the export feature.** The PDF export requirement grew from "basic table export" to "branded PDF with charts," adding unplanned work.
- **Flaky integration tests.** Three tests intermittently fail due to timing issues with the Kafka test container. Developers are ignoring failures, which is risky.
- **Standup meetings running long.** Several standups exceeded 20 minutes because discussions went too deep.

## Action Items

- [ ] **Marcus:** Switch the events table to `ReplacingMergeTree` engine and re-benchmark by March 18.
- [ ] **Lisa:** Add a "scope freeze" checkpoint at sprint midpoint to prevent creep.
- [ ] **Priya:** Rewrite flaky Kafka integration tests with explicit wait conditions by March 21.
- [ ] **Sarah:** Enforce a 15-minute timebox for standups; deep dives go to a follow-up thread.
- [ ] **David:** Create a PDF export spec document so scope is locked before implementation begins.
- [ ] **Jordan:** Add test reliability dashboard to Grafana so flaky tests are visible to everyone.

## Shoutouts

- Marcus for the clutch pipeline delivery under pressure.
- David and Alex for the pairing sessions — the chart components look great.
- Jordan for the CI/CD pipeline that saved us from at least 3 broken deploys.

---

## Metrics

| Metric                  | This Sprint | Last Sprint | Trend |
|-------------------------|-------------|-------------|-------|
| Story points completed  | 34          | 29          | +17%  |
| Carry-over items        | 2           | 4           | -50%  |
| PR cycle time (median)  | 4.2 hrs     | 6.8 hrs     | -38%  |
| Broken-main incidents   | 0           | 2           | -100% |
| Test coverage           | 78%         | 74%         | +4%   |

---

*Next retrospective: March 28, 2025*
