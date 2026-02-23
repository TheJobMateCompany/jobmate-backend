/**
 * GraphQL Resolvers — JobMate Gateway
 *
 * Phase 1 implemented: register, login, me, updateProfile, SearchConfig CRUD
 * Phase 2–4 stubs: approveJob, rejectJob, jobFeed, moveCard, addNote, rateApplication
 */

import bcrypt from 'bcrypt';
import { GraphQLError } from 'graphql';
import { GraphQLJSON } from 'graphql-scalars';
import { query } from '../lib/db.js';
import { publish } from '../lib/redis.js';
import { signToken, requireAuth } from '../middleware/auth.js';

const BCRYPT_ROUNDS = 12;

/** Base URL for user-service internal calls */
const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://user-service:4001';

/**
 * Internal HTTP helper — calls user-service REST API.
 * Forwards the authenticated userId via x-user-id header.
 */
async function userServiceFetch(path, { userId, method = 'GET', body } = {}) {
  const res = await fetch(`${USER_SERVICE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(userId ? { 'x-user-id': userId } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const contentType = res.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await res.json() : null;

  if (!res.ok) {
    const msg = payload?.error || `user-service responded with ${res.status}`;
    throw new GraphQLError(msg, { extensions: { code: res.status === 404 ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR' } });
  }

  return payload;
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

/** Fetch a user + profile by user ID */
const getUserById = async (userId) => {
  const { rows } = await query(
    `SELECT u.id, u.email, u.created_at,
            p.id AS profile_id, p.full_name, p.status,
            p.skills_json, p.experience_json, p.projects_json, p.education_json
     FROM users u
     LEFT JOIN profiles p ON p.user_id = u.id
     WHERE u.id = $1`,
    [userId]
  );
  return rows[0] || null;
};

/** Map a DB row to a User + Profile GraphQL shape */
const rowToUser = (row) => ({
  id: row.id,
  email: row.email,
  createdAt: row.created_at,
  profile: row.profile_id
    ? {
        id: row.profile_id,
        fullName: row.full_name,
        status: row.status,
        skills: row.skills_json,
        experience: row.experience_json,
        projects: row.projects_json,
        education: row.education_json,
      }
    : null,
});

// ────────────────────────────────────────────────────────────
// Resolvers
// ────────────────────────────────────────────────────────────

export const resolvers = {
  // Custom scalar
  JSON: GraphQLJSON,

  // ── Queries ─────────────────────────────────────────────
  Query: {
    health: () => 'OK',

    me: async (_parent, _args, context) => {
      requireAuth(context);
      const row = await getUserById(context.user.userId);
      if (!row) throw new GraphQLError('User not found.', { extensions: { code: 'NOT_FOUND' } });
      return rowToUser(row);
    },

    // Phase 1 — SearchConfig
    mySearchConfigs: async (_parent, _args, context) => {
      requireAuth(context);
      return userServiceFetch('/search-configs', { userId: context.user.userId });
    },

    // Phase 2 — JobFeed (implemented)
    jobFeed: async (_parent, { status }, context) => {
      requireAuth(context);
      const { userId } = context.user;

      // Join through search_configs so users only see their own feed
      const { rows } = await query(
        `SELECT jf.id, jf.raw_data, jf.source_url, jf.status, jf.created_at
         FROM job_feed jf
         JOIN search_configs sc ON sc.id = jf.search_config_id
         WHERE sc.user_id = $1
           AND ($2::job_status IS NULL OR jf.status = $2::job_status)
           AND jf.expires_at > NOW()
         ORDER BY jf.created_at DESC
         LIMIT 100`,
        [userId, status ?? null]
      );

      return rows.map((r) => ({
        id: r.id,
        rawData: r.raw_data,
        sourceUrl: r.source_url,
        status: r.status,
        createdAt: r.created_at,
      }));
    },

    // Phase 4 — stub
    myApplications: async (_parent, _args, context) => {
      requireAuth(context);
      throw new GraphQLError('Not implemented yet — Phase 4.', { extensions: { code: 'NOT_IMPLEMENTED' } });
    },
  },

  // ── Mutations ────────────────────────────────────────────
  Mutation: {
    // ── register ──────────────────────────────────────────
    register: async (_parent, { email, password }) => {
      const normalizedEmail = email.trim().toLowerCase();

      // Check if email already exists
      const { rows: existing } = await query(
        'SELECT id FROM users WHERE email = $1',
        [normalizedEmail]
      );
      if (existing.length > 0) {
        throw new GraphQLError('An account with this email already exists.', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }

      if (password.length < 8) {
        throw new GraphQLError('Password must be at least 8 characters.', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

      // Create user + empty profile in a single transaction
      const { rows } = await query(
        `WITH new_user AS (
           INSERT INTO users (email, password_hash)
           VALUES ($1, $2)
           RETURNING id, email, created_at
         ),
         new_profile AS (
           INSERT INTO profiles (user_id)
           SELECT id FROM new_user
           RETURNING id, user_id, full_name, status,
                     skills_json, experience_json, projects_json, education_json
         )
         SELECT u.id, u.email, u.created_at,
                p.id AS profile_id, p.full_name, p.status,
                p.skills_json, p.experience_json, p.projects_json, p.education_json
         FROM new_user u
         JOIN new_profile p ON p.user_id = u.id`,
        [normalizedEmail, passwordHash]
      );

      const user = rowToUser(rows[0]);
      const token = signToken({ id: rows[0].id, email: rows[0].email });

      console.log(`[auth] New user registered: ${normalizedEmail}`);
      return { token, user };
    },

    // ── login ─────────────────────────────────────────────
    login: async (_parent, { email, password }) => {
      const normalizedEmail = email.trim().toLowerCase();

      const row = await getUserById(normalizedEmail).catch(() => null);

      // Fetch user with password hash
      const { rows } = await query(
        'SELECT id, email, password_hash FROM users WHERE email = $1',
        [normalizedEmail]
      );

      const INVALID_MSG = 'Invalid email or password.';

      if (rows.length === 0) {
        // Constant-time to prevent user enumeration
        await bcrypt.hash('dummy', BCRYPT_ROUNDS);
        throw new GraphQLError(INVALID_MSG, { extensions: { code: 'UNAUTHENTICATED' } });
      }

      const dbUser = rows[0];
      const valid = await bcrypt.compare(password, dbUser.password_hash);
      if (!valid) {
        throw new GraphQLError(INVALID_MSG, { extensions: { code: 'UNAUTHENTICATED' } });
      }

      const fullRow = await getUserById(dbUser.id);
      const user = rowToUser(fullRow);
      const token = signToken({ id: dbUser.id, email: dbUser.email });

      console.log(`[auth] User logged in: ${normalizedEmail}`);
      return { token, user };
    },

    // ── updateProfile ─────────────────────────────────────
    updateProfile: async (_parent, { input }, context) => {
      requireAuth(context);
      const { userId } = context.user;

      const { fullName, status, skills, experience, projects, education } = input;

      const { rows } = await query(
        `UPDATE profiles SET
           full_name      = COALESCE($1, full_name),
           status         = COALESCE($2::profile_status, status),
           skills_json    = COALESCE($3::jsonb, skills_json),
           experience_json= COALESCE($4::jsonb, experience_json),
           projects_json  = COALESCE($5::jsonb, projects_json),
           education_json = COALESCE($6::jsonb, education_json),
           updated_at     = NOW()
         WHERE user_id = $7
         RETURNING id, full_name, status,
                   skills_json, experience_json, projects_json, education_json`,
        [
          fullName ?? null,
          status ?? null,
          skills ? JSON.stringify(skills) : null,
          experience ? JSON.stringify(experience) : null,
          projects ? JSON.stringify(projects) : null,
          education ? JSON.stringify(education) : null,
          userId,
        ]
      );

      if (rows.length === 0) {
        throw new GraphQLError('Profile not found.', { extensions: { code: 'NOT_FOUND' } });
      }

      const p = rows[0];
      return {
        id: p.id,
        fullName: p.full_name,
        status: p.status,
        skills: p.skills_json,
        experience: p.experience_json,
        projects: p.projects_json,
        education: p.education_json,
      };
    },

    // ── SearchConfig (Phase 1) ─────────────────────────────
    createSearchConfig: async (_parent, { input }, context) => {
      requireAuth(context);
      return userServiceFetch('/search-configs', {
        userId: context.user.userId,
        method: 'POST',
        body: input,
      });
    },

    updateSearchConfig: async (_parent, { id, input }, context) => {
      requireAuth(context);
      return userServiceFetch(`/search-configs/${id}`, {
        userId: context.user.userId,
        method: 'PUT',
        body: input,
      });
    },

    deleteSearchConfig: async (_parent, { id }, context) => {
      requireAuth(context);
      await userServiceFetch(`/search-configs/${id}`, {
        userId: context.user.userId,
        method: 'DELETE',
      });
      return true;
    },

    // ── Phase 2 stubs ─────────────────────────────────────
    approveJob: async (_parent, { jobFeedId }, context) => {
      requireAuth(context);
      // Phase 2: update job_feed status, create application, publish CMD_ANALYZE_JOB
      throw new GraphQLError('Not implemented yet — Phase 2.', { extensions: { code: 'NOT_IMPLEMENTED' } });
    },

    rejectJob: async (_parent, { jobFeedId }, context) => {
      requireAuth(context);
      throw new GraphQLError('Not implemented yet — Phase 2.', { extensions: { code: 'NOT_IMPLEMENTED' } });
    },

    // ── Phase 4 stubs ─────────────────────────────────────
    moveCard: async (_parent, _args, context) => {
      requireAuth(context);
      throw new GraphQLError('Not implemented yet — Phase 4.', { extensions: { code: 'NOT_IMPLEMENTED' } });
    },

    addNote: async (_parent, _args, context) => {
      requireAuth(context);
      throw new GraphQLError('Not implemented yet — Phase 4.', { extensions: { code: 'NOT_IMPLEMENTED' } });
    },

    rateApplication: async (_parent, _args, context) => {
      requireAuth(context);
      throw new GraphQLError('Not implemented yet — Phase 4.', { extensions: { code: 'NOT_IMPLEMENTED' } });
    },
  },
};
