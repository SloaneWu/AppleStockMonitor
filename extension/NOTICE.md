# Source and modification notice

This browser extension is derived from the browser-extension directory of:
https://github.com/Sunbelife/apple-store-helper-15

Upstream revision: 1f83f0f6d54b4382c18df6ac68ab2ce4acf6942f
Original project: Sunbelife/apple-store-helper-15, forked from hteen/apple-store-helper.
License: GNU General Public License version 3 (see LICENSE).

Modified on 2026-09-20 for the user's Windows / Apple Hong Kong / Central inventory monitoring workflow.

Modifications include strict per-store SKU status parsing, distinct pickup-ineligible and error states, Central query aggregation, 60-second polling and Retry-After backoff, browser requests without validation-cookie manipulation, persistent IndexedDB history and CSV export, lifecycle handling, updated verified HK iPhone catalog, Chinese dashboard, and tests. Version 2.0 removed upstream Bark integration; version 2.1 adds an explicit opt-in official Bark HTTPS POST integration with masked local configuration, test delivery, grouped restock alerts, failure reporting, redacted errors, and tests.

All source needed to run this modified extension is supplied in this directory. The included icons and inherited source/data originate from the upstream project. Tests use Node.js and the test-only fake-indexeddb dependency; no external JavaScript library is required by the installed extension.

The original Windows executable supplied by the user is not modified or redistributed in this package. This extension is not an official Apple product.

Version 3.0 added 20-second scheduling, a temporary 10-second mode, 60-second conservative checks, persistent connection recovery and request leases, a 40-product Hong Kong catalog, a durable Bark queue, separate inventory-change retention, and optional single-item shopping-bag preparation.

Version 3.1 (2026-09-23, development build) adds a grouped dashboard with search and status filters, dedicated settings/history/purchase views, and regression fixes for cancellation, concurrent reconnect/start operations, ambiguous visible prices, purchase-reset ordering, and notification queue draining. Catalog revalidation is read-only by default. Source and regression tests are included; real-browser endurance and purchase-page compatibility are not yet certified.

Version 3.1.2 (2026-09-24, development acceptance build) adds persistent protective suspension after blocked stock responses, bounded manual recovery validation without automatic resumption or purchase, MAIN-world bridge readiness checks, and offline DOM integration tests using the test-only jsdom dependency. Historical data and successful stock baselines are preserved. This change does not establish the upstream cause of HTTP 541 or certify long-running Apple service availability.

Version 4.0.1 (2026-09-26) adds a portable Windows desktop host using Electron, isolated local/remote windows, an explicit IPC adapter, atomic file-backed settings, independent scheduling, tray behavior, paused-by-default startup, redacted backup exports, and packaged offline integration tests. The original browser-extension release remains separate. Electron and Chromium retain their respective licenses; source for this modified application is provided.
