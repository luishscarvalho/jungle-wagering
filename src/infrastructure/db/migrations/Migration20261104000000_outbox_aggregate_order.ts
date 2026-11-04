import { Migration } from "@mikro-orm/migrations";

export class Migration20261104000000_outbox_aggregate_order extends Migration {
  override up(): void {
    // Backs the publisher's check for an older unpublished message of the same aggregate.
    this.addSql(`
      CREATE INDEX outbox_messages_unpublished_aggregate_order
        ON outbox_messages (aggregate_id, occurred_at, id)
        WHERE published_at IS NULL
    `);
  }

  override down(): void {
    this.addSql(`DROP INDEX outbox_messages_unpublished_aggregate_order`);
  }
}
