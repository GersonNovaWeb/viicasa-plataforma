CREATE TABLE shop_settings (
 currency text PRIMARY KEY CHECK(currency IN ('MXN','USD')),
 pickup_enabled boolean NOT NULL DEFAULT true,
 shipping_enabled boolean NOT NULL DEFAULT false,
 shipping_minor integer NOT NULL DEFAULT 0 CHECK(shipping_minor>=0),
 pickup_instructions text NOT NULL DEFAULT '',
 terms text NOT NULL DEFAULT ''
);
INSERT INTO shop_settings(currency) VALUES('MXN'),('USD');
