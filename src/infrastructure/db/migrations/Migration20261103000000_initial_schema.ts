import { Migration } from "@mikro-orm/migrations";

export class Migration20261103000000_initial_schema extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE wallets (
        id         uuid          PRIMARY KEY,
        player_id  uuid          NOT NULL,
        currency   char(3)       NOT NULL,
        balance    numeric(20,2) NOT NULL,
        version    integer       NOT NULL,
        created_at timestamptz   NOT NULL,
        updated_at timestamptz   NOT NULL,
        CONSTRAINT wallets_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT wallets_version_positive CHECK (version >= 1),
        CONSTRAINT wallets_player_currency_unique UNIQUE (player_id, currency),
        CONSTRAINT wallets_id_player_currency_unique UNIQUE (id, player_id, currency)
      )
    `);

    // OPENING is internal and has no real provider, round or game. Those columns
    // stay NOT NULL and hold sentinels, because NULLs would escape
    // UNIQUE (provider_id, external_transaction_id). Convention for OPENING rows:
    //   provider_id = 'internal', external_transaction_id = 'opening:<walletId>',
    //   idempotency_key = 'internal:opening:<walletId>',
    //   round_id = 'opening', game_id = 'opening'.
    //
    // wallet_player_currency_fk means a divergent currency or an unknown wallet
    // cannot be stored, not even as REJECTED. By decision, those are refused
    // before persisting (422 with a failureCode).
    //
    // reference_fk only applies once reference_transaction_id is set. A reversal
    // rejected for pointing at another wallet or round stays auditable by keeping
    // reference_external_transaction_id and leaving reference_transaction_id NULL.
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid          PRIMARY KEY,
        provider_id                       text          NOT NULL,
        external_transaction_id           text          NOT NULL,
        idempotency_key                   text          NOT NULL,
        payload_hash                      text          NOT NULL,
        wallet_id                         uuid          NOT NULL,
        player_id                         uuid          NOT NULL,
        round_id                          text          NOT NULL,
        game_id                           text          NOT NULL,
        kind                              text          NOT NULL,
        amount                            numeric(20,2) NOT NULL,
        currency                          char(3)       NOT NULL,
        status                            text          NOT NULL,
        reference_external_transaction_id text,
        reference_transaction_id          uuid,
        failure_code                      text,
        balance_after                     numeric(20,2),
        attempts                         integer       NOT NULL DEFAULT 0,
        next_attempt_at                   timestamptz,
        created_at                        timestamptz   NOT NULL,
        processed_at                      timestamptz,
        CONSTRAINT wager_transactions_idempotency_key_unique UNIQUE (idempotency_key),
        CONSTRAINT wager_transactions_provider_external_unique UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_transactions_id_wallet_unique UNIQUE (id, wallet_id),
        CONSTRAINT wager_transactions_id_wallet_round_unique UNIQUE (id, wallet_id, round_id),
        CONSTRAINT wager_transactions_wallet_player_currency_fk
          FOREIGN KEY (wallet_id, player_id, currency) REFERENCES wallets (id, player_id, currency),
        CONSTRAINT wager_transactions_reference_fk
          FOREIGN KEY (reference_transaction_id, wallet_id, round_id)
          REFERENCES wager_transactions (id, wallet_id, round_id),
        CONSTRAINT wager_transactions_kind_valid
          CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT wager_transactions_status_valid
          CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        CONSTRAINT wager_transactions_amount_valid CHECK (amount > 0 OR (kind = 'LOSS' AND amount >= 0)),
        CONSTRAINT wager_transactions_balance_after_required
          CHECK (status NOT IN ('PROCESSED', 'REJECTED') OR balance_after IS NOT NULL),
        CONSTRAINT wager_transactions_pending_reference_scheduled
          CHECK (status <> 'PENDING_REFERENCE' OR next_attempt_at IS NOT NULL),
        CONSTRAINT wager_transactions_reversal_requires_reference
          CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_transactions_failure_code_iff_failed
          CHECK ((status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT wager_transactions_processed_at_iff_processed
          CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
        -- Without this, a processed reversal with a NULL reference would escape
        -- wager_transactions_one_reversal_per_reference, since NULLs are distinct.
        CONSTRAINT wager_transactions_processed_reversal_resolved
          CHECK (NOT (kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED') OR reference_transaction_id IS NOT NULL),
        CONSTRAINT wager_transactions_internal_provider_iff_opening
          CHECK ((kind = 'OPENING') = (provider_id = 'internal'))
      )
    `);
    this.addSql(`
      CREATE UNIQUE INDEX wager_transactions_one_reversal_per_reference
        ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED'
    `);
    this.addSql(`
      CREATE UNIQUE INDEX wager_transactions_one_opening_per_wallet
        ON wager_transactions (wallet_id)
        WHERE kind = 'OPENING'
    `);
    this.addSql(`
      CREATE INDEX wager_transactions_pending_reference_due
        ON wager_transactions (next_attempt_at)
        WHERE status = 'PENDING_REFERENCE'
    `);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id             uuid          PRIMARY KEY,
        wallet_id      uuid          NOT NULL,
        transaction_id uuid          NOT NULL,
        direction      text          NOT NULL,
        amount         numeric(20,2) NOT NULL,
        balance_before numeric(20,2) NOT NULL,
        balance_after  numeric(20,2) NOT NULL,
        created_at     timestamptz   NOT NULL,
        CONSTRAINT wallet_ledger_entries_wallet_fk FOREIGN KEY (wallet_id) REFERENCES wallets (id),
        CONSTRAINT wallet_ledger_entries_transaction_wallet_fk
          FOREIGN KEY (transaction_id, wallet_id) REFERENCES wager_transactions (id, wallet_id),
        CONSTRAINT wallet_ledger_entries_transaction_wallet_unique UNIQUE (transaction_id, wallet_id),
        CONSTRAINT wallet_ledger_entries_direction_valid CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT wallet_ledger_entries_amount_positive CHECK (amount > 0),
        CONSTRAINT wallet_ledger_entries_balance_before_non_negative CHECK (balance_before >= 0),
        CONSTRAINT wallet_ledger_entries_balance_after_non_negative CHECK (balance_after >= 0),
        CONSTRAINT wallet_ledger_entries_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
          OR (direction = 'DEBIT' AND balance_after = balance_before - amount)
        )
      )
    `);
    this.addSql(`CREATE INDEX wallet_ledger_entries_wallet_cursor ON wallet_ledger_entries (wallet_id, id)`);
    this.addSql(`
      CREATE FUNCTION wallet_ledger_entries_reject_change() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only: % is not allowed', TG_OP
          USING ERRCODE = 'restrict_violation';
      END;
      $$
    `);
    // Statement-level because TRUNCATE has no row-level form, and so that the
    // block does not depend on how many rows the statement matches.
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_append_only
        BEFORE UPDATE OR DELETE OR TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION wallet_ledger_entries_reject_change()
    `);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text        NOT NULL,
        message_id    text        NOT NULL,
        payload_hash  text        NOT NULL,
        received_at   timestamptz NOT NULL,
        processed_at  timestamptz,
        CONSTRAINT inbox_messages_pk PRIMARY KEY (consumer_name, message_id)
      )
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id              uuid        PRIMARY KEY,
        aggregate_id    uuid        NOT NULL,
        event_type      text        NOT NULL,
        payload         jsonb       NOT NULL,
        occurred_at     timestamptz NOT NULL,
        attempts        integer     NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        published_at    timestamptz
      )
    `);
    this.addSql(`
      CREATE INDEX outbox_messages_unpublished_due
        ON outbox_messages (next_attempt_at)
        WHERE published_at IS NULL
    `);
  }

  override down(): void {
    this.addSql(`DROP TABLE outbox_messages`);
    this.addSql(`DROP TABLE inbox_messages`);
    this.addSql(`DROP TABLE wallet_ledger_entries`);
    this.addSql(`DROP FUNCTION wallet_ledger_entries_reject_change()`);
    this.addSql(`DROP TABLE wager_transactions`);
    this.addSql(`DROP TABLE wallets`);
  }
}
