import type { Knex } from 'knex';

/**
 * Initial RentOLedger schema.
 *
 * Design notes
 * - Every business table carries `account_id` (the owner's workspace) and
 *   child tables reference parents through composite (id, account_id) foreign
 *   keys, so rows can never point at another account's data.
 * - Balances are never stored: they are derived from rent_charges,
 *   payments and payment_allocations.
 * - Money is NUMERIC(14,2); business dates are DATE; audit timestamps are TIMESTAMPTZ.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    -- ------------------------------------------------------------------
    -- Identity & access
    -- ------------------------------------------------------------------
    CREATE TABLE users (
      id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      phone                   varchar(16) NOT NULL,
      name                    varchar(120),
      email                   varchar(254),
      late_rent_notifications boolean NOT NULL DEFAULT true,
      last_login_at           timestamptz,
      created_at              timestamptz NOT NULL DEFAULT now(),
      updated_at              timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT users_phone_key UNIQUE (phone),
      CONSTRAINT users_phone_format CHECK (phone ~ '^\\+[1-9][0-9]{6,14}$')
    );

    CREATE TABLE accounts (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name                 varchar(120) NOT NULL CHECK (btrim(name) <> ''),
      gst_enabled          boolean NOT NULL DEFAULT true,
      gst_rate             numeric(5,2) NOT NULL DEFAULT 18.00 CHECK (gst_rate >= 0 AND gst_rate <= 100),
      currency             char(3) NOT NULL DEFAULT 'INR',
      timezone             varchar(64) NOT NULL DEFAULT 'Asia/Kolkata',
      reminder_days_before smallint NOT NULL DEFAULT 3 CHECK (reminder_days_before BETWEEN 0 AND 30),
      payee_name           varchar(120),
      upi_id               varchar(100),
      bank_account_name    varchar(120),
      bank_account_number  varchar(34),
      bank_ifsc            varchar(11),
      bank_name            varchar(120),
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE account_members (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role        varchar(16) NOT NULL CHECK (role IN ('owner', 'partner')),
      invited_by  uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT account_members_user_key UNIQUE (user_id)
    );
    CREATE UNIQUE INDEX account_members_one_owner ON account_members (account_id) WHERE role = 'owner';
    CREATE INDEX account_members_account_idx ON account_members (account_id);

    CREATE TABLE otp_codes (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      phone        varchar(16) NOT NULL,
      code_hash    varchar(128) NOT NULL,
      expires_at   timestamptz NOT NULL,
      attempts     smallint NOT NULL DEFAULT 0,
      consumed_at  timestamptz,
      ip           varchar(64),
      created_at   timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX otp_codes_phone_created_idx ON otp_codes (phone, created_at DESC);

    CREATE TABLE refresh_tokens (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash   varchar(128) NOT NULL,
      expires_at   timestamptz NOT NULL,
      revoked_at   timestamptz,
      replaced_by  uuid,
      user_agent   varchar(255),
      ip           varchar(64),
      created_at   timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT refresh_tokens_hash_key UNIQUE (token_hash)
    );
    CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

    -- ------------------------------------------------------------------
    -- Portfolio
    -- ------------------------------------------------------------------
    CREATE TABLE properties (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name          varchar(120) NOT NULL CHECK (btrim(name) <> ''),
      type          varchar(20) NOT NULL CHECK (type IN ('building', 'complex', 'house', 'shop', 'office', 'warehouse', 'land', 'other')),
      address_line  varchar(255),
      city          varchar(100),
      state         varchar(100),
      pincode       varchar(10),
      notes         text,
      archived_at   timestamptz,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT properties_id_account_key UNIQUE (id, account_id)
    );
    CREATE UNIQUE INDEX properties_account_name_key ON properties (account_id, lower(name)) WHERE archived_at IS NULL;
    CREATE INDEX properties_account_idx ON properties (account_id, created_at DESC);

    CREATE TABLE units (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      property_id   uuid NOT NULL,
      name          varchar(120) NOT NULL CHECK (btrim(name) <> ''),
      type          varchar(20) NOT NULL CHECK (type IN ('shop', 'office', 'flat', 'house', 'room', 'warehouse', 'floor', 'land', 'other')),
      floor         varchar(20),
      area_sqft     numeric(10,2) CHECK (area_sqft IS NULL OR area_sqft > 0),
      default_rent  numeric(14,2) CHECK (default_rent IS NULL OR default_rent >= 0),
      notes         text,
      archived_at   timestamptz,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT units_id_account_key UNIQUE (id, account_id),
      CONSTRAINT units_property_fk FOREIGN KEY (property_id, account_id) REFERENCES properties (id, account_id)
    );
    CREATE UNIQUE INDEX units_property_name_key ON units (property_id, lower(name)) WHERE archived_at IS NULL;
    CREATE INDEX units_account_idx ON units (account_id);
    CREATE INDEX units_property_idx ON units (property_id);

    CREATE TABLE tenants (
      id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id               uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name                     varchar(120) NOT NULL CHECK (btrim(name) <> ''),
      phone                    varchar(16) NOT NULL CHECK (phone ~ '^\\+[1-9][0-9]{6,14}$'),
      email                    varchar(254),
      business_name            varchar(160),
      gstin                    varchar(15),
      id_proof_type            varchar(30),
      id_proof_number          varchar(40),
      address                  text,
      emergency_contact_name   varchar(120),
      emergency_contact_phone  varchar(16),
      notes                    text,
      portal_enabled           boolean NOT NULL DEFAULT true,
      archived_at              timestamptz,
      created_at               timestamptz NOT NULL DEFAULT now(),
      updated_at               timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT tenants_id_account_key UNIQUE (id, account_id)
    );
    CREATE UNIQUE INDEX tenants_account_phone_key ON tenants (account_id, phone) WHERE archived_at IS NULL;
    CREATE INDEX tenants_phone_idx ON tenants (phone);
    CREATE INDEX tenants_account_name_idx ON tenants (account_id, lower(name));

    -- ------------------------------------------------------------------
    -- Leasing
    -- ------------------------------------------------------------------
    CREATE TABLE agreements (
      id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id                  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      unit_id                     uuid NOT NULL,
      tenant_id                   uuid NOT NULL,
      status                      varchar(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
      start_date                  date NOT NULL,
      end_date                    date,
      billing_start_date          date NOT NULL,
      rent_amount                 numeric(14,2) NOT NULL CHECK (rent_amount >= 0),
      billing_cycle               varchar(16) NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly', 'quarterly', 'half_yearly', 'yearly')),
      due_day                     smallint NOT NULL DEFAULT 1 CHECK (due_day BETWEEN 1 AND 31),
      gst_applicable              boolean NOT NULL DEFAULT false,
      gst_rate                    numeric(5,2) NOT NULL DEFAULT 0 CHECK (gst_rate >= 0 AND gst_rate <= 100),
      security_deposit            numeric(14,2) NOT NULL DEFAULT 0 CHECK (security_deposit >= 0),
      escalation_percent          numeric(5,2) NOT NULL DEFAULT 0 CHECK (escalation_percent >= 0 AND escalation_percent <= 100),
      escalation_interval_months  smallint NOT NULL DEFAULT 12 CHECK (escalation_interval_months BETWEEN 1 AND 120),
      -- Escalation steps are counted from this date (defaults to start_date);
      -- reset when the rent is revised manually so increases never compound twice.
      escalation_base_date        date,
      prorate_partial_periods     boolean NOT NULL DEFAULT true,
      notice_period_days          smallint CHECK (notice_period_days IS NULL OR notice_period_days BETWEEN 0 AND 365),
      lock_in_months              smallint CHECK (lock_in_months IS NULL OR lock_in_months BETWEEN 0 AND 240),
      ended_on                    date,
      end_reason                  text,
      notes                       text,
      created_by                  uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at                  timestamptz NOT NULL DEFAULT now(),
      updated_at                  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT agreements_id_account_key UNIQUE (id, account_id),
      CONSTRAINT agreements_unit_fk FOREIGN KEY (unit_id, account_id) REFERENCES units (id, account_id),
      CONSTRAINT agreements_tenant_fk FOREIGN KEY (tenant_id, account_id) REFERENCES tenants (id, account_id),
      CONSTRAINT agreements_end_after_start CHECK (end_date IS NULL OR end_date >= start_date),
      CONSTRAINT agreements_billing_after_start CHECK (billing_start_date >= start_date),
      CONSTRAINT agreements_ended_consistency CHECK ((status = 'ended') = (ended_on IS NOT NULL)),
      CONSTRAINT agreements_ended_after_start CHECK (ended_on IS NULL OR ended_on >= start_date)
    );
    CREATE UNIQUE INDEX agreements_one_active_per_unit ON agreements (unit_id) WHERE status = 'active';
    CREATE INDEX agreements_account_status_idx ON agreements (account_id, status);
    CREATE INDEX agreements_tenant_idx ON agreements (tenant_id);
    CREATE INDEX agreements_unit_idx ON agreements (unit_id);

    -- Rent entries (the "ledger"). One row per billing period per agreement,
    -- plus any one-off charges (opening balance, maintenance, utilities...).
    CREATE TABLE rent_charges (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      agreement_id  uuid NOT NULL,
      tenant_id     uuid NOT NULL,
      unit_id       uuid NOT NULL,
      kind          varchar(20) NOT NULL DEFAULT 'rent' CHECK (kind IN ('rent', 'opening_balance', 'maintenance', 'utility', 'late_fee', 'other')),
      description   varchar(255),
      period_start  date NOT NULL,
      period_end    date NOT NULL,
      due_date      date NOT NULL,
      base_amount   numeric(14,2) NOT NULL CHECK (base_amount >= 0),
      gst_rate      numeric(5,2) NOT NULL DEFAULT 0 CHECK (gst_rate >= 0 AND gst_rate <= 100),
      gst_amount    numeric(14,2) NOT NULL DEFAULT 0 CHECK (gst_amount >= 0),
      total_amount  numeric(14,2) GENERATED ALWAYS AS (base_amount + gst_amount) STORED,
      voided_at     timestamptz,
      void_reason   text,
      created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT rent_charges_id_account_key UNIQUE (id, account_id),
      CONSTRAINT rent_charges_agreement_fk FOREIGN KEY (agreement_id, account_id) REFERENCES agreements (id, account_id) ON DELETE CASCADE,
      CONSTRAINT rent_charges_tenant_fk FOREIGN KEY (tenant_id, account_id) REFERENCES tenants (id, account_id),
      CONSTRAINT rent_charges_unit_fk FOREIGN KEY (unit_id, account_id) REFERENCES units (id, account_id),
      CONSTRAINT rent_charges_period_check CHECK (period_end >= period_start)
    );
    -- A billing period is generated at most once per agreement (voided rows included,
    -- so a cancelled period is never silently re-created).
    CREATE UNIQUE INDEX rent_charges_rent_period_key ON rent_charges (agreement_id, period_start) WHERE kind = 'rent';
    CREATE INDEX rent_charges_account_period_idx ON rent_charges (account_id, period_start);
    CREATE INDEX rent_charges_account_due_idx ON rent_charges (account_id, due_date);
    CREATE INDEX rent_charges_tenant_idx ON rent_charges (tenant_id, due_date);
    CREATE INDEX rent_charges_unit_idx ON rent_charges (unit_id);

    -- ------------------------------------------------------------------
    -- Money in
    -- ------------------------------------------------------------------
    CREATE TABLE payments (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      tenant_id         uuid NOT NULL,
      agreement_id      uuid REFERENCES agreements(id) ON DELETE SET NULL,
      unit_id           uuid REFERENCES units(id) ON DELETE SET NULL,
      target_charge_id  uuid REFERENCES rent_charges(id) ON DELETE SET NULL,
      amount            numeric(14,2) NOT NULL CHECK (amount > 0),
      paid_on           date NOT NULL,
      method            varchar(20) NOT NULL CHECK (method IN ('cash', 'upi', 'bank_transfer', 'cheque', 'card', 'deposit', 'other')),
      reference         varchar(100),
      notes             text,
      status            varchar(16) NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending', 'confirmed', 'rejected', 'void')),
      source            varchar(16) NOT NULL DEFAULT 'owner' CHECK (source IN ('owner', 'tenant', 'system')),
      recorded_by       uuid REFERENCES users(id) ON DELETE SET NULL,
      confirmed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
      confirmed_at      timestamptz,
      rejected_reason   text,
      voided_at         timestamptz,
      void_reason       text,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT payments_id_account_key UNIQUE (id, account_id),
      CONSTRAINT payments_tenant_fk FOREIGN KEY (tenant_id, account_id) REFERENCES tenants (id, account_id)
    );
    CREATE INDEX payments_account_paid_on_idx ON payments (account_id, paid_on DESC);
    CREATE INDEX payments_tenant_idx ON payments (tenant_id, paid_on);
    CREATE INDEX payments_account_status_idx ON payments (account_id, status);
    CREATE INDEX payments_target_charge_idx ON payments (target_charge_id) WHERE target_charge_id IS NOT NULL;

    -- How each confirmed payment settles specific charges. Supports partial
    -- payments, several payments per period and advance (unallocated) credit.
    CREATE TABLE payment_allocations (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      payment_id  uuid NOT NULL,
      charge_id   uuid NOT NULL,
      amount      numeric(14,2) NOT NULL CHECK (amount > 0),
      created_at  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT payment_allocations_payment_fk FOREIGN KEY (payment_id, account_id) REFERENCES payments (id, account_id) ON DELETE CASCADE,
      CONSTRAINT payment_allocations_charge_fk FOREIGN KEY (charge_id, account_id) REFERENCES rent_charges (id, account_id) ON DELETE CASCADE,
      CONSTRAINT payment_allocations_unique UNIQUE (payment_id, charge_id)
    );
    CREATE INDEX payment_allocations_charge_idx ON payment_allocations (charge_id);
    CREATE INDEX payment_allocations_account_idx ON payment_allocations (account_id);

    CREATE TABLE deposit_transactions (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      agreement_id  uuid NOT NULL,
      tenant_id     uuid NOT NULL,
      type          varchar(16) NOT NULL CHECK (type IN ('received', 'refunded', 'deducted', 'applied')),
      amount        numeric(14,2) NOT NULL CHECK (amount > 0),
      txn_date      date NOT NULL,
      method        varchar(20) CHECK (method IS NULL OR method IN ('cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other')),
      reference     varchar(100),
      notes         text,
      payment_id    uuid REFERENCES payments(id) ON DELETE SET NULL,
      recorded_by   uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at    timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT deposit_txn_agreement_fk FOREIGN KEY (agreement_id, account_id) REFERENCES agreements (id, account_id) ON DELETE CASCADE,
      CONSTRAINT deposit_txn_tenant_fk FOREIGN KEY (tenant_id, account_id) REFERENCES tenants (id, account_id)
    );
    CREATE INDEX deposit_txn_agreement_idx ON deposit_transactions (agreement_id, txn_date);
    CREATE INDEX deposit_txn_account_idx ON deposit_transactions (account_id, txn_date);

    -- ------------------------------------------------------------------
    -- Money out
    -- ------------------------------------------------------------------
    CREATE TABLE expenses (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      property_id   uuid REFERENCES properties(id) ON DELETE SET NULL,
      unit_id       uuid REFERENCES units(id) ON DELETE SET NULL,
      category      varchar(30) NOT NULL CHECK (category IN ('maintenance', 'repairs', 'property_tax', 'utilities', 'insurance', 'salary', 'society', 'legal', 'commission', 'cleaning', 'security', 'loan_interest', 'other')),
      amount        numeric(14,2) NOT NULL CHECK (amount > 0),
      expense_date  date NOT NULL,
      payee         varchar(160),
      method        varchar(20) CHECK (method IS NULL OR method IN ('cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other')),
      reference     varchar(100),
      notes         text,
      created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX expenses_account_date_idx ON expenses (account_id, expense_date DESC);
    CREATE INDEX expenses_property_idx ON expenses (property_id);

    -- ------------------------------------------------------------------
    -- Notifications & audit
    -- ------------------------------------------------------------------
    CREATE TABLE notifications (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id   uuid REFERENCES accounts(id) ON DELETE CASCADE,
      audience     varchar(10) NOT NULL DEFAULT 'owner' CHECK (audience IN ('owner', 'tenant')),
      type         varchar(40) NOT NULL,
      title        varchar(200) NOT NULL,
      body         text,
      entity_type  varchar(40),
      entity_id    uuid,
      data         jsonb,
      dedupe_key   varchar(200),
      read_at      timestamptz,
      created_at   timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX notifications_user_dedupe_key ON notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX notifications_user_created_idx ON notifications (user_id, audience, created_at DESC);
    CREATE INDEX notifications_user_unread_idx ON notifications (user_id, audience) WHERE read_at IS NULL;

    CREATE TABLE activity_logs (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
      action       varchar(60) NOT NULL,
      entity_type  varchar(40),
      entity_id    uuid,
      summary      text NOT NULL,
      metadata     jsonb,
      created_at   timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX activity_logs_account_created_idx ON activity_logs (account_id, created_at DESC);
    CREATE INDEX activity_logs_entity_idx ON activity_logs (entity_type, entity_id);

    CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER accounts_updated_at BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER properties_updated_at BEFORE UPDATE ON properties FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER units_updated_at BEFORE UPDATE ON units FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER tenants_updated_at BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER agreements_updated_at BEFORE UPDATE ON agreements FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER rent_charges_updated_at BEFORE UPDATE ON rent_charges FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER payments_updated_at BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER expenses_updated_at BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TABLE IF EXISTS activity_logs;
    DROP TABLE IF EXISTS notifications;
    DROP TABLE IF EXISTS expenses;
    DROP TABLE IF EXISTS deposit_transactions;
    DROP TABLE IF EXISTS payment_allocations;
    DROP TABLE IF EXISTS payments;
    DROP TABLE IF EXISTS rent_charges;
    DROP TABLE IF EXISTS agreements;
    DROP TABLE IF EXISTS tenants;
    DROP TABLE IF EXISTS units;
    DROP TABLE IF EXISTS properties;
    DROP TABLE IF EXISTS refresh_tokens;
    DROP TABLE IF EXISTS otp_codes;
    DROP TABLE IF EXISTS account_members;
    DROP TABLE IF EXISTS accounts;
    DROP TABLE IF EXISTS users;
    DROP FUNCTION IF EXISTS set_updated_at();
  `);
}
