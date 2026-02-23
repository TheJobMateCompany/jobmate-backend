/**
 * JWT Authentication Middleware & Context Builder
 *
 * Two exports:
 *  - `buildContext(req)` → used by Apollo Server to inject `user` into GraphQL context
 *  - `requireAuth(context)` → throws AuthenticationError if no user in context
 *
 * Token format:
 *   Authorization: Bearer <jwt>
 *
 * JWT payload: { userId, email, iat, exp }
 */

import jwt from 'jsonwebtoken';
import { GraphQLError } from 'graphql';

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('[auth] FATAL: JWT_SECRET is not set. Exiting.');
  process.exit(1);
}

/**
 * Sign a JWT token for a given user.
 * @param {{ id: string, email: string }} user
 * @returns {string} signed JWT
 */
export const signToken = (user) =>
  jwt.sign(
    { userId: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

/**
 * Build Apollo Server context from Express request.
 * Extracts and verifies the JWT from Authorization header.
 * Returns { user: { userId, email } } or { user: null } (no throw — resolvers decide).
 *
 * @param {{ req: import('express').Request }} param
 * @returns {{ user: object|null }}
 */
export const buildContext = ({ req }) => {
  const authHeader = req.headers.authorization || '';

  if (!authHeader.startsWith('Bearer ')) {
    return { user: null };
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return { user: decoded };
  } catch {
    // Expired or malformed token — client must re-login
    return { user: null };
  }
};

/**
 * Guard for protected resolvers.
 * Call at the top of any resolver that requires authentication.
 * @param {{ user: object|null }} context - Apollo context
 * @throws {GraphQLError} UNAUTHENTICATED if no valid user
 */
export const requireAuth = (context) => {
  if (!context.user) {
    throw new GraphQLError('You must be logged in to perform this action.', {
      extensions: { code: 'UNAUTHENTICATED' },
    });
  }
};
