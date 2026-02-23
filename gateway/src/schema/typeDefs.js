/**
 * GraphQL Type Definitions — JobMate Gateway
 *
 * Phase 1: Auth + Profile + SearchConfig
 * Future phases will add: JobFeed, Applications, Kanban
 */

export const typeDefs = `#graphql

  # ────────────────────────────────────────────────
  # Scalars
  # ────────────────────────────────────────────────

  # Arbitrary JSON blob (skills, experience, etc.)
  scalar JSON

  # ────────────────────────────────────────────────
  # Core Types
  # ────────────────────────────────────────────────

  type User {
    id: ID!
    email: String!
    profile: Profile
    createdAt: String!
  }

  type Profile {
    id: ID!
    fullName: String
    status: ProfileStatus
    skills: JSON
    experience: JSON
    projects: JSON
    education: JSON
  }

  type AuthPayload {
    token: String!
    user: User!
  }

  # ────────────────────────────────────────────────
  # Search Config (Phase 1)
  # ────────────────────────────────────────────────

  type SearchConfig {
    id: ID!
    jobTitles: [String!]!
    locations: [String!]!
    remotePolicy: RemotePolicy!
    keywords: [String!]!
    salaryMin: Int
    salaryMax: Int
    isActive: Boolean!
    createdAt: String!
    updatedAt: String!
  }

  # ────────────────────────────────────────────────
  # Job Feed (Phase 2 — stubs)
  # ────────────────────────────────────────────────

  type JobFeedItem {
    id: ID!
    rawData: JSON!
    sourceUrl: String
    status: JobStatus!
    createdAt: String!
  }

  # ────────────────────────────────────────────────
  # Applications / Kanban (Phase 4 — stubs)
  # ────────────────────────────────────────────────

  type Application {
    id: ID!
    currentStatus: ApplicationStatus!
    aiAnalysis: JSON
    generatedCoverLetter: String
    userNotes: String
    userRating: Int
    historyLog: JSON
    createdAt: String!
    updatedAt: String!
  }

  # ────────────────────────────────────────────────
  # Enums
  # ────────────────────────────────────────────────

  enum ProfileStatus {
    STUDENT
    JUNIOR
    MID
    SENIOR
    OPEN_TO_WORK
  }

  enum JobStatus {
    PENDING
    APPROVED
    REJECTED
  }

  enum ApplicationStatus {
    TO_APPLY
    APPLIED
    INTERVIEW
    OFFER
    REJECTED
    HIRED
  }

  enum RemotePolicy {
    REMOTE
    HYBRID
    ON_SITE
  }

  # ────────────────────────────────────────────────
  # Inputs
  # ────────────────────────────────────────────────

  input UpdateProfileInput {
    fullName: String
    status: ProfileStatus
    skills: JSON
    experience: JSON
    projects: JSON
    education: JSON
  }

  input CreateSearchConfigInput {
    jobTitles: [String!]!
    locations: [String!]!
    remotePolicy: RemotePolicy
    keywords: [String!]
    salaryMin: Int
    salaryMax: Int
  }

  input UpdateSearchConfigInput {
    jobTitles: [String!]
    locations: [String!]
    remotePolicy: RemotePolicy
    keywords: [String!]
    salaryMin: Int
    salaryMax: Int
  }

  # ────────────────────────────────────────────────
  # Queries
  # ────────────────────────────────────────────────

  type Query {
    # Health check (public)
    health: String!

    # Auth-required
    me: User!
    mySearchConfigs: [SearchConfig!]!               # Phase 1
    jobFeed(status: JobStatus): [JobFeedItem!]!     # Phase 2
    myApplications: [Application!]!                 # Phase 4
  }

  # ────────────────────────────────────────────────
  # Mutations
  # ────────────────────────────────────────────────

  type Mutation {
    # ── Auth (public) ──────────────────────────
    register(email: String!, password: String!): AuthPayload!
    login(email: String!, password: String!): AuthPayload!

    # ── Profile (auth required) ────────────────
    updateProfile(input: UpdateProfileInput!): Profile!

    # ── Search Config (Phase 1) ───────────────
    createSearchConfig(input: CreateSearchConfigInput!): SearchConfig!
    updateSearchConfig(id: ID!, input: UpdateSearchConfigInput!): SearchConfig!
    deleteSearchConfig(id: ID!): Boolean!

    # ── Job Feed (Phase 2) ─────────────────────
    approveJob(jobFeedId: ID!): Application!
    rejectJob(jobFeedId: ID!): JobFeedItem!

    # ── Kanban (Phase 4) ──────────────────────
    moveCard(applicationId: ID!, newStatus: ApplicationStatus!): Application!
    addNote(applicationId: ID!, note: String!): Application!
    rateApplication(applicationId: ID!, rating: Int!): Application!
  }
`;
