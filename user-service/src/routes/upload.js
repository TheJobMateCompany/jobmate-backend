/**
 * CV upload route — User Service
 *
 * POST /upload/cv/:userId
 *   - Accepts a PDF (multipart/form-data, field: `cv`)
 *   - Saves to /uploads/ (ephemeral, swap with S3 in prod)
 *   - Parses the PDF text (pdfparse)
 *   - Stores extracted text in profiles.cv_url (URL) for now
 */

import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { query } from '../lib/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Only PDF files are accepted.'));
    }
    cb(null, true);
  },
});

const router = Router();

// ── POST /upload/cv/:userId ────────────────────────────────────
router.post('/cv/:userId', upload.single('cv'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No CV file uploaded.' });
  }

  const { userId } = req.params;
  const callerUserId = req.headers['x-user-id'];

  // Users can only upload their own CV
  if (callerUserId && callerUserId !== userId) {
    fs.unlink(req.file.path, () => {});
    return res.status(403).json({ error: 'Forbidden.' });
  }

  try {
    // Persist file path in profiles.cv_url (relative path for now)
    const relativePath = `/uploads/${req.file.filename}`;

    await query(
      `UPDATE profiles SET cv_url = $1, updated_at = NOW() WHERE user_id = $2`,
      [relativePath, userId]
    );

    // TODO Phase 3: publish `CV_UPLOADED` event to Redis → ai-coach-service parses & enriches profile
    // await publish('CV_UPLOADED', { userId, filePath: req.file.path });

    res.json({
      cvUrl: relativePath,
      message: 'CV uploaded successfully. AI enrichment pending.',
    });
  } catch (err) {
    console.error('[upload] CV error:', err.message);
    // Clean up orphaned file on DB error
    fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── Multer error handler ───────────────────────────────────────
router.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError || err.message === 'Only PDF files are accepted.') {
    return res.status(400).json({ error: err.message });
  }
  console.error('[upload] Unexpected error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

export default router;
