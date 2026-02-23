// Package kanban defines the Kanban state machine for job applications.
//
// Valid status graph:
//
//	TO_APPLY ──► APPLIED ──► INTERVIEW ──► OFFER ──► HIRED
//	    │            │             │           │
//	    └────────────┴─────────────┴───────────┴──► REJECTED
//
// HIRED and REJECTED are terminal states.
package kanban

import "fmt"

// Status values mirror the application_status enum in PostgreSQL.
type Status string

const (
	StatusToApply   Status = "TO_APPLY"
	StatusApplied   Status = "APPLIED"
	StatusInterview Status = "INTERVIEW"
	StatusOffer     Status = "OFFER"
	StatusHired     Status = "HIRED"
	StatusRejected  Status = "REJECTED"
)

// validTransitions lists every allowed (from → to) pair.
var validTransitions = map[Status][]Status{
	StatusToApply:   {StatusApplied, StatusRejected},
	StatusApplied:   {StatusInterview, StatusRejected},
	StatusInterview: {StatusOffer, StatusRejected},
	StatusOffer:     {StatusHired, StatusRejected},
	// HIRED and REJECTED are terminal — no outgoing transitions
}

// ParseStatus converts a raw string to a Status, returning an error for
// unknown values.
func ParseStatus(s string) (Status, error) {
	st := Status(s)
	switch st {
	case StatusToApply, StatusApplied, StatusInterview, StatusOffer, StatusHired, StatusRejected:
		return st, nil
	}
	return "", fmt.Errorf("unknown application status %q", s)
}

// IsTransitionAllowed returns true when moving from → to is permitted by the
// state machine.
func IsTransitionAllowed(from, to Status) bool {
	allowed, ok := validTransitions[from]
	if !ok {
		return false // terminal state — no outgoing transitions
	}
	for _, s := range allowed {
		if s == to {
			return true
		}
	}
	return false
}

// IsHired returns true when status is HIRED (triggers search-config archival).
func IsHired(s Status) bool { return s == StatusHired }
