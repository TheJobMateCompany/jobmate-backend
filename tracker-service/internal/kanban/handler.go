// Package kanban implements the HTTP handlers for the tracker service.
//
// All routes expect an x-user-id header forwarded by the Gateway.
//
// Routes:
//
//	GET  /applications                     → list user's applications
//	POST /applications/{id}/move           → move card to new Kanban status
//	POST /applications/{id}/note           → add/update free-text note
//	POST /applications/{id}/rate           → set numeric rating (1-5)
package kanban

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

// ─── Response types ───────────────────────────────────────────────────────────

// Application is the JSON shape returned to the Gateway / mobile+web clients.
type Application struct {
	ID                   string          `json:"id"`
	CurrentStatus        string          `json:"currentStatus"`
	AIAnalysis           json.RawMessage `json:"aiAnalysis"`
	GeneratedCoverLetter *string         `json:"generatedCoverLetter"`
	UserNotes            *string         `json:"userNotes"`
	UserRating           *int            `json:"userRating"`
	HistoryLog           json.RawMessage `json:"historyLog"`
	CreatedAt            time.Time       `json:"createdAt"`
	UpdatedAt            time.Time       `json:"updatedAt"`
}

// ─── Handler ─────────────────────────────────────────────────────────────────

// Handler holds shared dependencies.
type Handler struct {
	pool *pgxpool.Pool
	rdb  *redis.Client
}

// NewHandler returns a configured Handler.
func NewHandler(pool *pgxpool.Pool, rdb *redis.Client) *Handler {
	return &Handler{pool: pool, rdb: rdb}
}

// RegisterRoutes mounts all tracker-service routes on mux.
func (h *Handler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/applications", h.handleApplications)
	mux.HandleFunc("/applications/", h.handleApplicationAction)
}

// ─── Route dispatch ───────────────────────────────────────────────────────────

// handleApplications handles GET /applications
func (h *Handler) handleApplications(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	h.listApplications(w, r)
}

// handleApplicationAction handles POST /applications/{id}/move|note|rate
func (h *Handler) handleApplicationAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Parse /applications/{id}/{action}
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) != 3 {
		jsonError(w, "invalid path", http.StatusNotFound)
		return
	}

	appID := parts[1]
	action := parts[2]

	switch action {
	case "move":
		h.moveCard(w, r, appID)
	case "note":
		h.addNote(w, r, appID)
	case "rate":
		h.rateApplication(w, r, appID)
	default:
		jsonError(w, fmt.Sprintf("unknown action %q", action), http.StatusNotFound)
	}
}

// ─── Individual handlers ──────────────────────────────────────────────────────

func (h *Handler) listApplications(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("x-user-id")
	if userID == "" {
		jsonError(w, "missing x-user-id header", http.StatusUnauthorized)
		return
	}

	rows, err := h.pool.Query(r.Context(),
		`SELECT id, current_status, ai_analysis, generated_cover_letter,
		        user_notes, user_rating, history_log, created_at, updated_at
		 FROM applications
		 WHERE user_id = $1
		 ORDER BY updated_at DESC`,
		userID,
	)
	if err != nil {
		log.Printf("[tracker] listApplications query error: %v", err)
		jsonError(w, "database error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	apps := make([]Application, 0)
	for rows.Next() {
		var a Application
		if err := rows.Scan(
			&a.ID, &a.CurrentStatus, &a.AIAnalysis, &a.GeneratedCoverLetter,
			&a.UserNotes, &a.UserRating, &a.HistoryLog,
			&a.CreatedAt, &a.UpdatedAt,
		); err != nil {
			log.Printf("[tracker] listApplications scan error: %v", err)
			jsonError(w, "database error", http.StatusInternalServerError)
			return
		}
		apps = append(apps, a)
	}

	jsonOK(w, apps)
}

func (h *Handler) moveCard(w http.ResponseWriter, r *http.Request, appID string) {
	userID := r.Header.Get("x-user-id")
	if userID == "" {
		jsonError(w, "missing x-user-id header", http.StatusUnauthorized)
		return
	}

	var body struct {
		NewStatus string `json:"newStatus"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.NewStatus == "" {
		jsonError(w, "body must contain newStatus", http.StatusBadRequest)
		return
	}

	newStatus, err := ParseStatus(body.NewStatus)
	if err != nil {
		jsonError(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Fetch current state (also checks ownership)
	var currentStatusStr string
	err = h.pool.QueryRow(r.Context(),
		`SELECT current_status FROM applications WHERE id = $1 AND user_id = $2`,
		appID, userID,
	).Scan(&currentStatusStr)
	if err != nil {
		jsonError(w, "application not found", http.StatusNotFound)
		return
	}

	currentStatus, _ := ParseStatus(currentStatusStr)

	if !IsTransitionAllowed(currentStatus, newStatus) {
		jsonError(w, fmt.Sprintf("transition %s → %s is not allowed", currentStatus, newStatus), http.StatusBadRequest)
		return
	}

	// Build the history log entry to append
	historyEntry, _ := json.Marshal(map[string]string{
		"from": string(currentStatus),
		"to":   string(newStatus),
		"at":   time.Now().UTC().Format(time.RFC3339),
	})

	// Update status + append history_log entry atomically
	var app Application
	err = h.pool.QueryRow(r.Context(),
		`UPDATE applications
		 SET current_status = $1::application_status,
		     history_log    = history_log || $2::jsonb,
		     updated_at     = NOW()
		 WHERE id = $3 AND user_id = $4
		 RETURNING id, current_status, ai_analysis, generated_cover_letter,
		           user_notes, user_rating, history_log, created_at, updated_at`,
		string(newStatus),
		fmt.Sprintf("[%s]", historyEntry),
		appID, userID,
	).Scan(
		&app.ID, &app.CurrentStatus, &app.AIAnalysis, &app.GeneratedCoverLetter,
		&app.UserNotes, &app.UserRating, &app.HistoryLog,
		&app.CreatedAt, &app.UpdatedAt,
	)
	if err != nil {
		log.Printf("[tracker] moveCard update error: %v", err)
		jsonError(w, "database error", http.StatusInternalServerError)
		return
	}

	// When hired: deactivate the linked search config
	if IsHired(newStatus) {
		if err := h.archiveSearchConfig(r.Context(), appID); err != nil {
			// Non-fatal: log and continue
			log.Printf("[tracker] archiveSearchConfig failed for application %s: %v", appID, err)
		}
	}

	// Publish event for SSE
	event, _ := json.Marshal(map[string]string{
		"type":          "EVENT_CARD_MOVED",
		"applicationId": appID,
		"userId":        userID,
		"from":          string(currentStatus),
		"to":            string(newStatus),
	})
	if err := h.rdb.Publish(r.Context(), "EVENT_CARD_MOVED", event).Err(); err != nil {
		log.Printf("[tracker] publish EVENT_CARD_MOVED failed: %v", err)
	}

	jsonOK(w, app)
}

func (h *Handler) addNote(w http.ResponseWriter, r *http.Request, appID string) {
	userID := r.Header.Get("x-user-id")
	if userID == "" {
		jsonError(w, "missing x-user-id header", http.StatusUnauthorized)
		return
	}

	var body struct {
		Note string `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid JSON body", http.StatusBadRequest)
		return
	}

	var app Application
	err := h.pool.QueryRow(r.Context(),
		`UPDATE applications
		 SET user_notes = $1,
		     updated_at = NOW()
		 WHERE id = $2 AND user_id = $3
		 RETURNING id, current_status, ai_analysis, generated_cover_letter,
		           user_notes, user_rating, history_log, created_at, updated_at`,
		body.Note, appID, userID,
	).Scan(
		&app.ID, &app.CurrentStatus, &app.AIAnalysis, &app.GeneratedCoverLetter,
		&app.UserNotes, &app.UserRating, &app.HistoryLog,
		&app.CreatedAt, &app.UpdatedAt,
	)
	if err != nil {
		jsonError(w, "application not found", http.StatusNotFound)
		return
	}

	jsonOK(w, app)
}

func (h *Handler) rateApplication(w http.ResponseWriter, r *http.Request, appID string) {
	userID := r.Header.Get("x-user-id")
	if userID == "" {
		jsonError(w, "missing x-user-id header", http.StatusUnauthorized)
		return
	}

	var body struct {
		Rating int `json:"rating"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	if body.Rating < 1 || body.Rating > 5 {
		jsonError(w, "rating must be between 1 and 5", http.StatusBadRequest)
		return
	}

	var app Application
	err := h.pool.QueryRow(r.Context(),
		`UPDATE applications
		 SET user_rating = $1,
		     updated_at  = NOW()
		 WHERE id = $2 AND user_id = $3
		 RETURNING id, current_status, ai_analysis, generated_cover_letter,
		           user_notes, user_rating, history_log, created_at, updated_at`,
		body.Rating, appID, userID,
	).Scan(
		&app.ID, &app.CurrentStatus, &app.AIAnalysis, &app.GeneratedCoverLetter,
		&app.UserNotes, &app.UserRating, &app.HistoryLog,
		&app.CreatedAt, &app.UpdatedAt,
	)
	if err != nil {
		jsonError(w, "application not found", http.StatusNotFound)
		return
	}

	jsonOK(w, app)
}

// archiveSearchConfig deactivates the search_config linked to a given application
// when the application reaches HIRED status.
func (h *Handler) archiveSearchConfig(ctx context.Context, appID string) error {
	_, err := h.pool.Exec(ctx,
		`UPDATE search_configs sc
		 SET is_active  = false,
		     updated_at = NOW()
		 FROM applications a
		 JOIN job_feed jf ON jf.id = a.job_feed_id
		 WHERE a.id = $1
		   AND sc.id = jf.search_config_id`,
		appID,
	)
	return err
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func jsonOK(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(v)
}

func jsonError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
