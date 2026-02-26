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

  # File upload (graphql-multipart-request-spec)
  scalar Upload

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
    certifications: JSON
    cvUrl: String
  }

  type AuthPayload {
    token: String!
    user: User!
  }

  type CVUploadResult {
    cvUrl: String!
    message: String!
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
    redFlags: [String!]!
    salaryMin: Int
    salaryMax: Int
    isActive: Boolean!
    startDate: String
    duration: String
    coverLetterTemplate: String
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
    jobFeedId: ID
    searchConfigId: ID
    relanceReminderAt: String
    createdAt: String!
    updatedAt: String!
  }

  type ManualJobResult {
    jobFeedId: ID!
    message: String!
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
    certifications: JSON
  }

  input CreateSearchConfigInput {
    jobTitles: [String!]!
    locations: [String!]!
    remotePolicy: RemotePolicy
    keywords: [String!]
    redFlags: [String!]
    salaryMin: Int
    salaryMax: Int
    startDate: String
    duration: String
    coverLetterTemplate: String
  }

  input UpdateSearchConfigInput {
    jobTitles: [String!]
    locations: [String!]
    remotePolicy: RemotePolicy
    keywords: [String!]
    redFlags: [String!]
    salaryMin: Int
    salaryMax: Int
    startDate: String
    duration: String
    coverLetterTemplate: String
  }

  input ManualJobInput {
    searchConfigId: ID
    companyName: String!
    companyDescription: String
    location: String
    profileWanted: String
    startDate: String
    duration: String
    whyUs: String
  }

  # ────────────────────────────────────────────────
  # Queries
  # ────────────────────────────────────────────────

  type Query {
    # Health check (public)
    health: String!

    # Auth-required
    me: User!
    myProfile: Profile!
    mySearchConfigs: [SearchConfig!]!
    myApplications(status: ApplicationStatus): [Application!]!
    jobFeed(status: JobStatus): [JobFeedItem!]!
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

    # ── CV Upload ─────────────────────────────
    uploadCV(file: Upload!): CVUploadResult!

    # ── Job Feed (Phase 2) ─────────────────────
    approveJob(jobFeedId: ID!): Application!
    rejectJob(jobFeedId: ID!): JobFeedItem!

    # ── Kanban (Phase 4) ──────────────────────
    createApplication(jobFeedId: ID): Application!
    deleteApplication(applicationId: ID!): Boolean!
    moveCard(applicationId: ID!, newStatus: ApplicationStatus!): Application!
    addNote(applicationId: ID!, note: String!): Application!
    rateApplication(applicationId: ID!, rating: Int!): Application!
    setRelanceReminder(applicationId: ID!, remindAt: String!): Application!

    # ── Discovery (manual job add) ────────────
    addJobByUrl(searchConfigId: ID, url: String!): ManualJobResult!
    addJobManually(input: ManualJobInput!): ManualJobResult!
    triggerScan: ManualJobResult!

    # ── CV ────────────────────────────────────
    parseCV(cvUrl: String!): Boolean!

    # ── Notifications (Phase 6) ───────────────
    registerPushToken(token: String!): Boolean!
  }
  `;