package scraper

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"jobmate/discovery-service/internal/model"
)

const (
	adzunaBaseURL    = "https://api.adzuna.com/v1/api/jobs"
	adzunaPageSize   = 50
	adzunaMaxPages   = 3  // max 150 results per (title × location) pair
	httpTimeout      = 15 * time.Second
)

// AdzunaFetcher fetches job offers from the Adzuna public API.
// If AppID or AppKey is empty, Fetch returns (nil, nil) gracefully — the
// worker will simply skip scraping for that round and log a warning.
type AdzunaFetcher struct {
	AppID   string
	AppKey  string
	Country string // "fr", "gb", "us", …
	client  *http.Client
}

// NewAdzunaFetcher constructs a fetcher with a shared HTTP client.
func NewAdzunaFetcher(appID, appKey, country string) *AdzunaFetcher {
	return &AdzunaFetcher{
		AppID:   appID,
		AppKey:  appKey,
		Country: country,
		client:  &http.Client{Timeout: httpTimeout},
	}
}

// adzunaResponse mirrors the top-level Adzuna JSON response.
type adzunaResponse struct {
	Results []adzunaResult `json:"results"`
	Count   int            `json:"count"`
}

// adzunaResult mirrors a single Adzuna job listing.
type adzunaResult struct {
	ID           string          `json:"id"`
	Title        string          `json:"title"`
	Description  string          `json:"description"`
	Company      adzunaCompany   `json:"company"`
	Location     adzunaLocation  `json:"location"`
	SalaryMin    float64         `json:"salary_min"`
	SalaryMax    float64         `json:"salary_max"`
	RedirectURL  string          `json:"redirect_url"`
	Created      string          `json:"created"`
	ContractTime string          `json:"contract_time"`
	ContractType string          `json:"contract_type"`
}

type adzunaCompany struct {
	DisplayName string `json:"display_name"`
}

type adzunaLocation struct {
	DisplayName string `json:"display_name"`
}

// Fetch retrieves all available offers for a given job title and location,
// iterating through pages until no more results or adzunaMaxPages is reached.
// Returns nil without error when credentials are missing.
func (f *AdzunaFetcher) Fetch(ctx context.Context, jobTitle, location string) ([]model.JobResult, error) {
	if f.AppID == "" || f.AppKey == "" {
		log.Println("[fetcher] ADZUNA_APP_ID / ADZUNA_APP_KEY not set — skipping scrape")
		return nil, nil
	}

	var results []model.JobResult

	for page := 1; page <= adzunaMaxPages; page++ {
		batch, err := f.fetchPage(ctx, jobTitle, location, page)
		if err != nil {
			return results, fmt.Errorf("page %d: %w", page, err)
		}
		if len(batch) == 0 {
			break // No more results
		}
		results = append(results, batch...)
		if len(batch) < adzunaPageSize {
			break // Last page
		}
	}

	return results, nil
}

func (f *AdzunaFetcher) fetchPage(ctx context.Context, jobTitle, location string, page int) ([]model.JobResult, error) {
	endpoint := fmt.Sprintf("%s/%s/search/%d", adzunaBaseURL, f.Country, page)

	params := url.Values{}
	params.Set("app_id", f.AppID)
	params.Set("app_key", f.AppKey)
	params.Set("results_per_page", strconv.Itoa(adzunaPageSize))
	params.Set("what", jobTitle)
	params.Set("where", location)
	params.Set("content-type", "application/json")
	params.Set("sort_by", "date")

	reqURL := endpoint + "?" + params.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")

	resp, err := f.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http GET: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read body: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("adzuna returned %d: %s", resp.StatusCode, string(body))
	}

	var apiResp adzunaResponse
	if err := json.Unmarshal(body, &apiResp); err != nil {
		return nil, fmt.Errorf("json unmarshal: %w", err)
	}

	results := make([]model.JobResult, 0, len(apiResp.Results))
	for _, r := range apiResp.Results {
		results = append(results, model.JobResult{
			ExternalID:   r.ID,
			Title:        r.Title,
			Company:      r.Company.DisplayName,
			Location:     r.Location.DisplayName,
			Description:  r.Description,
			SalaryMin:    r.SalaryMin,
			SalaryMax:    r.SalaryMax,
			SourceURL:    r.RedirectURL,
			ContractType: r.ContractType,
			PublishedAt:  r.Created,
		})
	}

	return results, nil
}
