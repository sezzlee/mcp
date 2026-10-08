-- Sample schema for the sezzlee postgres-mcp documentation.
-- Creates the schema sezzlee_shop in the current database, dropping it first if it exists.
-- Run it with a role that may create a schema, for example: psql -v ON_ERROR_STOP=1 -f sezzlee-shop.sql

BEGIN;

DROP SCHEMA IF EXISTS sezzlee_shop CASCADE;

CREATE SCHEMA sezzlee_shop;

CREATE TABLE sezzlee_shop.customers (
  customer_id integer NOT NULL CONSTRAINT pk_customers PRIMARY KEY,
  name varchar(100) NOT NULL,
  email varchar(200) NOT NULL CONSTRAINT uq_customers_email UNIQUE,
  city varchar(60) NULL,
  created_at timestamp(0) NOT NULL
);

CREATE TABLE sezzlee_shop.products (
  product_id integer NOT NULL CONSTRAINT pk_products PRIMARY KEY,
  sku varchar(20) NOT NULL CONSTRAINT uq_products_sku UNIQUE,
  name varchar(100) NOT NULL,
  unit_price numeric(10, 2) NOT NULL
);

CREATE TABLE sezzlee_shop.orders (
  order_id integer NOT NULL CONSTRAINT pk_orders PRIMARY KEY,
  customer_id integer NOT NULL CONSTRAINT fk_orders_customer REFERENCES sezzlee_shop.customers (customer_id),
  ordered_on date NOT NULL,
  status varchar(12) NOT NULL,
  shipped_at timestamp(0) NULL
);

CREATE TABLE sezzlee_shop.order_lines (
  order_id integer NOT NULL CONSTRAINT fk_lines_order REFERENCES sezzlee_shop.orders (order_id),
  line_no smallint NOT NULL,
  product_id integer NOT NULL CONSTRAINT fk_lines_product REFERENCES sezzlee_shop.products (product_id),
  quantity integer NOT NULL,
  unit_price numeric(10, 2) NOT NULL,
  CONSTRAINT pk_order_lines PRIMARY KEY (order_id, line_no)
);

CREATE TABLE sezzlee_shop.ledger (
  entry_id bigint NOT NULL CONSTRAINT pk_ledger PRIMARY KEY,
  booked_at timestamptz(0) NOT NULL,
  amount numeric(38, 4) NOT NULL,
  note varchar(200) NULL
);

CREATE VIEW sezzlee_shop.order_totals AS
SELECT o.order_id, o.customer_id, o.status, SUM(l.quantity * l.unit_price) AS total
FROM sezzlee_shop.orders AS o
JOIN sezzlee_shop.order_lines AS l ON l.order_id = o.order_id
GROUP BY o.order_id, o.customer_id, o.status;

COMMENT ON TABLE sezzlee_shop.customers IS 'People and companies that place orders.';
COMMENT ON COLUMN sezzlee_shop.customers.city IS 'City the customer is invoiced in.';
COMMENT ON TABLE sezzlee_shop.products IS 'Items for sale, with their current list price.';
COMMENT ON TABLE sezzlee_shop.orders IS 'One row per purchase; status is pending, shipped or cancelled.';
COMMENT ON COLUMN sezzlee_shop.orders.shipped_at IS 'When the parcel left the warehouse; empty until shipped.';
COMMENT ON TABLE sezzlee_shop.order_lines IS 'The products and quantities of each order, at the price charged.';
COMMENT ON VIEW sezzlee_shop.order_totals IS 'Revenue per order, summed from its lines.';
COMMENT ON TABLE sezzlee_shop.ledger IS 'Accounting entries with exact amounts.';

INSERT INTO sezzlee_shop.customers (customer_id, name, email, city, created_at) VALUES
  (1, 'Ada Yılmaz', 'ada@example.com', 'İstanbul', '2025-03-02 09:15:00'),
  (2, 'Emre Kaya', 'emre@example.com', 'Ankara', '2025-04-18 14:02:00'),
  (3, 'Lena Müller', 'lena@example.com', 'München', '2025-05-07 11:40:00'),
  (4, 'Omar Haddad', 'omar@example.com', 'İzmir', '2025-06-21 16:25:00'),
  (5, 'Zoë Martin', 'zoe@example.com', NULL, '2025-09-30 08:05:00');

INSERT INTO sezzlee_shop.products (product_id, sku, name, unit_price) VALUES
  (10, 'DESK-OAK', 'Oak desk', 250.00),
  (11, 'CHAIR-ERG', 'Ergonomic chair', 85.00),
  (12, 'LAMP-LED', 'LED desk lamp', 30.00),
  (13, 'SHELF-WAL', 'Wall shelf', 45.50);

INSERT INTO sezzlee_shop.orders (order_id, customer_id, ordered_on, status, shipped_at) VALUES
  (1001, 1, '2026-01-05', 'shipped', '2026-01-07 10:00:00'),
  (1002, 2, '2026-01-06', 'shipped', '2026-01-08 15:30:00'),
  (1003, 3, '2026-01-08', 'pending', NULL),
  (1004, 1, '2026-01-09', 'shipped', '2026-01-12 09:45:00'),
  (1005, 4, '2026-01-12', 'cancelled', NULL),
  (1006, 2, '2026-01-13', 'shipped', '2026-01-14 13:20:00'),
  (1007, 5, '2026-01-15', 'pending', NULL);

INSERT INTO sezzlee_shop.order_lines (order_id, line_no, product_id, quantity, unit_price) VALUES
  (1001, 1, 10, 2, 250.00),
  (1001, 2, 12, 2, 30.00),
  (1002, 1, 11, 4, 85.00),
  (1003, 1, 13, 6, 45.50),
  (1004, 1, 11, 1, 85.00),
  (1004, 2, 12, 3, 30.00),
  (1005, 1, 10, 1, 250.00),
  (1006, 1, 12, 10, 28.00),
  (1007, 1, 11, 2, 85.00),
  (1007, 2, 13, 1, 45.50);

INSERT INTO sezzlee_shop.ledger (entry_id, booked_at, amount, note) VALUES
  (9007199254740993, '2026-01-31 23:30:00+03', 123456789012345678.1234, 'Year-end revaluation'),
  (9007199254740994, '2026-02-01 00:10:00+03', 12.5000, 'Bank fee');

COMMIT;
