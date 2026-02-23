// Package scraper implements job offer fetching, filtering and ingestion.
package scraper

import "strings"

// ContainsRedFlag returns true if any red flag term appears (case-insensitive)
// anywhere in the combined title + company + description text.
//
// Called before every DB insert — if true, the offer is silently discarded.
func ContainsRedFlag(title, company, description string, redFlags []string) bool {
	if len(redFlags) == 0 {
		return false
	}
	combined := strings.ToLower(title + " " + company + " " + description)
	for _, flag := range redFlags {
		if flag == "" {
			continue
		}
		if strings.Contains(combined, strings.ToLower(flag)) {
			return true
		}
	}
	return false
}
