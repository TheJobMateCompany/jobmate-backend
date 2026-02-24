// Package kanban defines the core data types for the Tracker service.
package kanban

import (
	"encoding/json"
	"time"
)

// Application is the canonical representation of a job application row.
// It is returned by all Service methods and converted to proto messages
// by the gRPC server layer.
type Application struct {
	ID                   string          `json:"id"`
	CurrentStatus        string          `json:"currentStatus"`
	AIAnalysis           json.RawMessage `json:"aiAnalysis"`
	GeneratedCoverLetter *string         `json:"generatedCoverLetter"`
	UserNotes            *string         `json:"userNotes"`
	UserRating           *int32          `json:"userRating"`
	HistoryLog           json.RawMessage `json:"historyLog"`
	JobFeedID            string          `json:"jobFeedId"`
	SearchConfigID       string          `json:"searchConfigId"`
	RelanceReminderAt    *time.Time      `json:"relanceReminderAt"`
	CreatedAt            time.Time       `json:"createdAt"`
	UpdatedAt            time.Time       `json:"updatedAt"`
}
