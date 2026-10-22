# Guest checkout · Phase 2

Implemented only in the independent `viicasa-fase2-demo` copy. This change does not modify the official Phase 1 repository, deploy the site, activate provider connections or allow live Stripe keys.

## Customer experience

- ViiLife quick cleaning: choose service and preferred dates, enter contact/address, review the CAD total, then pay without creating an account. Large requests retain the existing administrator approval threshold; the approval email opens that specific order for payment.
- ViiShop copied catalogue and property reservations retain server-calculated prices, stock/date holds and Stripe sandbox checkout. Guest messages and receipts link to the individual order, not a login screen.
- The Phase 2 shop channel accepts guest contact data. Local sample products remain a **simulation**. Shopify carts can receive guest details through the existing opt-in adapter; the connection remains disabled until separately configured and approved.
- Published service-catalogue items and residential/commercial enquiries no longer require login. These remain **proposal requests**, not automatic paid bookings or subscriptions.
- Agreements and invoices sent by the team can be reviewed, accepted with recorded consent, downloaded as PDF and paid from their individual email links without an account. Agreement acceptance records `private_email_link`, not a verified account or certified digital signature. It does not activate recurring charges. Optional saved-card/recurring-payment authorisations retain their separate verified-account and consent requirements.
- Creating an account remains optional. A platform or channel order/enquiry can be linked explicitly after signing in with the same verified email; merely typing an email never imports another person's history.

## Privacy and access

- A guest buyer is a separate browser identity, not a password account and not email verification.
- Links contain random 256-bit capabilities in a URL fragment (`/pedido#access=…`). Only their hashes and encrypted values are stored. Do not forward the links or publish outbox contents.
- The browser clears the fragment and exchanges it for a short-lived HttpOnly, SameSite cookie, Secure over HTTPS. Links expire after 30 days; viewing sessions last 15 minutes, extended to one hour when beginning payment. An expired link requires assistance from the team.
- Read/payment/claim operations are limited to one resource. Payment and claim also require its matching reference so opening a different order in another tab cannot act on the wrong order.
- The private page uses no-store/no-referrer and excludes analytics/consent-script injection. Administrator MFA, private customer lists and all unrelated account protections remain enabled.
- Preserve the existing Phase 2 vault key and both independent databases across deployments. New guest tables and ownership columns are created through the existing startup migration.
- Claiming an eligible order revokes its old private links and grants. It never changes payment amounts or marks a payment as successful.

## Local checks

```powershell
node --test --test-concurrency=1 phase2/test/guest-checkout.test.mjs
npm run test:phase2
npm run build
```

For a disposable browser preview with fictional data and in-memory databases:

```powershell
node phase2/preview-guest-checkout.mjs
```

It listens only at `127.0.0.1:3038`, prints a sample catalogue URL and a fictional private-order link, reads no `.env` and sends no SMTP or provider requests. Stop it with Ctrl+C. Do not use this fixture as a Hostinger entry point.

## Deployment and integrations

- Review and push the explicit changed/new source files on branch `fase-2`, then redeploy that branch in Hostinger. No commit or deployment is performed by this implementation.
- Email uses the existing queues/worker. `PHASE2_MAIL_MODE=outbox` keeps messages local. Real delivery requires separately approved `PHASE2_MAIL_MODE=smtp` plus the Phase 2 SMTP host, port, secure setting, user, password, sender and administrator recipient. No secrets belong in Git.
- Card testing requires the existing `PHASE2_STRIPE_SECRET_KEY=sk_test_…` and the matching destination's webhook secret. No payment is confirmed by a redirect; only the verified webhook (or an explicitly labelled local simulation) updates it.
- No new registration-required environment switch is necessary: the Phase 2 public configuration advertises `guestCheckoutEnabled: true`.
- External checkout URLs and SMTP delivery must still be validated after provider connections and the Hostinger deployment are configured. Local mocks/outbox assertions do not prove real delivery or real provider transactions.
