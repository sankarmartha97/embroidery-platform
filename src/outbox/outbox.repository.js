// Transactional outbox (ADR-0002): services enqueue messages in the same transaction as
// their state change; the relay publishes them afterwards.

export function createOutboxRepository(db) {
  return {
    async enqueue({ aggregateType, aggregateId, messageType, destination, payload }) {
      await db.execute(
        `INSERT INTO outbox_messages (aggregate_type, aggregate_id, message_type, destination, payload_json)
         VALUES (?, ?, ?, ?, ?)`,
        [aggregateType, aggregateId, messageType, destination, JSON.stringify(payload)],
      );
    },

    async listUnsent({ limit, maxAttempts }) {
      const [rows] = await db.execute(
        `SELECT id, aggregate_type, aggregate_id, message_type, destination, payload_json, attempts
           FROM outbox_messages
          WHERE sent_at IS NULL AND attempts < ?
          ORDER BY id
          LIMIT ${Number(limit)}`,
        [maxAttempts],
      );
      return rows.map((r) => ({
        id: String(r.id),
        aggregateType: r.aggregate_type,
        aggregateId: r.aggregate_id,
        messageType: r.message_type,
        destination: r.destination,
        payload: typeof r.payload_json === 'string' ? JSON.parse(r.payload_json) : r.payload_json,
        attempts: r.attempts,
      }));
    },

    async markSent(id) {
      await db.execute(`UPDATE outbox_messages SET sent_at = CURRENT_TIMESTAMP(3) WHERE id = ?`, [
        id,
      ]);
    },

    async markFailed(id, error) {
      await db.execute(
        `UPDATE outbox_messages SET attempts = attempts + 1, last_error = ? WHERE id = ?`,
        [String(error).slice(0, 500), id],
      );
    },
  };
}
