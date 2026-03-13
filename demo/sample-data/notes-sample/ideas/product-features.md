# Product Feature Ideas

Brainstorm log for upcoming features. Reviewed and prioritized during monthly product review.

*Last updated: 2025-03-10*

---

## High Priority

- **[P0] Real-time notifications** — Push alerts for order status changes, inventory warnings, and system health. Use WebSockets with a fallback to SSE. *Requested by 12 merchants in Q4 feedback.*

- **[P0] Multi-currency support** — Display prices and reports in the merchant's local currency. Integrate with an exchange rate API (e.g., Open Exchange Rates). *Blocker for EU expansion.*

- **[P1] Custom report builder** — Drag-and-drop interface for merchants to create their own reports from available data dimensions. Build on top of the Aurora dashboard infrastructure.

- **[P1] Bulk product import** — CSV/Excel upload for adding or updating products in batch. Include validation preview and error highlighting before commit.

## Medium Priority

- **[P2] Saved filters and views** — Let users save frequently used filter combinations on the dashboard and share them with team members.

- **[P2] Dark mode** — Theme toggle for the merchant portal. Follow system preference by default.

- **[P2] Webhook integrations** — Allow merchants to register webhook URLs for key events (order placed, inventory low, refund issued). Retry with exponential backoff.

- **[P2] Two-factor authentication** — TOTP-based 2FA as an opt-in security feature. Provide recovery codes on setup.

## Low Priority / Exploratory

- **[P3] AI-powered sales insights** — Weekly auto-generated summary of trends, anomalies, and recommendations. Could use an LLM to narrate the data.

- **[P3] Mobile companion app** — Lightweight React Native app for checking orders and inventory on the go. Push notifications tied to the alerts system.

- **[P3] Marketplace / app store** — Allow third-party developers to build and list integrations. Requires an app review process and sandboxed API keys.

- **[P3] Inventory forecasting** — Predict stock-out dates based on historical sales velocity. Alert merchants to reorder before running out.

---

## Parking Lot

Ideas that need more research before prioritizing:

- Social commerce integration (Instagram/TikTok shop sync)
- B2B wholesale portal with tiered pricing
- Augmented reality product previews
- Loyalty points and rewards program
- Multi-warehouse inventory management

---

*Next review: April 2025 product planning session*
