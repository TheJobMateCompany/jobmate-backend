package kanban_test

// ── Additional edge-case tests ────────────────────────────────────────────
//
// This file extends transitions_test.go with cases discovered during the
// Phase 3 tracker-service additions (CreateApplication, SetRelanceReminder).
// The core state-machine matrix is already covered in transitions_test.go.

import (
	"testing"

	"jobmate/tracker-service/internal/kanban"
)

// ParseStatus must be case-sensitive — lowercase variants must not be valid.
func TestParseStatus_CaseSensitive(t *testing.T) {
	lowercase := []string{"to_apply", "applied", "interview", "offer", "hired", "rejected"}
	for _, s := range lowercase {
		_, err := kanban.ParseStatus(s)
		if err == nil {
			t.Errorf("ParseStatus(%q) should reject lowercase value, got nil error", s)
		}
	}
}

// ParseStatus must reject whitespace-padded strings.
func TestParseStatus_WithWhitespace(t *testing.T) {
	padded := []string{" APPLIED", "APPLIED ", " APPLIED "}
	for _, s := range padded {
		_, err := kanban.ParseStatus(s)
		if err == nil {
			t.Errorf("ParseStatus(%q) should reject padded value, got nil error", s)
		}
	}
}

// All six constants must round-trip through ParseStatus without error.
func TestParseStatus_AllConstantsRoundTrip(t *testing.T) {
	all := []kanban.Status{
		kanban.StatusToApply,
		kanban.StatusApplied,
		kanban.StatusInterview,
		kanban.StatusOffer,
		kanban.StatusHired,
		kanban.StatusRejected,
	}
	for _, s := range all {
		got, err := kanban.ParseStatus(string(s))
		if err != nil {
			t.Errorf("ParseStatus(%q) unexpected error: %v", s, err)
		}
		if got != s {
			t.Errorf("ParseStatus(%q) = %q, want %q", s, got, s)
		}
	}
}

// Every terminal state (HIRED, REJECTED) must NOT be the source of any
// allowed transition, regardless of target.
func TestIsTransitionAllowed_TerminalStatesHaveNoOutgoing(t *testing.T) {
	terminals := []kanban.Status{kanban.StatusHired, kanban.StatusRejected}
	allStatuses := []kanban.Status{
		kanban.StatusToApply,
		kanban.StatusApplied,
		kanban.StatusInterview,
		kanban.StatusOffer,
		kanban.StatusHired,
		kanban.StatusRejected,
	}
	for _, from := range terminals {
		for _, to := range allStatuses {
			if kanban.IsTransitionAllowed(from, to) {
				t.Errorf(
					"IsTransitionAllowed(%s → %s) must be false: %s is a terminal state",
					from, to, from,
				)
			}
		}
	}
}

// IsHired is used by service.go to gate archive logic.
// Verify it's a strict equality check — only HIRED returns true.
func TestIsHired_StrictEquality(t *testing.T) {
	nonHired := []kanban.Status{
		kanban.StatusToApply,
		kanban.StatusApplied,
		kanban.StatusInterview,
		kanban.StatusOffer,
		kanban.StatusRejected,
	}
	if !kanban.IsHired(kanban.StatusHired) {
		t.Error("IsHired(StatusHired) must be true")
	}
	for _, s := range nonHired {
		if kanban.IsHired(s) {
			t.Errorf("IsHired(%s) must be false", s)
		}
	}
}

// TO_APPLY is the mandatory initial state for any new application.
// Verify it is never reachable from any other state.
func TestIsTransitionAllowed_ToApplyIsNeverReachable(t *testing.T) {
	sources := []kanban.Status{
		kanban.StatusApplied,
		kanban.StatusInterview,
		kanban.StatusOffer,
		kanban.StatusHired,
		kanban.StatusRejected,
	}
	for _, from := range sources {
		if kanban.IsTransitionAllowed(from, kanban.StatusToApply) {
			t.Errorf(
				"IsTransitionAllowed(%s → TO_APPLY) must be false: TO_APPLY is only an initial state",
				from,
			)
		}
	}
}
