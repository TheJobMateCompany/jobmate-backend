/**
 * GraphQL Resolvers — JobMate Gateway
 *
 * Phase 1 implemented: register, login, me, updateProfile, SearchConfig CRUD
 * Phase 2–4 stubs: approveJob, rejectJob, jobFeed, moveCard, addNote, rateApplication
 */

import bcrypt from 'bcrypt';
import { GraphQLError } from 'graphql';
import { GraphQLJSON } from 'graphql-scalars';
import GraphQLUpload from 'graphql-upload/GraphQLUpload.mjs';
import { query } from '../lib/db.js';
import { publish } from '../lib/redis.js';
import { signToken, requireAuth } from '../middleware/auth.js';
import * as trackerClient from '../lib/trackerGrpc.js';
import * as userClient from '../lib/userGrpc.js';
import * as discoveryClient from '../lib/discoveryGrpc.js';

const BCRYPT_ROUNDS = 12;

// All service communication is now via gRPC.
// tracker-service → ../lib/trackerGrpc.js (port 9082)
// user-service    → ../lib/userGrpc.js    (port 9081)

// ────────────────────────────────────────────────────────────
// Helpers

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

/** Convert a protobuf Timestamp { seconds, nanos } to an ISO-8601 string */
const protoTsToISO = (ts) => {
  if (!ts) return null;
  const ms = Number(ts.seconds) * 1000 + Math.floor(Number(ts.nanos ?? 0) / 1e6);
  return new Date(ms).toISOString();
};

// ────────────────────────────────────────────────────────────
// Resolvers
// ────────────────────────────────────────────────────────────

export const resolvers = {
  // File upload scalar — implements graphql-multipart-request-spec
  Upload: GraphQLUpload,

  // Custom scalar
  JSON: GraphQLJSON,
  // ── SearchConfig type resolver: convert proto Timestamps ───────────────────
  SearchConfig: {
    createdAt: (parent) => protoTsToISO(parent.createdAt) ?? '',
    updatedAt: (parent) => protoTsToISO(parent.updatedAt) ?? '',
    startDate: (parent) => parent.startDate || null,
  },
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
      return userClient.getSearchConfigs(context.user.userId);
    },

    // Profile (via profile-service gRPC)
    myProfile: async (_parent, _args, context) => {
      requireAuth(context);
      return userClient.getProfile(context.user.userId);
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

    // Phase 4 — Applications
    myApplications: async (_parent, { status }, context) => {
      requireAuth(context);
      return trackerClient.listApplications(context.user.userId, status ?? '');
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

      const { fullName, status, skills, experience, projects, education, certifications } = input;

      const { rows } = await query(
        `UPDATE profiles SET
           full_name            = COALESCE($1, full_name),
           status               = COALESCE($2::profile_status, status),
           skills_json          = COALESCE($3::jsonb, skills_json),
           experience_json      = COALESCE($4::jsonb, experience_json),
           projects_json        = COALESCE($5::jsonb, projects_json),
           education_json       = COALESCE($6::jsonb, education_json),
           certifications_json  = COALESCE($8::jsonb, certifications_json),
           updated_at           = NOW()
         WHERE user_id = $7
         RETURNING id, full_name, status,
                   skills_json, experience_json, projects_json, education_json, certifications_json, cv_url`,
        [
          fullName ?? null,
          status ?? null,
          skills ? JSON.stringify(skills) : null,
          experience ? JSON.stringify(experience) : null,
          projects ? JSON.stringify(projects) : null,
          education ? JSON.stringify(education) : null,
          userId,
          certifications ? JSON.stringify(certifications) : null,
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
        certifications: p.certifications_json,
        cvUrl: p.cv_url,
      };
    },

    // ── SearchConfig (Phase 1) ─────────────────────────────
    createSearchConfig: async (_parent, { input }, context) => {
      requireAuth(context);
      return userClient.createSearchConfig(context.user.userId, input);
    },

    updateSearchConfig: async (_parent, { id, input }, context) => {
      requireAuth(context);
      return userClient.updateSearchConfig(context.user.userId, id, input);
    },

    deleteSearchConfig: async (_parent, { id }, context) => {
      requireAuth(context);
      const result = await userClient.deleteSearchConfig(context.user.userId, id);
      return result.success ?? true;
    },

    // ── uploadCV ──────────────────────────────────────────
    uploadCV: async (_parent, { file }, context) => {
      requireAuth(context);

      const { createReadStream, filename, mimetype } = await file;

      if (mimetype !== 'application/pdf') {
        throw new GraphQLError('Only PDF files are accepted.', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }

      // Stream → Buffer
      const stream = createReadStream();
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);

      if (buffer.length > 10 * 1024 * 1024) {
        throw new GraphQLError('File too large (max 10 MB).', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }

      return userClient.uploadCV(context.user.userId, buffer, filename, mimetype);
    },

    // ── createApplication (manual kanban entry) ────────────────────────────
    createApplication: async (_parent, { jobFeedId }, context) => {
      requireAuth(context);
      const { userId } = context.user;

      // Insert a bare application; NULL job_feed_id = manual entry.
      // ON CONFLICT: a user can only have one manual (null job_feed_id) application
      // — just bump updated_at so the row is returned.
      const { rows } = await query(
        `INSERT INTO applications (user_id, job_feed_id, current_status)
         VALUES ($1, $2, 'TO_APPLY')
         ON CONFLICT (user_id, job_feed_id) DO UPDATE
           SET updated_at = NOW()
         RETURNING id, job_feed_id, current_status, ai_analysis, generated_cover_letter,
                   user_notes, user_rating, relance_reminder_at, history_log,
                   created_at, updated_at`,
        [userId, jobFeedId ?? null],
      );

      const app = rows[0];
      return {
        id: app.id,
        jobFeedId: app.job_feed_id,
        currentStatus: app.current_status,
        aiAnalysis: app.ai_analysis,
        generatedCoverLetter: app.generated_cover_letter,
        userNotes: app.user_notes,
        userRating: app.user_rating,
        relanceReminderAt: app.relance_reminder_at,
        historyLog: app.history_log,
        createdAt: app.created_at,
        updatedAt: app.updated_at,
      };
    },

    // ── approveJob (Phase 3) ───────────────────────────────
    approveJob: async (_parent, { jobFeedId }, context) => {
      requireAuth(context);
      const { userId } = context.user;

      // 1. Verify ownership — job must belong to the authenticated user via search_configs
      const { rows: feedRows } = await query(
        `SELECT jf.id, jf.status, jf.raw_data, jf.source_url, jf.created_at
         FROM job_feed jf
         JOIN search_configs sc ON sc.id = jf.search_config_id
         WHERE jf.id = $1 AND sc.user_id = $2`,
        [jobFeedId, userId]
      );

      if (feedRows.length === 0) {
        throw new GraphQLError('Job not found or does not belong to you.', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      if (feedRows[0].status === 'APPROVED') {
        throw new GraphQLError('Job is already approved.', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }

      // 2. Update job_feed status to APPROVED
      await query(
        `UPDATE job_feed SET status = 'APPROVED' WHERE id = $1`,
        [jobFeedId]
      );

      // 3. Insert application — ON CONFLICT keeps idempotent if called twice
      const { rows: appRows } = await query(
        `INSERT INTO applications (user_id, job_feed_id, current_status)
         VALUES ($1, $2, 'TO_APPLY')
         ON CONFLICT (user_id, job_feed_id) DO UPDATE
           SET updated_at = NOW()
         RETURNING id, current_status, ai_analysis, generated_cover_letter,
                   user_notes, user_rating, history_log, created_at, updated_at`,
        [userId, jobFeedId]
      );

      const app = appRows[0];

      // 4. Publish CMD_ANALYZE_JOB → ai-coach-service via Redis
      try {
        await publish('CMD_ANALYZE_JOB', { applicationId: app.id, userId });
        console.log(`[approveJob] Published CMD_ANALYZE_JOB for application ${app.id}`);
      } catch (err) {
        // Non-fatal: analysis will be triggered on next retry mechanism
        console.error('[approveJob] Failed to publish CMD_ANALYZE_JOB:', err.message);
      }

      // 5. Return Application shape
      return {
        id: app.id,
        currentStatus: app.current_status,
        aiAnalysis: app.ai_analysis,
        generatedCoverLetter: app.generated_cover_letter,
        userNotes: app.user_notes,
        userRating: app.user_rating,
        historyLog: app.history_log,
        createdAt: app.created_at,
        updatedAt: app.updated_at,
      };
    },

    // ── rejectJob (Phase 3) ────────────────────────────────
    rejectJob: async (_parent, { jobFeedId }, context) => {
      requireAuth(context);
      const { userId } = context.user;

      // Verify ownership + update in one round-trip
      const { rows } = await query(
        `UPDATE job_feed jf
         SET status = 'REJECTED'
         FROM search_configs sc
         WHERE jf.id = $1
           AND jf.search_config_id = sc.id
           AND sc.user_id = $2
         RETURNING jf.id, jf.raw_data, jf.source_url, jf.status, jf.created_at`,
        [jobFeedId, userId]
      );

      if (rows.length === 0) {
        throw new GraphQLError('Job not found or does not belong to you.', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      const r = rows[0];
      return {
        id: r.id,
        rawData: r.raw_data,
        sourceUrl: r.source_url,
        status: r.status,
        createdAt: r.created_at,
      };
    },

    // ── Phase 4 ────────────────────────────────────────────
    moveCard: async (_parent, { applicationId, newStatus }, context) => {
      requireAuth(context);
      return trackerClient.moveCard(context.user.userId, applicationId, newStatus);
    },

    addNote: async (_parent, { applicationId, note }, context) => {
      requireAuth(context);
      return trackerClient.addNote(context.user.userId, applicationId, note);
    },

    rateApplication: async (_parent, { applicationId, rating }, context) => {
      requireAuth(context);
      return trackerClient.rateApplication(context.user.userId, applicationId, rating);
    },
    setRelanceReminder: async (_parent, { applicationId, remindAt }, context) => {
      requireAuth(context);
      return trackerClient.setRelanceReminder(context.user.userId, applicationId, remindAt);
    },

    // ── Discovery ────────────────────────────────────────
    addJobByUrl: async (_parent, { searchConfigId, url }, context) => {
      requireAuth(context);
      return discoveryClient.addJobByUrl(context.user.userId, searchConfigId ?? null, url);
    },

    addJobManually: async (_parent, { input }, context) => {
      requireAuth(context);
      return discoveryClient.addJobManually(context.user.userId, input);
    },

    triggerScan: async (_parent, _args, context) => {
      requireAuth(context);
      return discoveryClient.triggerScan(context.user.userId);
    },

    // ── CV ───────────────────────────────────────────────
    parseCV: async (_parent, { cvUrl }, context) => {
      requireAuth(context);
      const result = await userClient.parseCV(context.user.userId, cvUrl);
      return result.success ?? false;
    },
  },
};
