/**
 * SearchConfig routes — User Service (internal)
 *
 * Manages saved job-search configurations for a user.
 * The Discovery Service polls these to know what to scrape.
 */

import { Router } from 'express';
import { query } from '../lib/db.js';

const router = Router();

// ── GET /search-configs ────────────────────────────────────────
// List all active search configs for the requesting user.
router.get('/', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Missing x-user-id header.' });

  try {
    const { rows } = await query(
      `SELECT id, job_titles, locations, remote_policy, keywords, red_flags, salary_min, salary_max, is_active, created_at, updated_at
       FROM search_configs
       WHERE user_id = $1 AND is_active = true
       ORDER BY created_at DESC`,
      [userId]
    );

    res.json(rows.map(mapRow));
  } catch (err) {
    console.error('[searchConfig] GET list error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── POST /search-configs ───────────────────────────────────────
router.post('/', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Missing x-user-id header.' });

  const { jobTitles, locations, remotePolicy, keywords, redFlags, salaryMin, salaryMax } = req.body;

  if (!jobTitles || !Array.isArray(jobTitles) || jobTitles.length === 0) {
    return res.status(400).json({ error: 'jobTitles[] is required.' });
  }
  if (!locations || !Array.isArray(locations) || locations.length === 0) {
    return res.status(400).json({ error: 'locations[] is required.' });
  }

  try {
    const { rows } = await query(
      `INSERT INTO search_configs
         (user_id, job_titles, locations, remote_policy, keywords, red_flags, salary_min, salary_max)
       VALUES
         ($1, $2, $3, $4::remote_policy, $5, $6, $7, $8)
       RETURNING id, job_titles, locations, remote_policy, keywords, red_flags, salary_min, salary_max, is_active, created_at, updated_at`,
      [
        userId,
        jobTitles,
        locations,
        remotePolicy ?? 'HYBRID',
        keywords ?? [],
        redFlags ?? [],
        salaryMin ?? null,
        salaryMax ?? null,
      ]
    );

    res.status(201).json(mapRow(rows[0]));
  } catch (err) {
    console.error('[searchConfig] POST error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── PUT /search-configs/:id ────────────────────────────────────
router.put('/:id', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Missing x-user-id header.' });

  const { jobTitles, locations, remotePolicy, keywords, redFlags, salaryMin, salaryMax } = req.body;

  try {
    const { rows } = await query(
      `UPDATE search_configs SET
         job_titles    = COALESCE($1, job_titles),
         locations     = COALESCE($2, locations),
         remote_policy = COALESCE($3::remote_policy, remote_policy),
         keywords      = COALESCE($4, keywords),
         red_flags     = COALESCE($5, red_flags),
         salary_min    = COALESCE($6, salary_min),
         salary_max    = COALESCE($7, salary_max),
         updated_at    = NOW()
       WHERE id = $8 AND user_id = $9
       RETURNING id, job_titles, locations, remote_policy, keywords, red_flags, salary_min, salary_max, is_active, created_at, updated_at`,
      [
        jobTitles ?? null,
        locations ?? null,
        remotePolicy ?? null,
        keywords ?? null,
        redFlags ?? null,
        salaryMin ?? null,
        salaryMax ?? null,
        req.params.id,
        userId,
      ]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'SearchConfig not found or not yours.' });
    }

    res.json(mapRow(rows[0]));
  } catch (err) {
    console.error('[searchConfig] PUT error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── DELETE /search-configs/:id (soft delete) ───────────────────
router.delete('/:id', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Missing x-user-id header.' });

  try {
    const { rowCount } = await query(
      `UPDATE search_configs SET is_active = false, updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [req.params.id, userId]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: 'SearchConfig not found or not yours.' });
    }

    res.status(204).send();
  } catch (err) {
    console.error('[searchConfig] DELETE error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── Helper ─────────────────────────────────────────────────────
function mapRow(r) {
  return {
    id: r.id,
    jobTitles: r.job_titles,
    locations: r.locations,
    remotePolicy: r.remote_policy,
    keywords: r.keywords,
    redFlags: r.red_flags,
    salaryMin: r.salary_min,
    salaryMax: r.salary_max,
    isActive: r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export default router;
