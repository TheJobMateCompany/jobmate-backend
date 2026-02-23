/**
 * Profile routes — User Service (internal)
 *
 * Called by the Gateway via internal Docker network HTTP.
 * All routes require a valid userId (extracted from JWT by the Gateway and passed in headers).
 *
 * Convention: Gateway forwards `x-user-id` header on every internal request.
 */

import { Router } from 'express';
import { query } from '../lib/db.js';

const router = Router();

// ── GET /profile/:userId ───────────────────────────────────────
router.get('/:userId', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT p.id, p.full_name, p.status,
              p.skills_json, p.experience_json, p.projects_json, p.education_json,
              p.created_at, p.updated_at
       FROM profiles p
       WHERE p.user_id = $1`,
      [req.params.userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Profile not found.' });
    }

    const p = rows[0];
    res.json({
      id: p.id,
      fullName: p.full_name,
      status: p.status,
      skills: p.skills_json,
      experience: p.experience_json,
      projects: p.projects_json,
      education: p.education_json,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    });
  } catch (err) {
    console.error('[profile] GET error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── PUT /profile/:userId ───────────────────────────────────────
router.put('/:userId', async (req, res) => {
  try {
    const { fullName, status, skills, experience, projects, education } = req.body;

    const { rows } = await query(
      `UPDATE profiles SET
         full_name       = COALESCE($1, full_name),
         status          = COALESCE($2::profile_status, status),
         skills_json     = COALESCE($3::jsonb, skills_json),
         experience_json = COALESCE($4::jsonb, experience_json),
         projects_json   = COALESCE($5::jsonb, projects_json),
         education_json  = COALESCE($6::jsonb, education_json),
         updated_at      = NOW()
       WHERE user_id = $7
       RETURNING id, full_name, status,
                 skills_json, experience_json, projects_json, education_json,
                 created_at, updated_at`,
      [
        fullName ?? null,
        status ?? null,
        skills ? JSON.stringify(skills) : null,
        experience ? JSON.stringify(experience) : null,
        projects ? JSON.stringify(projects) : null,
        education ? JSON.stringify(education) : null,
        req.params.userId,
      ]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Profile not found.' });
    }

    const p = rows[0];
    res.json({
      id: p.id,
      fullName: p.full_name,
      status: p.status,
      skills: p.skills_json,
      experience: p.experience_json,
      projects: p.projects_json,
      education: p.education_json,
      updatedAt: p.updated_at,
    });
  } catch (err) {
    console.error('[profile] PUT error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

export default router;
