/**
 * SSE Connection Manager
 *
 * Keeps an in-memory registry of active Server-Sent Events connections,
 * keyed by userId. When the AI Coach publishes EVENT_ANALYSIS_DONE on Redis,
 * the gateway uses this manager to push the event to the right client.
 *
 * Usage:
 *   sseManager.add(userId, res)         — called when client connects to /events
 *   sseManager.send(userId, event)      — called when an EVENT_* is received from Redis
 *   sseManager.remove(userId)           — called on client disconnect
 */

class SSEManager {
  constructor() {
    /** @type {Map<string, import('express').Response>} */
    this.connections = new Map();
  }

  /**
   * Register a new SSE connection for a user.
   * Sends the initial "connected" event immediately.
   * @param {string}                    userId
   * @param {import('express').Response} res
   */
  add(userId, res) {
    // If there's already a connection for this user, close the old one
    if (this.connections.has(userId)) {
      console.log(`[sse] Replacing existing connection for user ${userId}`);
      this.connections.get(userId).end();
    }

    this.connections.set(userId, res);
    console.log(`[sse] User ${userId} connected. Active connections: ${this.connections.size}`);

    // Initial handshake event
    this._write(res, { type: 'connected', userId });
  }

  /**
   * Remove a user's SSE connection (on disconnect or error).
   * @param {string} userId
   */
  remove(userId) {
    this.connections.delete(userId);
    console.log(`[sse] User ${userId} disconnected. Active connections: ${this.connections.size}`);
  }

  /**
   * Push an event to a specific user's SSE stream.
   * Silently does nothing if the user is not connected.
   * @param {string} userId
   * @param {object} payload - will be JSON-serialized as the event data
   */
  send(userId, payload) {
    const res = this.connections.get(userId);
    if (!res) {
      console.warn(`[sse] No connection found for user ${userId} — event dropped.`);
      return;
    }
    this._write(res, payload);
  }

  /**
   * Broadcast an event to all connected clients.
   * Useful for system-wide notifications.
   * @param {object} payload
   */
  broadcast(payload) {
    for (const [userId, res] of this.connections) {
      this._write(res, payload);
    }
  }

  /**
   * Write a properly formatted SSE data frame.
   * @param {import('express').Response} res
   * @param {object} payload
   */
  _write(res, payload) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

// Singleton — shared across the entire gateway process
export const sseManager = new SSEManager();
