/**
 * Unit tests — JWT auth middleware
 *
 * Tests: signToken, buildContext, requireAuth
 *
 * The env var JWT_SECRET is injected by vitest.config.js before this module loads.
 */

import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';

// Dynamic import after env is set (vitest.config.js sets JWT_SECRET)
const { signToken, buildContext, requireAuth } = await import('./auth.js');

const TEST_SECRET = process.env.JWT_SECRET;
const TEST_USER = { id: 'user-uuid-1234', email: 'test@jobmate.dev' };

// ── signToken ──────────────────────────────────────────────────────────────

describe('signToken', () => {
  it('returns a valid JWT string', () => {
    const token = signToken(TEST_USER);
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);
  });

  it('encodes userId and email in the payload', () => {
    const token = signToken(TEST_USER);
    const decoded = jwt.verify(token, TEST_SECRET);
    expect(decoded.userId).toBe(TEST_USER.id);
    expect(decoded.email).toBe(TEST_USER.email);
  });

  it('token is valid for the expected duration', () => {
    const token = signToken(TEST_USER);
    const decoded = jwt.decode(token);
    expect(decoded.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});

// ── buildContext ───────────────────────────────────────────────────────────

describe('buildContext', () => {
  it('returns { user: null } when no Authorization header', () => {
    const ctx = buildContext({ req: { headers: {} } });
    expect(ctx.user).toBeNull();
  });

  it('returns { user: null } for malformed Bearer prefix', () => {
    const ctx = buildContext({ req: { headers: { authorization: 'Basic abc' } } });
    expect(ctx.user).toBeNull();
  });

  it('returns { user: null } for an invalid token', () => {
    const ctx = buildContext({ req: { headers: { authorization: 'Bearer not.a.jwt' } } });
    expect(ctx.user).toBeNull();
  });

  it('returns { user: { userId, email } } for a valid token', () => {
    const token = signToken(TEST_USER);
    const ctx = buildContext({ req: { headers: { authorization: `Bearer ${token}` } } });
    expect(ctx.user).not.toBeNull();
    expect(ctx.user.userId).toBe(TEST_USER.id);
    expect(ctx.user.email).toBe(TEST_USER.email);
  });

  it('returns { user: null } for an expired token', async () => {
    // Sign a token that expires in 1 second
    const expiredToken = jwt.sign(
      { userId: TEST_USER.id, email: TEST_USER.email },
      TEST_SECRET,
      { expiresIn: 1 }
    );
    // Wait for it to expire
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const ctx = buildContext({ req: { headers: { authorization: `Bearer ${expiredToken}` } } });
    expect(ctx.user).toBeNull();
  });
});

// ── requireAuth ────────────────────────────────────────────────────────────

describe('requireAuth', () => {
  it('does not throw when user is present in context', () => {
    expect(() => requireAuth({ user: { userId: 'abc', email: 'a@b.com' } })).not.toThrow();
  });

  it('throws GraphQLError when user is null', () => {
    expect(() => requireAuth({ user: null })).toThrow('You must be logged in');
  });

  it('throws GraphQLError when context has no user key', () => {
    expect(() => requireAuth({})).toThrow('You must be logged in');
  });
});
