# Project Kickoff — Project Aurora

**Date:** 2025-02-03
**Attendees:** Lisa Wang (PM), Sarah Chen (Eng Lead), Marcus Johnson, Priya Patel, Alex Rivera, Jordan Kim, David Park (Design)
**Sponsor:** VP of Product — Raj Gupta

---

## Project Overview

**Project Aurora** is a customer-facing analytics dashboard that gives merchants real-time visibility into sales, inventory, and customer behavior. Target launch: end of Q2 2025.

## Goals

1. Deliver a self-service analytics dashboard accessible from the main merchant portal.
2. Support real-time data refresh (< 30s latency from event to chart).
3. Provide 5 default report templates: Sales Overview, Inventory Status, Customer Segments, Revenue Trends, Top Products.
4. Enable CSV/PDF export for all reports.
5. Achieve 99.5% uptime SLA for the dashboard service.

## Timeline

| Milestone                | Target Date | Owner       |
|--------------------------|-------------|-------------|
| Technical Design Review  | 2025-02-14  | Sarah Chen  |
| Data Pipeline MVP        | 2025-03-07  | Marcus      |
| Dashboard UI v1          | 2025-03-21  | Alex + David|
| Integration Testing      | 2025-04-04  | Priya       |
| Beta Launch (internal)   | 2025-04-18  | Jordan      |
| Public Launch            | 2025-06-02  | Lisa (PM)   |

## Team Assignments

- **Sarah Chen** — Technical lead, architecture decisions, code reviews.
- **Marcus Johnson** — Data pipeline: Kafka consumers, aggregation service, ClickHouse schema.
- **Priya Patel** — API layer between the data store and the frontend; load testing.
- **Alex Rivera** — Frontend dashboard (React + D3.js charts).
- **David Park** — UX/UI design, report templates, user research sessions.
- **Jordan Kim** — Infrastructure: ClickHouse cluster, Kafka topics, monitoring, CI/CD.
- **Lisa Wang** — Project management, stakeholder communication, launch coordination.

## Technical Decisions

- **Data store:** ClickHouse for OLAP queries (sub-second aggregations on millions of rows).
- **Streaming:** Kafka for event ingestion; consumers write to ClickHouse.
- **Frontend:** React with D3.js for custom charts; Tailwind CSS for styling.
- **Auth:** Reuse existing merchant portal SSO (OAuth 2.0 + PKCE).

## Risks

| Risk                                  | Mitigation                                  |
|---------------------------------------|---------------------------------------------|
| ClickHouse operational complexity     | Jordan to run a 2-week spike before commit  |
| Real-time latency target too tight    | Fall back to 60s refresh if < 30s not feasible |
| Design dependencies blocking frontend | David to deliver wireframes by Feb 10       |

## Next Steps

- [ ] Sarah to publish the Technical Design Doc by Feb 14.
- [ ] David to share wireframes and user flow by Feb 10.
- [ ] Jordan to provision a ClickHouse sandbox this week.
- [ ] Lisa to set up the Aurora project board in Linear.

---

*Next check-in: February 10, 2025*
