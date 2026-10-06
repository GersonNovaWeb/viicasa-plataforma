# ViiLife — preview inside the real platform

The platform defaults `VIILIFE_MODE` to `demo`. Only ViiLife changes; ViiShop, properties, the Coming Soon website and their SMTP templates are untouched. There is no Stripe call in the preview purchase flow, not even when the platform's Stripe provider is live. Existing real cleaning checkouts cannot start a new payment while this section is in demo mode. Already-created external Stripe sessions are not revoked by this switch.

## User journey

- `/viilife` and `/viilife/limpieza`: service, duration, preferred days/start date/start time, contact and address. No focus-room questionnaire or mandatory Google login in the demo.
- Routine: hourly rate × hours per visit × selected days, one cycle only. Biweekly does not double visits. Deep cleaning retains the existing area/room formula for a single visit; additional services are not silently added.
- Hours: 1–8, start 08:00–18:00, finishing by 20:00. These demo limits require operational approval before production.
- Provisional large-order rule: **more than 3 hours OR more than 3 days**. Admin can edit thresholds and rate/currency in the ViiLife demo tab. CAD and USD amounts are independent, no currency conversion.
- Continue saves the request and opens the summary. The customer completes a clearly labelled simulated payment without admin approval or a bank card. It does not book a visit.
- My account → My ViiLife services shows this browser session's requests. If signed in before requesting, they belong to that identity. Anonymous session data is not automatically transferred to a later Google login.
- Large requests generate a team notice immediately. After one hour without completing the demo payment, another deduplicated follow-up notice is queued. Nothing is captured before the form is submitted; closing a page alone is not tracked.

## Real email, test-only recipient

All team notices **and customer previews** are forced server-side to `gerson@novaweb-agency.com`. The email entered in the form is not used as a delivery recipient. Subjects begin `[DEMO VIILIFE]`. Messages are plain-text transaction summaries, not the Coming Soon welcome templates. Do not use real personal details in a demo.

Hostinger server variables:

```dotenv
VIILIFE_MODE=demo
VIILIFE_DEMO_MAIL_MODE=smtp
SMTP_HOST=your-provider-host
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=accounts@viicasa.com
SMTP_PASSWORD=your-mailbox-password
MAIL_FROM=accounts@viicasa.com
```

Use the same provider's SMTP settings as the working landing, but configure them separately in **this platform's** hosting. Port 587 requires `SMTP_SECURE=false`. Never commit the password. `MAIL_MODE` continues controlling only the platform's regular messages; enabling this demo does not enable real order emails.

For local preview, create ignored `.env.viilife-demo.local` with those SMTP fields and `VIILIFE_DEMO_MAIL_MODE=smtp`, start Firestore emulator on 8088, then `npm run dev:viilife`. The launcher reads only SMTP fields from `.env` / that local override. It never loads real Firebase or Stripe credentials. `npm run dev` still does not load these local mail files.

Mail is queued atomically, sent by the running platform maintenance loop (~30 seconds), and tracked in the admin. SMTP acceptance is not a delivery guarantee. No configuration → pending; ambiguous SMTP outcome → unknown, without automatic resend. A crash during send leaves sending for manual investigation. Hard limit: 90 demo messages/rolling 24h. The queue resumes when configured/limit clears; review pending test mail before enabling. No historical Coming Soon messages are sent.

Demo data uses `viilife_demo_*` collections, not `checkouts`, `payments`, `cleaning_requests`, `mail_outbox` or `cs_*`. Admin authentication/roles remain unchanged. Firestore server access remains private; do not open Firestore rules. Demo records are not counted as real sales.

## Before switching to real service

Client approval is still required for prices, thresholds, coverage, taxes, cancellation/refund policy, scheduling and exact notification recipients. `VIILIFE_MODE=live` restores the previous real cleaning implementation (and its authentication/payment checks); it does not migrate demo orders or promote simulated payments. Porting the approved simplified flow to live mode is a separate step, not a silent environment toggle.

Tests: `npm run check`, `npm run test:viilife-demo` (isolated Firestore project, emulator 8088), `npm run test:cleaning`. No test suite sends real email. Real delivery requires SMTP configuration and an explicit walkthrough.
