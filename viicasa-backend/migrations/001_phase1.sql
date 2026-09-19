CREATE TABLE users (
 id uuid PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL,
 password_hash text NOT NULL, role text NOT NULL CHECK(role IN ('admin','catalog','support','viewer')),
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL
);
CREATE TABLE guests (
 id uuid PRIMARY KEY, token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE properties (
 id uuid PRIMARY KEY, slug text NOT NULL UNIQUE, name text NOT NULL, description text NOT NULL,
 location text NOT NULL, timezone text NOT NULL, capacity integer NOT NULL CHECK(capacity>0),
 bedrooms integer NOT NULL CHECK(bedrooms>=0), bathrooms integer NOT NULL CHECK(bathrooms>=0),
 nightly_minor integer NOT NULL CHECK(nightly_minor>0), cleaning_minor integer NOT NULL CHECK(cleaning_minor>=0),
 deposit_percent integer NOT NULL CHECK(deposit_percent BETWEEN 1 AND 100),
 min_nights integer NOT NULL CHECK(min_nights>0), currency text NOT NULL CHECK(currency IN ('MXN','USD')),
 images jsonb NOT NULL DEFAULT '[]', amenities jsonb NOT NULL DEFAULT '[]',
 policies text NOT NULL, published boolean NOT NULL DEFAULT false, archived boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE calendar_blocks (
 id uuid PRIMARY KEY, property_id uuid NOT NULL REFERENCES properties(id),
 check_in date NOT NULL, check_out date NOT NULL, reason text NOT NULL,
 CHECK(check_out>check_in)
);
CREATE TABLE products (
 id uuid PRIMARY KEY, slug text NOT NULL UNIQUE, name text NOT NULL, description text NOT NULL,
 category text NOT NULL, images jsonb NOT NULL DEFAULT '[]', published boolean NOT NULL DEFAULT false,
 archived boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE variants (
 id uuid PRIMARY KEY, product_id uuid NOT NULL REFERENCES products(id), sku text NOT NULL UNIQUE,
 name text NOT NULL, price_minor integer NOT NULL CHECK(price_minor>0), currency text NOT NULL CHECK(currency IN ('MXN','USD')),
 stock integer NOT NULL CHECK(stock>=0), active boolean NOT NULL DEFAULT true
);
CREATE TABLE cart_items (
 guest_id uuid NOT NULL REFERENCES guests(id), variant_id uuid NOT NULL REFERENCES variants(id),
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 99), PRIMARY KEY(guest_id,variant_id)
);
CREATE TABLE checkouts (
 id uuid PRIMARY KEY, guest_id uuid NOT NULL REFERENCES guests(id), kind text NOT NULL CHECK(kind IN ('order','booking')),
 idempotency_key text NOT NULL, request_hash text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','cancelled','expired','payment_review')),
 customer_name text NOT NULL, customer_email text NOT NULL, customer_phone text NOT NULL,
 currency text NOT NULL CHECK(currency IN ('MXN','USD')), total_minor integer NOT NULL CHECK(total_minor>0),
 due_minor integer NOT NULL CHECK(due_minor>0 AND due_minor<=total_minor),
 detail jsonb NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(guest_id, idempotency_key)
);
CREATE TABLE bookings (
 checkout_id uuid PRIMARY KEY REFERENCES checkouts(id), property_id uuid NOT NULL REFERENCES properties(id),
 check_in date NOT NULL, check_out date NOT NULL, guests integer NOT NULL CHECK(guests>0), CHECK(check_out>check_in)
);
CREATE INDEX bookings_dates ON bookings(property_id,check_in,check_out);
CREATE INDEX checkouts_pending ON checkouts(status,expires_at);
CREATE TABLE order_items (
 checkout_id uuid NOT NULL REFERENCES checkouts(id), variant_id uuid NOT NULL REFERENCES variants(id),
 quantity integer NOT NULL CHECK(quantity>0), unit_minor integer NOT NULL CHECK(unit_minor>0),
 name text NOT NULL, sku text NOT NULL, PRIMARY KEY(checkout_id,variant_id)
);
CREATE TABLE stock_movements (
 id uuid PRIMARY KEY, variant_id uuid NOT NULL REFERENCES variants(id), delta integer NOT NULL,
 reason text NOT NULL, checkout_id uuid REFERENCES checkouts(id), actor_id uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payments (
 id uuid PRIMARY KEY, checkout_id uuid NOT NULL UNIQUE REFERENCES checkouts(id), provider text NOT NULL,
 reference text UNIQUE, checkout_url text, status text NOT NULL CHECK(status IN ('creating','open','failed','paid','expired')),
 amount_minor integer NOT NULL CHECK(amount_minor>0), currency text NOT NULL, expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payment_events (
 provider text NOT NULL, event_id text NOT NULL, payment_id uuid NOT NULL REFERENCES payments(id),
 outcome text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(provider,event_id)
);
CREATE TABLE inquiries (
 id uuid PRIMARY KEY, property_id uuid REFERENCES properties(id), name text NOT NULL, email text NOT NULL,
 phone text NOT NULL, message text NOT NULL, status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','attended','archived')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mail_outbox (
 id uuid PRIMARY KEY, dedupe_key text NOT NULL UNIQUE, recipient text NOT NULL, subject text NOT NULL, body text NOT NULL,
 attempts integer NOT NULL DEFAULT 0, next_attempt timestamptz NOT NULL DEFAULT now(), locked_until timestamptz,
 sent_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audit_log (
 id uuid PRIMARY KEY, actor_id uuid REFERENCES users(id), action text NOT NULL, resource_id text,
 detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE media (
 id uuid PRIMARY KEY, filename text NOT NULL UNIQUE, mime text NOT NULL, bytes integer NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
