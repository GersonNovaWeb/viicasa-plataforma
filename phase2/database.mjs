import {PGlite} from '@electric-sql/pglite';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {postgresDatabase,databaseIdentity} from './postgres.mjs';

export async function openPhase2Databases(directory,{memory=false,driver='pglite',commercialUrl,platformUrl,ssl=true}={}){
  if(!['pglite','postgres'].includes(driver)||memory&&driver!=='pglite')throw Error('Invalid Phase 2 database driver.');
  if(driver==='postgres'&&databaseIdentity(commercialUrl)===databaseIdentity(platformUrl))throw Error('Phase 2 platform and commercial databases must be independent.');
  if(driver==='pglite'&&!memory)await mkdir(directory,{recursive:true});
  const commercial=driver==='postgres'?postgresDatabase(commercialUrl,{ssl}):new PGlite(memory?undefined:join(directory,'commercial'));
  const platform=driver==='postgres'?postgresDatabase(platformUrl,{ssl}):new PGlite(memory?undefined:join(directory,'platform'));
  try{
  await Promise.all([commercial.waitReady,platform.waitReady]);
  await commercial.transaction(async tx=>{
  if(driver==='postgres')await tx.query('SELECT pg_advisory_xact_lock(73182001)');
  await tx.exec(`
    CREATE TABLE IF NOT EXISTS team_users (
      id uuid PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL,
      password_hash text NOT NULL, role text NOT NULL CHECK(role IN ('admin','seller')),
      active boolean NOT NULL DEFAULT true, deleted boolean NOT NULL DEFAULT false,
      phone text NOT NULL DEFAULT '', goal_minor bigint NOT NULL DEFAULT 0 CHECK(goal_minor>=0),
      auth_version integer NOT NULL DEFAULT 1, totp_secret text, totp_counter bigint NOT NULL DEFAULT -1,
      recovery_hashes jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS team_challenges (
      token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES team_users(id),
      auth_version integer NOT NULL, expires_at timestamptz NOT NULL, attempts integer NOT NULL DEFAULT 0);
    ALTER TABLE team_challenges ADD COLUMN IF NOT EXISTS requested_role text CHECK(requested_role IN ('admin','seller'));
    CREATE TABLE IF NOT EXISTS team_sessions (
      token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES team_users(id),
      auth_version integer NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE team_sessions ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
    CREATE UNIQUE INDEX IF NOT EXISTS team_session_id ON team_sessions(id);
    CREATE TABLE IF NOT EXISTS crm_leads (
      id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES team_users(id), name text NOT NULL,
      email text NOT NULL, phone text NOT NULL DEFAULT '', company text NOT NULL DEFAULT '',
      service text NOT NULL CHECK(service IN ('home','commercial','shop','concierge')),
      stage text NOT NULL CHECK(stage IN ('new','contacted','qualified','proposal','won','lost')),
      priority text NOT NULL CHECK(priority IN ('low','normal','high')), source text NOT NULL,
      notes text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS crm_owner ON crm_leads(owner_id,updated_at DESC);
    CREATE TABLE IF NOT EXISTS crm_activities (
      id uuid PRIMARY KEY, lead_id uuid NOT NULL REFERENCES crm_leads(id), actor_id uuid NOT NULL REFERENCES team_users(id),
      kind text NOT NULL CHECK(kind IN ('note','call','email','task')), body text NOT NULL,
      due_at timestamptz, done boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS commission_rules (
      service text PRIMARY KEY CHECK(service IN ('home','commercial','shop','concierge')),
      basis_points integer NOT NULL CHECK(basis_points BETWEEN 0 AND 10000), approved boolean NOT NULL DEFAULT false);
    CREATE TABLE IF NOT EXISTS commercial_sales (
      id uuid PRIMARY KEY, lead_id uuid NOT NULL REFERENCES crm_leads(id), seller_id uuid NOT NULL REFERENCES team_users(id),
      reference text NOT NULL UNIQUE, amount_minor bigint NOT NULL CHECK(amount_minor>0), currency text NOT NULL CHECK(currency='CAD'),
      status text NOT NULL CHECK(status IN ('pending','paid','cancelled')), basis_points integer NOT NULL,
      commission_minor bigint NOT NULL CHECK(commission_minor>=0), commission_status text NOT NULL CHECK(commission_status IN ('pending','approved','paid','cancelled')),
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS sales_seller ON commercial_sales(seller_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS team_notifications (
      id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES team_users(id), body text NOT NULL, read boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS team_audit (
      id uuid PRIMARY KEY, actor_id uuid REFERENCES team_users(id), action text NOT NULL, resource text NOT NULL,
      detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS commercial_alerts (
      id uuid PRIMARY KEY, event_key text NOT NULL UNIQUE, user_id uuid NOT NULL REFERENCES team_users(id),
      lead_id uuid REFERENCES crm_leads(id), kind text NOT NULL, resource_id uuid NOT NULL,
      required_role text CHECK(required_role IN ('admin')), status text NOT NULL CHECK(status IN ('active','resolved')),
      body text NOT NULL, details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz);
    CREATE INDEX IF NOT EXISTS commercial_alert_owner ON commercial_alerts(user_id,status);
    ALTER TABLE team_notifications ADD COLUMN IF NOT EXISTS alert_id uuid REFERENCES commercial_alerts(id);
    CREATE UNIQUE INDEX IF NOT EXISTS team_notification_alert ON team_notifications(alert_id) WHERE alert_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS followup_runs (
      id uuid PRIMARY KEY, started_at timestamptz NOT NULL, completed_at timestamptz NOT NULL DEFAULT now(),
      considered integer NOT NULL, activated integer NOT NULL, resolved integer NOT NULL,
      source text NOT NULL CHECK(source IN ('worker','admin')), actor_id uuid REFERENCES team_users(id));
    CREATE TABLE IF NOT EXISTS measurement_consents (
      id uuid PRIMARY KEY, token_hash text NOT NULL UNIQUE, policy_version text NOT NULL,
      statistics boolean NOT NULL, marketing boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL, revoked_at timestamptz);
    CREATE TABLE IF NOT EXISTS measurement_links (
      reference_hash text PRIMARY KEY, consent_id uuid NOT NULL REFERENCES measurement_consents(id) ON DELETE CASCADE,
      section text NOT NULL CHECK(section IN ('viilife','viishop','viiconcierge')), created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS measurement_events (
      id uuid PRIMARY KEY, event_key text NOT NULL UNIQUE, consent_id uuid NOT NULL REFERENCES measurement_consents(id) ON DELETE CASCADE,
      name text NOT NULL CHECK(name IN ('page_view','generate_lead','begin_checkout','purchase')),
      section text NOT NULL CHECK(section IN ('viilife','viishop','viiconcierge','home','account')),
      source text NOT NULL CHECK(source IN ('browser','server')), params jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS measurement_events_date ON measurement_events(created_at,name);
    CREATE TABLE IF NOT EXISTS analytics_deliveries (
      event_id uuid NOT NULL REFERENCES measurement_events(id) ON DELETE CASCADE, provider text NOT NULL CHECK(provider IN ('ga4','meta')),
      status text NOT NULL CHECK(status IN ('sending','accepted','unknown','failed','cancelled','expired')),
      result jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(event_id,provider));
    CREATE TABLE IF NOT EXISTS integration_events (
      id uuid PRIMARY KEY, provider text NOT NULL, reference text NOT NULL UNIQUE,
      payload jsonb NOT NULL, mode text NOT NULL CHECK(mode='demo'), created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS service_quotes (
      id uuid PRIMARY KEY, lead_id uuid NOT NULL REFERENCES crm_leads(id), actor_id uuid NOT NULL REFERENCES team_users(id),
      selection jsonb NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE service_quotes ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
    ALTER TABLE service_quotes ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','rejected'));
    ALTER TABLE service_quotes ADD COLUMN IF NOT EXISTS demo_key text UNIQUE;
    CREATE TABLE IF NOT EXISTS customer_accounts (
      id uuid PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL, password_hash text NOT NULL,
      email_verified boolean NOT NULL DEFAULT false, auth_version integer NOT NULL DEFAULT 1,
      active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS customer_challenges (
      token_hash text PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customer_accounts(id),
      code_hash text NOT NULL, purpose text NOT NULL CHECK(purpose IN ('verify','reset')),
      expires_at timestamptz NOT NULL, attempts integer NOT NULL DEFAULT 0, used boolean NOT NULL DEFAULT false);
    CREATE TABLE IF NOT EXISTS customer_sessions (
      token_hash text PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customer_accounts(id), auth_version integer NOT NULL,
      expires_at timestamptz NOT NULL);
    ALTER TABLE customer_accounts ADD COLUMN IF NOT EXISTS password_enabled boolean NOT NULL DEFAULT true;
    ALTER TABLE customer_sessions ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'password' CHECK(provider IN ('password','google','apple'));
    CREATE TABLE IF NOT EXISTS customer_identities (
      provider text NOT NULL CHECK(provider IN ('google','apple')), subject text NOT NULL,
      customer_id uuid NOT NULL REFERENCES customer_accounts(id), provider_email text NOT NULL,
      linked_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(provider,subject), UNIQUE(customer_id,provider));
    CREATE TABLE IF NOT EXISTS customer_oauth_flows (
      state_hash text PRIMARY KEY, browser_hash text NOT NULL, provider text NOT NULL CHECK(provider IN ('google','apple')),
      nonce text NOT NULL, verifier_cipher text, client_id text NOT NULL,
      intent text NOT NULL CHECK(intent IN ('signin','link')), target_id uuid REFERENCES customer_accounts(id),
      target_session_hash text, target_auth_version integer,
      status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','complete','failed')),
      expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS client_service_requests (
      id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customer_accounts(id), lead_id uuid NOT NULL REFERENCES crm_leads(id),
      idempotency_key text NOT NULL, request_hash text NOT NULL, details jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(customer_id,idempotency_key));
    CREATE TABLE IF NOT EXISTS commercial_mail (
      id uuid PRIMARY KEY, dedupe text NOT NULL UNIQUE, recipient text NOT NULL, subject text NOT NULL,
      body text NOT NULL, html text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','sent','failed')),
      attempts integer NOT NULL DEFAULT 0, next_attempt timestamptz NOT NULL DEFAULT now(),
      lease_token text, last_error text, created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz);
    CREATE INDEX IF NOT EXISTS commercial_mail_pending ON commercial_mail(status,next_attempt);
    ALTER TABLE commercial_mail ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]';
    ALTER TABLE commercial_mail ADD COLUMN IF NOT EXISTS delivery_scope text NOT NULL DEFAULT 'standard' CHECK(delivery_scope IN ('standard','preview'));
    ALTER TABLE commercial_mail DROP CONSTRAINT IF EXISTS commercial_mail_status_check;
    ALTER TABLE commercial_mail ADD CONSTRAINT commercial_mail_status_check CHECK(status IN ('pending','processing','sent','failed','cancelled'));
    CREATE TABLE IF NOT EXISTS service_contracts (
      id uuid PRIMARY KEY, quote_id uuid NOT NULL UNIQUE REFERENCES service_quotes(id), lead_id uuid NOT NULL REFERENCES crm_leads(id),
      seller_id uuid NOT NULL REFERENCES team_users(id), customer_email text NOT NULL, version integer NOT NULL DEFAULT 1,
      status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','sent','accepted','declined','cancelled')),
      snapshot jsonb NOT NULL, snapshot_hash text NOT NULL, accepted_by uuid REFERENCES customer_accounts(id),
      acceptance jsonb, sent_at timestamptz, accepted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS contract_customer ON service_contracts(customer_email,status);
    CREATE TABLE IF NOT EXISTS contract_events (
      id uuid PRIMARY KEY, contract_id uuid NOT NULL REFERENCES service_contracts(id), actor_id uuid NOT NULL,
      actor_kind text NOT NULL CHECK(actor_kind IN ('team','customer')), action text NOT NULL, detail jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS service_visits (
      id uuid PRIMARY KEY, contract_id uuid NOT NULL REFERENCES service_contracts(id), property_index integer NOT NULL,
      service_date date NOT NULL, arrival_window text NOT NULL, address text NOT NULL,
      amount_minor bigint NOT NULL CHECK(amount_minor>0), discount_minor bigint NOT NULL DEFAULT 0 CHECK(discount_minor>=0),
      status text NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','completed','missed','cancelled')),
      completed_at timestamptz, invoice_id uuid, UNIQUE(contract_id,property_index,service_date));
    ALTER TABLE service_visits ADD COLUMN IF NOT EXISTS pricing jsonb NOT NULL DEFAULT '{}';
    CREATE TABLE IF NOT EXISTS pricing_policy_versions (
      segment text NOT NULL CHECK(segment IN ('home','commercial')), revision integer NOT NULL,
      value jsonb NOT NULL, actor_id uuid NOT NULL REFERENCES team_users(id),
      created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(segment,revision));
    CREATE INDEX IF NOT EXISTS service_visits_schedule ON service_visits(service_date,status);
    CREATE TABLE IF NOT EXISTS service_invoices (
      id uuid PRIMARY KEY, contract_id uuid NOT NULL REFERENCES service_contracts(id), number text NOT NULL UNIQUE,
      customer_email text NOT NULL, status text NOT NULL DEFAULT 'issued' CHECK(status IN ('issued','paid','cancelled','payment_review')),
      currency text NOT NULL DEFAULT 'CAD', total_minor bigint NOT NULL CHECK(total_minor>0),
      discount_minor bigint NOT NULL DEFAULT 0, period text NOT NULL, snapshot jsonb NOT NULL,
      issued_at timestamptz NOT NULL DEFAULT now(), due_date date NOT NULL, paid_at timestamptz);
    CREATE TABLE IF NOT EXISTS service_invoice_payments (
      id uuid PRIMARY KEY, invoice_id uuid NOT NULL REFERENCES service_invoices(id), provider text NOT NULL CHECK(provider IN ('demo','stripe')),
      status text NOT NULL CHECK(status IN ('creating','open','paid','failed','expired')),
      amount_minor bigint NOT NULL, currency text NOT NULL, reference text UNIQUE, checkout_url text,
      expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE service_invoices ADD COLUMN IF NOT EXISTS segment text NOT NULL DEFAULT 'home' CHECK(segment IN ('home','commercial'));
    CREATE UNIQUE INDEX IF NOT EXISTS invoice_commercial_period ON service_invoices(contract_id,period) WHERE segment='commercial';
    CREATE TABLE IF NOT EXISTS service_payment_events (
      event_id text PRIMARY KEY, payment_id uuid NOT NULL REFERENCES service_invoice_payments(id), outcome text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS financial_requests (
      id uuid PRIMARY KEY, invoice_id uuid NOT NULL REFERENCES service_invoices(id),
      requester_id uuid NOT NULL, requester_kind text NOT NULL CHECK(requester_kind IN ('customer','team')),
      kind text NOT NULL CHECK(kind IN ('credit','refund')), amount_minor bigint NOT NULL CHECK(amount_minor>0),
      reason text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined','withdrawn','cancelled','completed')),
      revision integer NOT NULL DEFAULT 1, approved_minor bigint CHECK(approved_minor>0), resolution text NOT NULL DEFAULT '',
      reviewed_by uuid REFERENCES team_users(id), reviewed_at timestamptz, evidence jsonb NOT NULL,
      evidence_hash text NOT NULL, idempotency_key uuid NOT NULL, attempts integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(requester_kind,requester_id,idempotency_key));
    CREATE TABLE IF NOT EXISTS financial_attempts (
      id uuid PRIMARY KEY, request_id uuid NOT NULL REFERENCES financial_requests(id),
      outcome text NOT NULL CHECK(outcome IN ('succeeded','failed')), created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS financial_entries (
      id uuid PRIMARY KEY, request_id uuid NOT NULL UNIQUE REFERENCES financial_requests(id),
      invoice_id uuid NOT NULL REFERENCES service_invoices(id), kind text NOT NULL CHECK(kind IN ('credit','refund')),
      amount_minor bigint NOT NULL CHECK(amount_minor>0), provider text NOT NULL DEFAULT 'demo' CHECK(provider='demo'),
      reference text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS financial_events (
      id uuid PRIMARY KEY, request_id uuid NOT NULL REFERENCES financial_requests(id),
      actor_id uuid NOT NULL, actor_kind text NOT NULL CHECK(actor_kind IN ('customer','team')),
      action text NOT NULL, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS financial_entries_invoice ON financial_entries(invoice_id,kind);
    CREATE INDEX IF NOT EXISTS financial_requests_invoice ON financial_requests(invoice_id,status,kind);
    ALTER TABLE service_invoice_payments ADD COLUMN IF NOT EXISTS payment_intent_reference text;
    ALTER TABLE financial_entries DROP CONSTRAINT IF EXISTS financial_entries_provider_check;
    ALTER TABLE financial_entries ADD CONSTRAINT financial_entries_provider_check CHECK(provider IN ('demo','stripe'));
    CREATE TABLE IF NOT EXISTS stripe_refund_operations (
      request_id uuid PRIMARY KEY REFERENCES financial_requests(id), payment_id uuid NOT NULL REFERENCES service_invoice_payments(id),
      intent_reference text NOT NULL, reference text UNIQUE, amount_minor bigint NOT NULL CHECK(amount_minor>0),
      status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','pending','unknown','failed','succeeded')),
      lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS service_payment_invoice ON service_invoice_payments(invoice_id,status);
    ALTER TABLE service_invoices ADD COLUMN IF NOT EXISTS invoice_kind text NOT NULL DEFAULT 'service' CHECK(invoice_kind IN ('service','closing'));
    ALTER TABLE commercial_sales ADD COLUMN IF NOT EXISTS service_invoice_id uuid REFERENCES service_invoices(id);
    ALTER TABLE commercial_sales ADD COLUMN IF NOT EXISTS commission_paid_minor bigint CHECK(commission_paid_minor>=0);
    CREATE UNIQUE INDEX IF NOT EXISTS sale_service_invoice ON commercial_sales(service_invoice_id) WHERE service_invoice_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS commission_reviews (
      id uuid PRIMARY KEY, sale_id uuid NOT NULL REFERENCES commercial_sales(id),
      refund_entry_id uuid NOT NULL UNIQUE REFERENCES financial_entries(id),
      status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved')),
      revision integer NOT NULL DEFAULT 1, evidence jsonb NOT NULL, evidence_hash text NOT NULL,
      decision text CHECK(decision IN ('retain','reduce')), reduction_minor bigint NOT NULL DEFAULT 0 CHECK(reduction_minor>=0),
      disposition text CHECK(disposition IN ('retained','unpaid_reduction','recovery_due')),
      note text NOT NULL DEFAULT '', actor_id uuid REFERENCES team_users(id),
      created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz);
    CREATE INDEX IF NOT EXISTS commission_review_sale ON commission_reviews(sale_id,status);
    CREATE TABLE IF NOT EXISTS commission_recoveries (
      id uuid PRIMARY KEY, review_id uuid NOT NULL REFERENCES commission_reviews(id),
      amount_minor bigint NOT NULL CHECK(amount_minor>0), actor_id uuid NOT NULL REFERENCES team_users(id),
      note text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS commission_recovery_review ON commission_recoveries(review_id);
    CREATE TABLE IF NOT EXISTS commission_corrections (
      id uuid PRIMARY KEY, review_id uuid NOT NULL REFERENCES commission_reviews(id),
      sequence integer NOT NULL CHECK(sequence>0), reduction_minor bigint NOT NULL CHECK(reduction_minor>=0),
      previous_hash text NOT NULL, evidence jsonb NOT NULL, evidence_hash text NOT NULL,
      payload_hash text NOT NULL, actor_id uuid NOT NULL REFERENCES team_users(id), note text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(review_id,sequence));
    CREATE TABLE IF NOT EXISTS commission_payout_baselines (
      review_id uuid PRIMARY KEY REFERENCES commission_reviews(id), baseline_minor bigint NOT NULL CHECK(baseline_minor>=0));
    CREATE TABLE IF NOT EXISTS commission_supplements (
      id uuid PRIMARY KEY, review_id uuid NOT NULL REFERENCES commission_reviews(id),
      amount_minor bigint NOT NULL CHECK(amount_minor>0), actor_id uuid NOT NULL REFERENCES team_users(id),
      note text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE OR REPLACE VIEW commission_review_effects AS
      SELECT x.*,
        CASE WHEN x.commission_is_paid THEN greatest(0,x.current_reduction_minor-x.baseline_minor-x.recovered_minor+x.supplemented_minor) ELSE 0 END::bigint AS recovery_remaining_minor,
        CASE WHEN x.commission_is_paid THEN greatest(0,x.baseline_minor-x.current_reduction_minor+x.recovered_minor-x.supplemented_minor) ELSE 0 END::bigint AS supplement_due_minor,
        CASE WHEN x.status='pending' THEN NULL WHEN NOT x.commission_is_paid THEN CASE WHEN x.current_reduction_minor=0 THEN 'retained' ELSE 'unpaid_reduction' END
          WHEN x.current_reduction_minor-x.baseline_minor-x.recovered_minor+x.supplemented_minor>0 THEN 'recovery_due'
          WHEN x.current_reduction_minor-x.baseline_minor-x.recovered_minor+x.supplemented_minor<0 THEN 'supplement_due' ELSE 'retained' END AS current_disposition
      FROM (SELECT q.*,COALESCE(c.reduction_minor,q.reduction_minor)::bigint AS current_reduction_minor,
        COALESCE(c.sequence,0)::integer AS correction_revision,
        COALESCE(b.baseline_minor,CASE WHEN q.disposition='unpaid_reduction' THEN q.reduction_minor ELSE 0 END)::bigint AS baseline_minor,
        COALESCE(r.amount,0)::bigint AS recovered_minor,COALESCE(p.amount,0)::bigint AS supplemented_minor,
        v.commission_status='paid' AS commission_is_paid
        FROM commission_reviews q JOIN commercial_sales v ON v.id=q.sale_id
        LEFT JOIN LATERAL (SELECT reduction_minor,sequence FROM commission_corrections WHERE review_id=q.id ORDER BY sequence DESC LIMIT 1) c ON true
        LEFT JOIN commission_payout_baselines b ON b.review_id=q.id
        LEFT JOIN (SELECT review_id,sum(amount_minor) AS amount FROM commission_recoveries GROUP BY review_id) r ON r.review_id=q.id
        LEFT JOIN (SELECT review_id,sum(amount_minor) AS amount FROM commission_supplements GROUP BY review_id) p ON p.review_id=q.id) x;
    CREATE OR REPLACE VIEW commercial_commission_balances AS
      SELECT v.*,
        (v.commission_minor-COALESCE(a.reduction_minor,0))::bigint AS effective_commission_minor,
        COALESCE(a.reduction_minor,0)::bigint AS commission_reduction_minor,
        COALESCE(a.recovery_minor,0)::bigint AS recovery_due_minor,
        (EXISTS(SELECT 1 FROM commission_reviews q WHERE q.sale_id=v.id AND q.status='pending')
         OR EXISTS(SELECT 1 FROM financial_entries e WHERE e.invoice_id=v.service_invoice_id AND e.kind='refund'
           AND NOT EXISTS(SELECT 1 FROM commission_reviews q WHERE q.refund_entry_id=e.id AND q.status='resolved'))
         OR (v.service_invoice_id IS NULL AND EXISTS(SELECT 1 FROM financial_entries e
           JOIN service_invoices i ON i.id=e.invoice_id JOIN service_contracts c ON c.id=i.contract_id
           WHERE e.kind='refund' AND i.number=v.reference AND c.lead_id=v.lead_id AND c.seller_id=v.seller_id)))
        AS commission_review_required,
        COALESCE(a.supplement_minor,0)::bigint AS supplement_due_minor
      FROM commercial_sales v LEFT JOIN (
        SELECT q.sale_id,sum(q.current_reduction_minor) AS reduction_minor,
          sum(q.recovery_remaining_minor) AS recovery_minor,sum(q.supplement_due_minor) AS supplement_minor
        FROM commission_review_effects q WHERE q.status='resolved' GROUP BY q.sale_id
      ) a ON a.sale_id=v.id;
    CREATE TABLE IF NOT EXISTS recurring_authorizations (
      id uuid PRIMARY KEY, contract_id uuid NOT NULL UNIQUE REFERENCES service_contracts(id),
      customer_id uuid NOT NULL REFERENCES customer_accounts(id),
      status text NOT NULL DEFAULT 'paused' CHECK(status IN ('paused','active','revoked')),
      revision integer NOT NULL DEFAULT 1, consent jsonb NOT NULL, evidence_hash text NOT NULL,
      max_total_minor bigint NOT NULL CHECK(max_total_minor>0), created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS recurring_jobs (

      id uuid PRIMARY KEY, invoice_id uuid NOT NULL UNIQUE REFERENCES service_invoices(id),
      authorization_id uuid NOT NULL REFERENCES recurring_authorizations(id),
      status text NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','failed','action_required','paid','cancelled')),
      attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3), revision integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS recurring_attempts (
      id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES recurring_jobs(id),
      payment_id uuid NOT NULL UNIQUE REFERENCES service_invoice_payments(id),
      outcome text NOT NULL CHECK(outcome IN ('paid','failed','action_required')),
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS stripe_saved_methods (
      authorization_id uuid PRIMARY KEY REFERENCES recurring_authorizations(id), customer_reference text UNIQUE,
      setup_reference text UNIQUE, method_reference text, setup_url text, ready boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE stripe_saved_methods ADD COLUMN IF NOT EXISTS setup_attempt integer NOT NULL DEFAULT 1;
    CREATE TABLE IF NOT EXISTS stripe_collection_operations (
      id uuid PRIMARY KEY, invoice_id uuid NOT NULL UNIQUE REFERENCES service_invoices(id),
      authorization_id uuid NOT NULL REFERENCES recurring_authorizations(id), payment_id uuid NOT NULL UNIQUE REFERENCES service_invoice_payments(id),
      status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','processing','action_required','unknown','failed','paid','cancelled')),
      lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS service_change_requests (
      id uuid PRIMARY KEY, contract_id uuid NOT NULL REFERENCES service_contracts(id),
      customer_id uuid NOT NULL REFERENCES customer_accounts(id), visit_id uuid REFERENCES service_visits(id),
      kind text NOT NULL CHECK(kind IN ('reschedule','cancel_visit','terminate')),
      requested_date date, requested_window text NOT NULL DEFAULT '', reason text NOT NULL,
      status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined','withdrawn')),
      revision integer NOT NULL DEFAULT 1, resolution text NOT NULL DEFAULT '', effective_date date,
      resolved_by uuid REFERENCES team_users(id), resolved_at timestamptz,
      idempotency_key text NOT NULL, request_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(customer_id,idempotency_key));
    CREATE INDEX IF NOT EXISTS service_changes_contract ON service_change_requests(contract_id,status);
    CREATE TABLE IF NOT EXISTS service_termination_plans (
      contract_id uuid PRIMARY KEY REFERENCES service_contracts(id), request_id uuid UNIQUE NOT NULL REFERENCES service_change_requests(id),
      effective_date date NOT NULL, resolution text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), executed_at timestamptz);
    CREATE TABLE IF NOT EXISTS service_closings (
      id uuid PRIMARY KEY, change_id uuid NOT NULL UNIQUE REFERENCES service_change_requests(id),
      contract_id uuid NOT NULL REFERENCES service_contracts(id),
      status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','issued','no_charge','cancelled')),
      revision integer NOT NULL DEFAULT 1, recovery_minor bigint NOT NULL DEFAULT 0 CHECK(recovery_minor>=0),
      charge_minor bigint NOT NULL DEFAULT 0 CHECK(charge_minor>=0), due_date date,
      reason text NOT NULL, evidence jsonb, evidence_hash text,
      invoice_id uuid UNIQUE REFERENCES service_invoices(id), issue_key uuid UNIQUE,
      actor_id uuid NOT NULL REFERENCES team_users(id), approved_by uuid REFERENCES team_users(id),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS service_closing_events (
      id uuid PRIMARY KEY, closing_id uuid NOT NULL REFERENCES service_closings(id), actor_id uuid NOT NULL REFERENCES team_users(id),
      action text NOT NULL, detail jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS service_closing_contract ON service_closings(contract_id,status);
    CREATE TABLE IF NOT EXISTS phase2_settings (
      key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS stay_units (
      id uuid PRIMARY KEY, name text NOT NULL, address text NOT NULL, timezone text NOT NULL,
      capacity integer NOT NULL CHECK(capacity>0), checkin_time text NOT NULL, checkout_time text NOT NULL,
      arrival_message text NOT NULL DEFAULT '', departure_message text NOT NULL DEFAULT '',
      active boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1, demo_key text UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS stay_reservations (
      id uuid PRIMARY KEY, unit_id uuid NOT NULL REFERENCES stay_units(id), unit_snapshot jsonb NOT NULL,
      provider text NOT NULL CHECK(provider IN ('demo','lodgify','airbnb')),
      external_reference text NOT NULL, source_revision integer NOT NULL,
      guest_name text NOT NULL, guest_email text NOT NULL, guests integer NOT NULL CHECK(guests>0),
      checkin_date date NOT NULL, checkout_date date NOT NULL CHECK(checkout_date>checkin_date),
      checkin_at timestamptz NOT NULL, checkout_at timestamptz NOT NULL CHECK(checkout_at>checkin_at),
      status text NOT NULL CHECK(status IN ('confirmed','cancelled','checked_in','checked_out')),
      payment_status text NOT NULL DEFAULT 'unverified', revision integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(provider,external_reference));
    CREATE INDEX IF NOT EXISTS stay_occupancy ON stay_reservations(unit_id,checkin_date,checkout_date,status);
    CREATE TABLE IF NOT EXISTS stay_event_inbox (
      id uuid PRIMARY KEY, provider text NOT NULL, external_event_id text NOT NULL,
      payload_hash text NOT NULL, payload jsonb NOT NULL, reservation_id uuid REFERENCES stay_reservations(id),
      status text NOT NULL CHECK(status IN ('applied','ignored','rejected')),
      result jsonb NOT NULL, authenticated_source text NOT NULL CHECK(authenticated_source IN ('admin_demo','verified_adapter')),
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(provider,external_event_id));
    CREATE TABLE IF NOT EXISTS stay_jobs (
      id uuid PRIMARY KEY, reservation_id uuid NOT NULL REFERENCES stay_reservations(id),
      reservation_revision integer NOT NULL, kind text NOT NULL CHECK(kind IN ('confirmation','arrival','departure','cancellation','rescheduled')),
      due_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','queued','cancelled','skipped')),
      mail_id uuid REFERENCES commercial_mail(id), processed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(reservation_id,reservation_revision,kind));
    CREATE INDEX IF NOT EXISTS stay_jobs_due ON stay_jobs(status,due_at);
    CREATE TABLE IF NOT EXISTS stay_activity (
      id uuid PRIMARY KEY, reservation_id uuid NOT NULL REFERENCES stay_reservations(id),
      action text NOT NULL, actor_id uuid REFERENCES team_users(id), detail jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS stay_reviews (
      id uuid PRIMARY KEY, event_id uuid NOT NULL UNIQUE REFERENCES stay_event_inbox(id),
      reservation_id uuid NOT NULL REFERENCES stay_reservations(id),
      reason text NOT NULL, original jsonb NOT NULL, original_hash text NOT NULL,
      target_unit_revision integer NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined')),
      revision integer NOT NULL DEFAULT 1, decision_key uuid UNIQUE, note text NOT NULL DEFAULT '',
      actor_id uuid REFERENCES team_users(id), result jsonb, created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz);
    CREATE TABLE IF NOT EXISTS channel_products (
      id uuid PRIMARY KEY, external_id text NOT NULL UNIQUE, slug text NOT NULL UNIQUE,
      name text NOT NULL, description text NOT NULL, category text NOT NULL, images jsonb NOT NULL DEFAULT '[]',
      published boolean NOT NULL DEFAULT false, archived boolean NOT NULL DEFAULT false,
      source_revision integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS channel_variants (
      id uuid PRIMARY KEY, product_id uuid NOT NULL REFERENCES channel_products(id), external_id text NOT NULL UNIQUE,
      sku text NOT NULL UNIQUE, name text NOT NULL, options jsonb NOT NULL DEFAULT '{}', price_minor bigint NOT NULL CHECK(price_minor>0),
      currency text NOT NULL CHECK(currency='CAD'), stock integer NOT NULL DEFAULT 0 CHECK(stock>=0),
      inventory_revision integer NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true);
    CREATE TABLE IF NOT EXISTS channel_events (
      id uuid PRIMARY KEY, external_event_id text NOT NULL UNIQUE, kind text NOT NULL CHECK(kind IN ('product','inventory','order')),
      payload_hash text NOT NULL, payload jsonb NOT NULL, status text NOT NULL, result jsonb NOT NULL,
      source text NOT NULL CHECK(source IN ('admin_demo','verified_adapter')), created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS channel_checkouts (
      id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customer_accounts(id),
      idempotency_key text NOT NULL, payload_hash text NOT NULL, snapshot jsonb NOT NULL,
      total_minor bigint NOT NULL CHECK(total_minor>0), currency text NOT NULL CHECK(currency='CAD'),
      status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','paid','cancelled','expired')),
      created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
      UNIQUE(customer_id,idempotency_key));
    CREATE TABLE IF NOT EXISTS channel_holds (
      checkout_id uuid NOT NULL REFERENCES channel_checkouts(id), variant_id uuid NOT NULL REFERENCES channel_variants(id),
      quantity integer NOT NULL CHECK(quantity>0), status text NOT NULL CHECK(status IN ('active','released','consumed')),
      PRIMARY KEY(checkout_id,variant_id));
    CREATE INDEX IF NOT EXISTS channel_active_holds ON channel_holds(variant_id,status);
    CREATE TABLE IF NOT EXISTS channel_orders (
      id uuid PRIMARY KEY, external_id text NOT NULL UNIQUE, source_revision integer NOT NULL,
      checkout_id uuid UNIQUE REFERENCES channel_checkouts(id), customer_email text NOT NULL,
      currency text NOT NULL CHECK(currency='CAD'), total_minor bigint NOT NULL, snapshot jsonb NOT NULL,
      status text NOT NULL CHECK(status IN ('paid','cancelled','refunded')),
      fulfillment text NOT NULL DEFAULT 'unfulfilled' CHECK(fulfillment IN ('unfulfilled','fulfilled')),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS channel_activity (
      id uuid PRIMARY KEY, resource text NOT NULL, action text NOT NULL, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE channel_products ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'demo' CHECK(provider IN ('demo','shopify'));
    CREATE TABLE IF NOT EXISTS provider_jobs (
      id uuid PRIMARY KEY, provider text NOT NULL, event_key text NOT NULL, kind text NOT NULL, resource text NOT NULL,
      payload_hash text NOT NULL, cursor text, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','done','failed','quarantined')),
      attempts integer NOT NULL DEFAULT 0, lease_token uuid, lease_until timestamptz, result jsonb,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(provider,event_key));
    CREATE TABLE IF NOT EXISTS worker_leases (name text PRIMARY KEY, owner uuid NOT NULL, expires_at timestamptz NOT NULL);
    ALTER TABLE stay_reservations ADD COLUMN IF NOT EXISTS verified_external boolean NOT NULL DEFAULT false;
    ALTER TABLE stay_reservations ADD COLUMN IF NOT EXISTS delivery_scope text NOT NULL DEFAULT 'preview' CHECK(delivery_scope IN ('preview','standard'));
    ALTER TABLE channel_products ADD COLUMN IF NOT EXISTS source_published boolean;
    ALTER TABLE channel_products ADD COLUMN IF NOT EXISTS local_hidden boolean NOT NULL DEFAULT false;
    CREATE TABLE IF NOT EXISTS worker_runs (
      id uuid PRIMARY KEY, status text NOT NULL CHECK(status IN ('running','completed','partial')),
      started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,steps jsonb NOT NULL DEFAULT '[]');
    CREATE TABLE IF NOT EXISTS provider_resources (
      provider text NOT NULL, kind text NOT NULL, resource text NOT NULL, revision integer NOT NULL,
      modified_at timestamptz NOT NULL, payload_hash text NOT NULL, result jsonb NOT NULL DEFAULT '{}',
      PRIMARY KEY(provider,kind,resource));
    CREATE TABLE IF NOT EXISTS shopify_carts (
      id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customer_accounts(id), request_key uuid NOT NULL,
      payload_hash text NOT NULL, status text NOT NULL DEFAULT 'creating' CHECK(status IN ('creating','ready','unknown')),
      sealed_result text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(customer_id,request_key));
    CREATE TABLE IF NOT EXISTS launch_checks (
      check_id text PRIMARY KEY, revision integer NOT NULL DEFAULT 0,
      state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','in_progress','blocked','ready_for_test','passed','failed')),
      owner_id uuid REFERENCES team_users(id), due_date date, note text NOT NULL DEFAULT '', evidence text NOT NULL DEFAULT '',
      fingerprint text, actor_id uuid REFERENCES team_users(id), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS launch_check_history (
      id uuid PRIMARY KEY, check_id text NOT NULL REFERENCES launch_checks(check_id), revision integer NOT NULL,
      actor_id uuid NOT NULL REFERENCES team_users(id), snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(check_id,revision));
    CREATE INDEX IF NOT EXISTS launch_history_check ON launch_check_history(check_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS service_catalogue (
      id text PRIMARY KEY,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),content jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS guest_buyers (
      id uuid PRIMARY KEY,token_hash text NOT NULL UNIQUE,expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS guest_order_links (
      kind text NOT NULL CHECK(kind IN ('channel','enquiry','shopify','contract','invoice')),resource_id uuid NOT NULL,
      owner_ref text NOT NULL,email text NOT NULL,token_hash text NOT NULL UNIQUE,secret_cipher text NOT NULL,
      expires_at timestamptz NOT NULL,PRIMARY KEY(kind,resource_id));
    CREATE TABLE IF NOT EXISTS guest_order_grants (
      token_hash text PRIMARY KEY,kind text NOT NULL,resource_id uuid NOT NULL,expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE channel_checkouts ALTER COLUMN customer_id DROP NOT NULL;
    ALTER TABLE channel_checkouts ADD COLUMN IF NOT EXISTS buyer_ref text;
    UPDATE channel_checkouts SET buyer_ref='customer:'||customer_id::text WHERE buyer_ref IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS channel_buyer_request ON channel_checkouts(buyer_ref,idempotency_key);
    ALTER TABLE client_service_requests ALTER COLUMN customer_id DROP NOT NULL;
    ALTER TABLE client_service_requests ADD COLUMN IF NOT EXISTS buyer_ref text;
    UPDATE client_service_requests SET buyer_ref='customer:'||customer_id::text WHERE buyer_ref IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS enquiry_buyer_request ON client_service_requests(buyer_ref,idempotency_key);
    ALTER TABLE shopify_carts ALTER COLUMN customer_id DROP NOT NULL;
    ALTER TABLE shopify_carts ADD COLUMN IF NOT EXISTS buyer_ref text;
    UPDATE shopify_carts SET buyer_ref='customer:'||customer_id::text WHERE buyer_ref IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS shopify_buyer_request ON shopify_carts(buyer_ref,request_key);
  `);});
  await platform.transaction(async tx=>{if(driver==='postgres')await tx.query('SELECT pg_advisory_xact_lock(73182002)');await tx.exec('CREATE TABLE IF NOT EXISTS demo_documents(collection text NOT NULL, id text NOT NULL, body jsonb NOT NULL, PRIMARY KEY(collection,id));');});
  return {commercial,platform,driver,store:documentStore(platform),close:()=>Promise.all([commercial.close(),platform.close()])};
  }catch(error){await Promise.allSettled([commercial.close(),platform.close()]);throw error;}
}

function documentStore(db){
  const match=(row,where)=>where.every(([field,op,value])=>{
    const a=row[field];return op==='=='?a===value:op==='in'?value.includes(a):op==='<='?a<=value:op==='array-contains'?Array.isArray(a)&&a.includes(value):false;
  });
  const operations=sql=>({
    get:async(c,id)=>(await sql.query('SELECT body FROM demo_documents WHERE collection=$1 AND id=$2',[c,id])).rows[0]?.body||null,
    put:async(c,id,value)=>{await sql.query('INSERT INTO demo_documents(collection,id,body) VALUES($1,$2,$3) ON CONFLICT(collection,id) DO UPDATE SET body=EXCLUDED.body',[c,id,JSON.stringify({...value,id})]);},
    create:async(c,id,value)=>{await sql.query('INSERT INTO demo_documents(collection,id,body) VALUES($1,$2,$3)',[c,id,JSON.stringify({...value,id})]);},
    remove:async(c,id)=>{await sql.query('DELETE FROM demo_documents WHERE collection=$1 AND id=$2',[c,id]);},
    list:async(c,{where=[],order=[],cursor,offset=0,limit=100}={})=>{
      let rows=(await sql.query('SELECT body FROM demo_documents WHERE collection=$1',[c])).rows.map(r=>r.body).filter(r=>match(r,where));
      const compare=(a,b)=>{for(const [field,direction]of order){const f=field==='__name__'?'id':field;const d=a[f]<b[f]?-1:a[f]>b[f]?1:0;if(d)return direction==='desc'?-d:d;}return 0;};
      if(order.length)rows.sort(compare);
      if(cursor){const anchor=Object.fromEntries(order.map(([f],i)=>[f==='__name__'?'id':f,cursor[i]]));rows=rows.filter(r=>compare(r,anchor)>0);}
      return rows.slice(offset,offset+limit);
    },
  });
  // Firestore-style buffered writes: callers need not await put/create. All writes
  // are committed only after the transaction callback succeeds.
  return {get:(...a)=>operations(db).get(...a),set:(...a)=>operations(db).put(...a),list:(...a)=>operations(db).list(...a),count:async(c,where=[])=> (await operations(db).list(c,{where,limit:Number.MAX_SAFE_INTEGER})).length,
    transaction:fn=>db.transaction(async sql=>{
      const ops=operations(sql),writes=new Map();const path=(c,id)=>c+'/'+id;
      const tx={get:async(c,id)=>{const w=writes.get(path(c,id));return w?w.type==='remove'?null:{...w.value,id}:ops.get(c,id);},
        list:ops.list,put:(c,id,value)=>writes.set(path(c,id),{type:'put',c,id,value}),create:(c,id,value)=>writes.set(path(c,id),{type:'create',c,id,value}),remove:(c,id)=>writes.set(path(c,id),{type:'remove',c,id})};
      const result=await fn(tx);for(const w of writes.values())await ops[w.type](w.c,w.id,w.value);return result;
    })};
}
