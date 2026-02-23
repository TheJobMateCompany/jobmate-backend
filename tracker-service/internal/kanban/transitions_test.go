package kanban_test

import (
	"testing"

	"jobmate/tracker-service/internal/kanban"
)

// ── ParseStatus ────────────────────────────────────────────────────────────

func TestParseStatus_ValidValues(t *testing.T) {
	valid := []string{"TO_APPLY", "APPLIED", "INTERVIEW", "OFFER", "HIRED", "REJECTED"}
	for _, s := range valid {
		got, err := kanban.ParseStatus(s)
		if err != nil {
			t.Errorf("ParseStatus(%q) returned unexpected error: %v", s, err)
		}
		if string(got) != s {
			t.Errorf("ParseStatus(%q) = %q, want %q", s, got, s)
		}
	}
}

func TestParseStatus_InvalidValue(t *testing.T) {
	_, err := kanban.ParseStatus("UNKNOWN")
	if err == nil {
		t.Error("ParseStatus(\"UNKNOWN\") expected error, got nil")
	}
}

func TestParseStatus_EmptyString(t *testing.T) {
	_, err := kanban.ParseStatus("")
	if err == nil {
		t.Error("ParseStatus(\"\") expected error, got nil")
	}
}

// ── IsHired ────────────────────────────────────────────────────────────────

func TestIsHired(t *testing.T) {
	if !kanban.IsHired(kanban.StatusHired) {
		t.Error("IsHired(HIRED) should return true")
	}
	for _, s := range []kanban.Status{
		kanban.StatusToApply,
		kanban.StatusApplied,
		kanban.StatusInterview,
		kanban.StatusOffer,
		kanban.StatusRejected,
	} {
		if kanban.IsHired(s) {
			t.Errorf("IsHired(%s) should return false", s)
		}
	}
}

// ── IsTransitionAllowed — valid (forward) transitions ─────────────────────

func TestIsTransitionAllowed_ValidForward(t *testing.T) {
	cases := []struct {
		from kanban.Status
		to   kanban.Status
	}{
		{kanban.StatusToApply, kanban.StatusApplied},
		{kanban.StatusApplied, kanban.StatusInterview},
		{kanban.StatusInterview, kanban.StatusOffer},
		{kanban.StatusOffer, kanban.StatusHired},
	}
	for _, c := range cases {
		if !kanban.IsTransitionAllowed(c.from, c.to) {
			t.Errorf("IsTransitionAllowed(%s → %s) should be true", c.from, c.to)
		}
	}
}

// ── IsTransitionAllowed — rejection is always allowed (except from terminals) ─

func TestIsTransitionAllowed_ToRejected(t *testing.T) {
	nonTerminals := []kanban.Status{
		kanban.StatusToApply,
		kanban.StatusApplied,
		kanban.StatusInterview,
		kanban.StatusOffer,
	}
	for _, from := range nonTerminals {
		if !kanban.IsTransitionAllowed(from, kanban.StatusRejected) {
			t.Errorf("IsTransitionAllowed(%s → REJECTED) should be true", from)
		}
	}
}

// ── IsTransitionAllowed — terminal states have no outgoing transitions ─────

func TestIsTransitionAllowed_FromTerminal(t *testing.T) {
	terminals := []kanban.Status{kanban.StatusHired, kanban.StatusRejected}
	targets := []kanban.Status{
		kanban.StatusToApply,
		kanban.StatusApplied,
		kanban.StatusInterview,
		kanban.StatusOffer,
		kanban.StatusHired,
		kanban.StatusRejected,
	}
	for _, from := range terminals {
		for _, to := range targets {
			if kanban.IsTransitionAllowed(from, to) {
				t.Errorf("IsTransitionAllowed(%s → %s) should be false (terminal state)", from, to)
			}
		}
	}
}

// ── IsTransitionAllowed — skip-level transitions are forbidden ─────────────

func TestIsTransitionAllowed_SkipLevel(t *testing.T) {
	cases := []struct {
		from kanban.Status
		to   kanban.Status
	}{
		{kanban.StatusToApply, kanban.StatusInterview}, // skip APPLIED
		{kanban.StatusToApply, kanban.StatusOffer},    // skip two
		{kanban.StatusToApply, kanban.StatusHired},    // skip all
		{kanban.StatusApplied, kanban.StatusOffer},    // skip INTERVIEW
		{kanban.StatusApplied, kanban.StatusHired},    // skip two
		{kanban.StatusInterview, kanban.StatusHired},  // skip OFFER
	}
	for _, c := range cases {
		if kanban.IsTransitionAllowed(c.from, c.to) {
			t.Errorf("IsTransitionAllowed(%s → %s) should be false (skip-level)", c.from, c.to)
		}
	}
}

// ── IsTransitionAllowed — backwards movements are forbidden ───────────────

func TestIsTransitionAllowed_Backwards(t *testing.T) {
	cases := []struct {
		from kanban.Status
		to   kanban.Status
	}{
		{kanban.StatusApplied, kanban.StatusToApply},
		{kanban.StatusInterview, kanban.StatusApplied},
		{kanban.StatusOffer, kanban.StatusInterview},
	}
	for _, c := range cases {
		if kanban.IsTransitionAllowed(c.from, c.to) {
			t.Errorf("IsTransitionAllowed(%s → %s) should be false (backwards)", c.from, c.to)
		}
	}
}

// ── IsTransitionAllowed — self-transitions are forbidden ──────────────────

func TestIsTransitionAllowed_Self(t *testing.T) {
	all := []kanban.Status{
		kanban.StatusToApply, kanban.StatusApplied, kanban.StatusInterview,
		kanban.StatusOffer, kanban.StatusHired, kanban.StatusRejected,
	}
	for _, s := range all {
		if kanban.IsTransitionAllowed(s, s) {
			t.Errorf("IsTransitionAllowed(%s → %s) should be false (self)", s, s)
		}
	}
}
