/**
 * Unit tests — SSEManager
 *
 * Tests connection lifecycle: add, send, remove, broadcast.
 * Uses mock Express Response objects (write + end stubs).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sseManager } from './manager.js';

/** Create a fake Express Response with a spy on write() and end(). */
const mockRes = () => ({
  write: vi.fn(),
  end: vi.fn(),
});

beforeEach(() => {
  // Reset all connections between tests to ensure isolation
  sseManager.connections.clear();
});

// ── add() ──────────────────────────────────────────────────────────────────

describe('SSEManager.add', () => {
  it('registers the connection and sends the initial "connected" event', () => {
    const res = mockRes();
    sseManager.add('user-1', res);

    expect(sseManager.connections.has('user-1')).toBe(true);
    expect(res.write).toHaveBeenCalledOnce();

    const written = res.write.mock.calls[0][0];
    expect(written).toContain('"type":"connected"');
    expect(written).toContain('"userId":"user-1"');
  });

  it('closes the previous connection when the same user reconnects', () => {
    const oldRes = mockRes();
    const newRes = mockRes();

    sseManager.add('user-1', oldRes);
    sseManager.add('user-1', newRes);

    expect(oldRes.end).toHaveBeenCalledOnce();
    expect(sseManager.connections.get('user-1')).toBe(newRes);
  });

  it('tracks multiple users independently', () => {
    sseManager.add('user-A', mockRes());
    sseManager.add('user-B', mockRes());

    expect(sseManager.connections.size).toBe(2);
  });
});

// ── remove() ───────────────────────────────────────────────────────────────

describe('SSEManager.remove', () => {
  it('removes the connection from the registry', () => {
    sseManager.add('user-1', mockRes());
    sseManager.remove('user-1');

    expect(sseManager.connections.has('user-1')).toBe(false);
  });

  it('is safe to call for a user that is not connected', () => {
    expect(() => sseManager.remove('nonexistent-user')).not.toThrow();
  });
});

// ── send() ─────────────────────────────────────────────────────────────────

describe('SSEManager.send', () => {
  it('calls write() with a valid SSE data frame', () => {
    const res = mockRes();
    sseManager.add('user-1', res);
    res.write.mockClear(); // clear the initial "connected" write

    sseManager.send('user-1', { type: 'ANALYSIS_DONE', matchScore: 87 });

    expect(res.write).toHaveBeenCalledOnce();
    const frame = res.write.mock.calls[0][0];
    expect(frame).toMatch(/^data: /);
    expect(frame).toContain('"type":"ANALYSIS_DONE"');
    expect(frame).toContain('"matchScore":87');
    expect(frame).toMatch(/\n\n$/); // must end with double newline
  });

  it('does nothing when the user has no active connection', () => {
    // Should not throw
    expect(() => sseManager.send('ghost-user', { type: 'test' })).not.toThrow();
  });
});

// ── broadcast() ────────────────────────────────────────────────────────────

describe('SSEManager.broadcast', () => {
  it('sends to all connected clients', () => {
    const resA = mockRes();
    const resB = mockRes();

    sseManager.add('user-A', resA);
    sseManager.add('user-B', resB);
    resA.write.mockClear();
    resB.write.mockClear();

    sseManager.broadcast({ type: 'SYSTEM', message: 'maintenance' });

    expect(resA.write).toHaveBeenCalledOnce();
    expect(resB.write).toHaveBeenCalledOnce();

    const frameA = resA.write.mock.calls[0][0];
    expect(frameA).toContain('"type":"SYSTEM"');
  });

  it('does nothing when there are no connections', () => {
    expect(() => sseManager.broadcast({ type: 'ping' })).not.toThrow();
  });
});
