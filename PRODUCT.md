# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Factory workers** (sewing, packing, delivery) at the ARA MEGA garment factory in Malaysia, using their own phones with one hand, mid-work. They post jobs by snapping the paper jobsheet, mark work done with proof photos, and report problems.
- **Office / admin staff** ("Bos ZH" and office) — manage customers, dates, inventory, performance, and fix mistakes. Admin actions sit behind a PIN.
- **The whole factory** watches the 📺 Production View on a 50-inch TV: live boards read from across the room.

## Product Purpose

The Kilang App tracks every garment job from the moment its paper jobsheet is photographed until it is out the door: Checking (swipe want/not-seen) → Delivery / Postage / Defect boards → Done with proof photo → ✔ Delivered or ✔ Sent to J&T. It also handles problem reports (typed or one-tap), a full per-job chronology, supply inventory, evidence history, and a daily Done÷Load performance KPI. Success = no job lost or forgotten, problems seen and solved fast, and the boss can see the whole factory's state at a glance.

## Positioning

Replaces WhatsApp photo threads and paper memory with one shared board built around the physical artifacts the factory already uses — paper jobsheets and J&T waybill stickers. Runs entirely free on Google Apps Script + Google Sheets + Google Drive; no accounts, no server, no subscription.

## Operating Context

- Physical paper jobsheets and J&T courier waybill stickers are photographed as the source of truth; the proof-of-delivery photo seals a job.
- Deployed by pasting `Code.gs` + `Index.html` into script.google.com; data lives in the Google Sheet "Kilang App Data" (Jobs + Inventory tabs), photos in the Drive folder "Kilang App Photos".
- Phones on the factory floor (one-hand use, camera-first); a 50-inch TV shows Production View; office uses the same app with the admin PIN.

## Capabilities and Constraints

- Single-file frontend (`Index.html`) + Apps Script backend (`Code.gs`), talking via `google.script.run`; LockService guards concurrent writes.
- Photos are compressed client-side (full ≈1100px @ 0.75 JPEG, thumbnails ≈480px @ 0.6) and cached in localStorage; thumbnails preload so flipping is instant.
- Problem lifecycle is an append-only log supporting repeated report→solve cycles (P1, S1, P2, S2…).
- Every change must keep the Node server test suite and the Playwright browser suite green before shipping.
- Open items: ADMIN_PIN is still the default '1234' (must be changed by the boss before wider use); the Paper section of stock is a placeholder awaiting the real item list.

## Brand Commitments

- **The green is the brand** — ARAMEGA green theme and the ARAMEGA logo (aramega.com.my) are binding; future design work keeps them.
- **Language: mixed English + Malay** — short simple English labels with Malay-friendly phrasing where natural (confirmed by the boss). Emoji-led labels (📦 ✅ 🚨 ⋯) carry meaning for quick recognition.
- Voice: direct, warm, factory-floor plain talk; big friendly buttons over dense menus.

## Product Principles

1. **Photos first, one hand, big targets.** Every core action starts from the camera and must be doable mid-work on a phone.
2. **Never lose a job.** Ready-but-not-delivered work stays visible and sorts to the top; counts and KPIs are honest (never >100%).
3. **Reporting a problem is as fast as doing the job.** One or two taps from anywhere, including the TV.
4. **The TV is read from across the factory.** Big numbers, colour-coded status, identical card heights, glanceable columns.
5. **Stay free and simple.** Sheets + Drive + one PIN; no new services, accounts, or costs.

## Accessibility & Inclusion

Labels pair emoji with short words so meaning survives low literacy in either language. TV surfaces use large type and strong colour coding for distance reading. No formal standard mandated.
