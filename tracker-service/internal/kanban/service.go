// Package kanban contains the pure business logic for the Tracker service.
// It is transport-agnostic: used by the gRPC server (grpcserver package).
package kanban

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

// ─── Service ─────────────────────────────────────────────────────────────────

// Service encapsulates all Kanban business logic.
// It has no dependency on net/http — it can be used by any transport layer.
type Service struct {
	pool *pgxpool.Pool
	rdb  *redis.Client
}

// NewService returns a configured Service.
func NewService(pool *pgxpool.Pool, rdb *redis.Client) *Service {
	return &Service{pool: pool, rdb: rdb}
}

// ─── Business logic ───────────────────────────────────────────────────────────

// ListApplications returns all applications for the given user, newest first.
// If statusFilter is non-empty, only applications with that status are returned.
func (s *Service) ListApplications(ctx context.Context, userID, statusFilter string) ([]Application, error) {
	const base = `
		SELECT a.id, a.current_status, a.ai_analysis, a.generated_cover_letter,
		       a.user_notes, a.user_rating, a.history_log,
		       COALESCE(a.job_feed_id::text, ''), COALESCE(jf.search_config_id::text, ''),
		       a.relance_reminder_at, a.created_at, a.updated_at
		FROM applications a
		LEFT JOIN job_feed jf ON jf.id = a.job_feed_id
		WHERE a.user_id = $1`

	var (
		rows pgx.Rows
		err  error
	)
	if statusFilter != "" {
		rows, err = s.pool.Query(ctx, base+` AND a.current_status = $2::application_status ORDER BY a.updated_at DESC`, userID, statusFilter)
	} else {
		rows, err = s.pool.Query(ctx, base+` ORDER BY a.updated_at DESC`, userID)
	}
	if err != nil {
		return nil, fmt.Errorf("listApplications query: %w", err)
	}
	defer rows.Close()

	apps := make([]Application, 0)
	for rows.Next() {
		var a Application
		if err := rows.Scan(
			&a.ID, &a.CurrentStatus, &a.AIAnalysis, &a.GeneratedCoverLetter,
			&a.UserNotes, &a.UserRating, &a.HistoryLog,
			&a.JobFeedID, &a.SearchConfigID, &a.RelanceReminderAt,
			&a.CreatedAt, &a.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("listApplications scan: %w", err)
		}
		apps = append(apps, a)
	}
	return apps, nil
}

// GetApplication returns a single application by ID, validating ownership.
func (s *Service) GetApplication(ctx context.Context, userID, appID string) (*Application, error) {
	var a Application
	err := s.pool.QueryRow(ctx,
		`SELECT a.id, a.current_status, a.ai_analysis, a.generated_cover_letter,
		        a.user_notes, a.user_rating, a.history_log,
		        COALESCE(a.job_feed_id::text, ''), COALESCE(jf.search_config_id::text, ''),
		        a.relance_reminder_at, a.created_at, a.updated_at
		 FROM applications a
		 LEFT JOIN job_feed jf ON jf.id = a.job_feed_id
		 WHERE a.id = $1 AND a.user_id = $2`,
		appID, userID,
	).Scan(
		&a.ID, &a.CurrentStatus, &a.AIAnalysis, &a.GeneratedCoverLetter,
		&a.UserNotes, &a.UserRating, &a.HistoryLog,
		&a.JobFeedID, &a.SearchConfigID, &a.RelanceReminderAt,
		&a.CreatedAt, &a.UpdatedAt,
	)
	if err != nil {
		return nil, ErrNotFound
	}
	return &a, nil
}

// CreateApplication inserts a new application at APPLIED status for the given job feed entry.
// It then publishes CMD_ANALYZE_JOB to kick off the AI Coach pipeline.
func (s *Service) CreateApplication(ctx context.Context, userID, jobFeedID string) (*Application, error) {
	var a Application
	err := s.pool.QueryRow(ctx,
		`WITH ins AS (
		   INSERT INTO applications (user_id, job_feed_id, current_status)
		   VALUES ($1, $2, 'APPLIED')
		   ON CONFLICT (user_id, job_feed_id) DO NOTHING
		   RETURNING *
		 )
		 SELECT ins.id, ins.current_status, ins.ai_analysis, ins.generated_cover_letter,
		        ins.user_notes, ins.user_rating, ins.history_log,
		        COALESCE(ins.job_feed_id::text, ''), COALESCE(jf.search_config_id::text, ''),
		        ins.relance_reminder_at, ins.created_at, ins.updated_at
		 FROM ins
		 LEFT JOIN job_feed jf ON jf.id = ins.job_feed_id`,
		userID, jobFeedID,
	).Scan(
		&a.ID, &a.CurrentStatus, &a.AIAnalysis, &a.GeneratedCoverLetter,
		&a.UserNotes, &a.UserRating, &a.HistoryLog,
		&a.JobFeedID, &a.SearchConfigID, &a.RelanceReminderAt,
		&a.CreatedAt, &a.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("createApplication: %w", err)
	}

	// Publish CMD_ANALYZE_JOB so the AI Coach scores this application (non-fatal).
	event, _ := json.Marshal(map[string]string{
		"type":          "CMD_ANALYZE_JOB",
		"applicationId": a.ID,
		"jobFeedId":     jobFeedID,
		"userId":        userID,
	})
	if err := s.rdb.Publish(ctx, "CMD_ANALYZE_JOB", event).Err(); err != nil {
		slog.Warn("publish CMD_ANALYZE_JOB failed", "err", err)
	}

	return &a, nil
}

// SetRelanceReminder sets the reminder timestamp on an application.
func (s *Service) SetRelanceReminder(ctx context.Context, userID, appID, remindAt string) (*Application, error) {
	var a Application
	err := s.pool.QueryRow(ctx,
		`WITH upd AS (
		   UPDATE applications
		   SET relance_reminder_at = $1::timestamptz, updated_at = NOW()
		   WHERE id = $2 AND user_id = $3
		   RETURNING *
		 )
		 SELECT upd.id, upd.current_status, upd.ai_analysis, upd.generated_cover_letter,
		        upd.user_notes, upd.user_rating, upd.history_log,
		        COALESCE(upd.job_feed_id::text, ''), COALESCE(jf.search_config_id::text, ''),
		        upd.relance_reminder_at, upd.created_at, upd.updated_at
		 FROM upd LEFT JOIN job_feed jf ON jf.id = upd.job_feed_id`,
		remindAt, appID, userID,
	).Scan(
		&a.ID, &a.CurrentStatus, &a.AIAnalysis, &a.GeneratedCoverLetter,
		&a.UserNotes, &a.UserRating, &a.HistoryLog,
		&a.JobFeedID, &a.SearchConfigID, &a.RelanceReminderAt,
		&a.CreatedAt, &a.UpdatedAt,
	)
	if err != nil {
		return nil, ErrNotFound
	}
	return &a, nil
}

// MoveCard transitions an application to a new Kanban status.
// Returns ErrNotFound if the application does not exist or belong to userID.
// Returns ErrForbiddenTransition if the state machine rejects the transition.
func (s *Service) MoveCard(ctx context.Context, userID, appID, newStatusStr string) (*Application, error) {
	newStatus, err := ParseStatus(newStatusStr)
	if err != nil {
		return nil, &ValidationError{Msg: err.Error()}
	}

	// Fetch current state (also validates ownership)
	var currentStatusStr string
	err = s.pool.QueryRow(ctx,
		`SELECT current_status FROM applications WHERE id = $1 AND user_id = $2`,
		appID, userID,
	).Scan(&currentStatusStr)
	if err != nil {
		return nil, ErrNotFound
	}

	currentStatus, _ := ParseStatus(currentStatusStr)
	if !IsTransitionAllowed(currentStatus, newStatus) {
		return nil, &ValidationError{
			Msg: fmt.Sprintf("transition %s → %s is not allowed", currentStatus, newStatus),
		}
	}

	historyEntry, _ := json.Marshal(map[string]string{
		"from": string(currentStatus),
		"to":   string(newStatus),
		"at":   time.Now().UTC().Format(time.RFC3339),
	})

	var app Application
	err = s.pool.QueryRow(ctx,
		`WITH upd AS (
		   UPDATE applications
		   SET current_status = $1::application_status,
		       history_log    = history_log || $2::jsonb,
		       updated_at     = NOW()
		   WHERE id = $3 AND user_id = $4
		   RETURNING *
		 )
		 SELECT upd.id, upd.current_status, upd.ai_analysis, upd.generated_cover_letter,
		        upd.user_notes, upd.user_rating, upd.history_log,
		        COALESCE(upd.job_feed_id::text, ''), COALESCE(jf.search_config_id::text, ''),
		        upd.relance_reminder_at, upd.created_at, upd.updated_at
		 FROM upd LEFT JOIN job_feed jf ON jf.id = upd.job_feed_id`,
		string(newStatus),
		fmt.Sprintf("[%s]", historyEntry),
		appID, userID,
	).Scan(
		&app.ID, &app.CurrentStatus, &app.AIAnalysis, &app.GeneratedCoverLetter,
		&app.UserNotes, &app.UserRating, &app.HistoryLog,
		&app.JobFeedID, &app.SearchConfigID, &app.RelanceReminderAt,
		&app.CreatedAt, &app.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("moveCard update: %w", err)
	}

	// On HIRED: deactivate the linked search_config (non-fatal)
	if IsHired(newStatus) {
		if err := s.archiveSearchConfig(ctx, appID); err != nil {
			slog.Warn("archiveSearchConfig failed", "applicationId", appID, "err", err)
		}
	}

	// Publish SSE event (non-fatal)
	event, _ := json.Marshal(map[string]string{
		"type":          "EVENT_CARD_MOVED",
		"applicationId": appID,
		"userId":        userID,
		"from":          string(currentStatus),
		"to":            string(newStatus),
	})
	if err := s.rdb.Publish(ctx, "EVENT_CARD_MOVED", event).Err(); err != nil {
		slog.Warn("publish EVENT_CARD_MOVED failed", "err", err)
	}

	return &app, nil
}

// AddNote sets or replaces the free-text note on an application.
func (s *Service) AddNote(ctx context.Context, userID, appID, note string) (*Application, error) {
	var app Application
	err := s.pool.QueryRow(ctx,
		`WITH upd AS (
		   UPDATE applications SET user_notes = $1, updated_at = NOW()
		   WHERE id = $2 AND user_id = $3
		   RETURNING *
		 )
		 SELECT upd.id, upd.current_status, upd.ai_analysis, upd.generated_cover_letter,
		        upd.user_notes, upd.user_rating, upd.history_log,
		        COALESCE(upd.job_feed_id::text, ''), COALESCE(jf.search_config_id::text, ''),
		        upd.relance_reminder_at, upd.created_at, upd.updated_at
		 FROM upd LEFT JOIN job_feed jf ON jf.id = upd.job_feed_id`,
		note, appID, userID,
	).Scan(
		&app.ID, &app.CurrentStatus, &app.AIAnalysis, &app.GeneratedCoverLetter,
		&app.UserNotes, &app.UserRating, &app.HistoryLog,
		&app.JobFeedID, &app.SearchConfigID, &app.RelanceReminderAt,
		&app.CreatedAt, &app.UpdatedAt,
	)
	if err != nil {
		return nil, ErrNotFound
	}
	return &app, nil
}

// RateApplication sets a 1–5 star rating on an application.
func (s *Service) RateApplication(ctx context.Context, userID, appID string, rating int32) (*Application, error) {
	if rating < 1 || rating > 5 {
		return nil, &ValidationError{Msg: "rating must be between 1 and 5"}
	}

	var app Application
	err := s.pool.QueryRow(ctx,
		`WITH upd AS (
		   UPDATE applications SET user_rating = $1, updated_at = NOW()
		   WHERE id = $2 AND user_id = $3
		   RETURNING *
		 )
		 SELECT upd.id, upd.current_status, upd.ai_analysis, upd.generated_cover_letter,
		        upd.user_notes, upd.user_rating, upd.history_log,
		        COALESCE(upd.job_feed_id::text, ''), COALESCE(jf.search_config_id::text, ''),
		        upd.relance_reminder_at, upd.created_at, upd.updated_at
		 FROM upd LEFT JOIN job_feed jf ON jf.id = upd.job_feed_id`,
		rating, appID, userID,
	).Scan(
		&app.ID, &app.CurrentStatus, &app.AIAnalysis, &app.GeneratedCoverLetter,
		&app.UserNotes, &app.UserRating, &app.HistoryLog,
		&app.JobFeedID, &app.SearchConfigID, &app.RelanceReminderAt,
		&app.CreatedAt, &app.UpdatedAt,
	)
	if err != nil {
		return nil, ErrNotFound
	}
	return &app, nil
}

// archiveSearchConfig deactivates the search_config linked to an application.
// Handles nullable job_feed_id (manual additions have no search_config; those are skipped gracefully).
func (s *Service) archiveSearchConfig(ctx context.Context, appID string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE search_configs sc
		 SET is_active  = false,
		     updated_at = NOW()
		 FROM applications a
		 LEFT JOIN job_feed jf ON jf.id = a.job_feed_id
		 WHERE a.id         = $1
		   AND jf.search_config_id IS NOT NULL
		   AND sc.id        = jf.search_config_id`,
		appID,
	)
	return err
}

// ─── Sentinel errors ─────────────────────────────────────────────────────────

// ErrNotFound is returned when an application is missing or does not belong to the user.
var ErrNotFound = fmt.Errorf("application not found")

// ValidationError wraps a user-facing validation message.
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }
