# Catálogo de servicios / Service catalogue

Phase 2 only. The official Phase 1 project is unchanged.

## Administration

1. Open `/admin`, sign in and complete existing two-step verification.
2. Choose **Service catalogue / Catálogo de servicios**.
3. The 27 service entries from the supplied service list are created as drafts,
   grouped into seven families. No retail price or customer image is invented.
4. Edit names, descriptions and included items in English and Spanish.
5. Choose a custom quotation, or set a positive price and pricing unit in **CAD**.
   All money is stored as integer cents. There is no conversion or currency switch.
6. Upload PNG/JPEG/WebP files, up to 8 MiB each, or use public HTTPS image URLs.
   Up to ten images are supported. First image = cover; move images up/down to
   reorder. Removing a gallery item does not delete its original file.
7. Add a cover and both descriptions before publishing. Archive to hide a service;
   restore as a draft to prepare it again. Existing requests are not deleted.

Seed loading is insert-only: restarting never resets edits, prices or archived
entries. Only administrators may edit. Revision checks prevent stale overwrites.
Source catalogue restrictions remain enforced on the server, including the
Concierge-only Check-in Support and the three quotation-only services.

## Public journey

- `/servicios?channel=viilife` and `/servicios?channel=viiconcierge`: searchable
  catalogue with family filters, CAD estimates and optional combinations.
- `/servicios/<id>?channel=...`: service detail, cover, gallery and request form.
- Both immersive service feeds include the published catalogue after the scenes.
  The existing cleaning checkout is preserved.
- Customers sign in using the existing `/cliente` experience and return to the
  selected service. The request uses their authenticated email, not a browser-
  supplied email or a test recipient override.
- The server validates current publication, service options, revision and amount.
  It stores an immutable service/rate snapshot, creates a CRM lead, shows the
  request in the customer's existing request list, and queues customer/team mail
  using the configured Phase 2 outbox or SMTP. An idempotency key prevents duplicate
  submissions and duplicate messages.

## Deliberate boundaries

These new service entries start with **requests/proposals**, not a new direct
purchase gateway. A catalogue estimate does not charge a card. Recurring interest
does not establish a subscription. Final scope, supplies, coverage and taxes must
be confirmed. The earlier internal home/commercial estimating menu, accepted
agreements, ViiShop stock and existing cleaning checkout are not replaced.

The six combinations are optional suggestions, not mandatory bundles, discounted
prices or combined checkout items. ViiShop kit/product references require actual
inventory mapping later. New catalogue requests appear in CRM for follow-up;
they do not automatically turn into an approved legacy service agreement.

Host deployment must retain both Phase 2 databases and the appropriate media
directory (`data/phase2-media` or `data/phase2-staging-media`). External image
hosts must permit embedding; uploading the image avoids dependence on them.

## Verification

`npm run test:phase2-catalogue` tests draft initialisation, publication, permission
and origin checks, CAD validation, file validation, cover order, revision conflicts,
archive/restart persistence, request identity/ownership, snapshots, estimates and
mail deduplication. Tests are local, use fictional identities and do not contact
SMTP, Stripe, Shopify or Airbnb.

Local verification on 2026-10-14: full Phase 2 suite **145 passed, 0 failed**;
catalogue suite repeated after the final guards: **4 passed, 0 failed**; syntax
check: **215 JavaScript files**. Browser QA verified administrator image uploads,
cover reordering, CAD hourly price, publication, public detail, both languages and
390px mobile layout, plus catalogue/cleaning-form coexistence after the ViiLife
feed. QA used isolated memory databases and disposable copies of existing assets;
no production data, email delivery, live payment or external integration was used.
