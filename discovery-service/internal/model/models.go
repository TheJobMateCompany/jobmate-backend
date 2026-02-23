// Package model defines shared data structures for the discovery service.
package model

// SearchConfig mirrors the search_configs table row relevant to scraping.
type SearchConfig struct {
	ID           string
	UserID       string
	JobTitles    []string
	Locations    []string
	RemotePolicy string
	Keywords     []string // must-have tech/role keywords used to narrow search
	RedFlags     []string // exclusion terms — any match discards the offer
	SalaryMin    *int
	SalaryMax    *int
}

// JobResult is a normalised offer fetched from an external job board.
// It is converted to JSON and stored in job_feed.raw_data (JSONB).
type JobResult struct {
	ExternalID  string                 `json:"externalId"`
	Title       string                 `json:"title"`
	Company     string                 `json:"company"`
	Location    string                 `json:"location"`
	Description string                 `json:"description"`
	SalaryMin   float64                `json:"salaryMin,omitempty"`
	SalaryMax   float64                `json:"salaryMax,omitempty"`
	SourceURL   string                 `json:"sourceUrl"`
	ContractType string               `json:"contractType,omitempty"`
	PublishedAt string                 `json:"publishedAt,omitempty"`
	Extra       map[string]interface{} `json:"extra,omitempty"`
}
