# 🗄️ Database Documentation — JobMate

PostgreSQL 16 — schéma complet, relations, enums et index.

Source of truth : [`infra/postgres/init.sql`](../jobmate-backend/infra/postgres/init.sql)

---

## 1. Vue d'ensemble des relations

```
users (1) ──────────── (1) profiles
  │
  └──── (1:N) search_configs
                │
                └──── (1:N) job_feed
                              │
  ┌───────────────────────────┘
  │
users (1) ──── (1:N) applications ←── job_feed (FK nullable)
```

---

## 2. Types ENUM

| Nom | Valeurs |
|---|---|
| `job_status` | `PENDING` · `APPROVED` · `REJECTED` |
| `application_status` | `TO_APPLY` · `APPLIED` · `INTERVIEW` · `OFFER` · `REJECTED` · `HIRED` |
| `remote_policy` | `REMOTE` · `HYBRID` · `ON_SITE` |
| `profile_status` | `STUDENT` · `JUNIOR` · `MID` · `SENIOR` · `OPEN_TO_WORK` |

---

## 3. Tables

### `users`

Point d'entrée du système — identité et authentification.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | `UUID` | PK, `DEFAULT uuid_generate_v4()` | Identifiant unique |
| `email` | `VARCHAR(255)` | `UNIQUE NOT NULL` | Email de connexion |
| `password_hash` | `VARCHAR(255)` | `NOT NULL` | Hash bcrypt (12 rounds) |
| `created_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | Date de création |
| `updated_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | Mise à jour automatique via trigger |

---

### `profiles`

Profil étendu du candidat. Relation 1:1 avec `users`. Créé automatiquement à l'inscription.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | `UUID` | PK | — |
| `user_id` | `UUID` | FK → `users(id)` ON DELETE CASCADE, UNIQUE | Un seul profil par user |
| `full_name` | `VARCHAR(255)` | nullable | Nom complet |
| `status` | `profile_status` | nullable | Statut professionnel |
| `skills_json` | `JSONB` | `DEFAULT '[]'` | `[{ "name": "React", "level": "expert" }]` |
| `experience_json` | `JSONB` | `DEFAULT '[]'` | `[{ "title": "...", "company": "...", "duration": "..." }]` |
| `projects_json` | `JSONB` | `DEFAULT '[]'` | `[{ "name": "...", "description": "...", "url": "..." }]` |
| `education_json` | `JSONB` | `DEFAULT '[]'` | `[{ "degree": "...", "school": "...", "year": "..." }]` |
| `certifications_json` | `JSONB` | `DEFAULT '[]'` | `[{ "name": "AWS SAA", "issuer": "Amazon", "year": 2025 }]` |
| `cv_url` | `TEXT` | nullable | Chemin relatif du CV PDF (ex: `/uploads/1234-abc.pdf`) |
| `created_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | — |
| `updated_at` | `TIMESTAMPTZ` | trigger auto | — |

---

### `search_configs`

Recherche d'emploi sauvegardée. Le Discovery Service poll les configs actives (`is_active = TRUE`).

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | `UUID` | PK | — |
| `user_id` | `UUID` | FK → `users(id)` ON DELETE CASCADE | Propriétaire |
| `job_titles` | `TEXT[]` | `DEFAULT '{}'` | Intitulés de postes ciblés (ex: `["Software Engineer"]`) |
| `locations` | `TEXT[]` | `DEFAULT '{}'` | Villes/régions ciblées (ex: `["Paris", "Lyon"]`) |
| `remote_policy` | `remote_policy` | `DEFAULT 'HYBRID'` | Politique télétravail souhaitée |
| `keywords` | `TEXT[]` | `DEFAULT '{}'` | Mots-clés tech incontournables (ex: `["React", "Go"]`) |
| `red_flags` | `TEXT[]` | `DEFAULT '{}'` | Termes éliminatoires stricts (ex: `["ESN", "Stage"]`) |
| `salary_min` | `INT` | nullable | Salaire min annuel (€) |
| `salary_max` | `INT` | nullable | Salaire max annuel (€) |
| `start_date` | `DATE` | nullable | Date de début souhaitée pour le poste |
| `duration` | `VARCHAR(100)` | nullable | Type de contrat ou durée (ex: `"CDI"`, `"Stage 6 mois"`) |
| `cover_letter_template` | `TEXT` | nullable | Modèle de base injecté dans le prompt IA (exposé via GraphQL comme `coverLetterTemplate`) |
| `is_active` | `BOOLEAN` | `DEFAULT TRUE` | Si `FALSE`, plus scrapé ni affiché (soft-delete) |
| `completed_at` | `TIMESTAMPTZ` | nullable | Défini quand une candidature passe à `HIRED` (archivage de la recherche) |
| `created_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | — |
| `updated_at` | `TIMESTAMPTZ` | trigger auto | — |

---

### `job_feed`

File d'attente des offres scrapées. Zone tampon entre le Discovery Service et les candidatures.

> ⚠️ TTL de 30 jours via `expires_at`. Un job cron doit nettoyer les lignes expirées.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | `UUID` | PK | — |
| `user_id` | `UUID` | FK → `users(id)` ON DELETE CASCADE | Propriétaire direct — requis pour les offres ajoutées manuellement (addJobByUrl / addJobManually). Permet à `approveJob` de vérifier la propriété même quand `search_config_id` est NULL. |
| `search_config_id` | `UUID` | FK → `search_configs(id)` ON DELETE SET NULL | Config d'origine (nullable si offre manuelle ou config supprimée) |
| `raw_data` | `JSONB` | `NOT NULL` | Payload complet de l'offre scrapée |
| `source_url` | `TEXT` | nullable, UNIQUE | URL originale (dédoublonnage) — `manual://userId/companyName` pour les ajouts manuels |
| `status` | `job_status` | `DEFAULT 'PENDING'` | Statut de tri |
| `is_manual` | `BOOLEAN` | `DEFAULT FALSE` | `TRUE` = ajouté par l'utilisateur (url ou formulaire) |
| `title` | `VARCHAR(512)` | nullable | Titre du poste (scraping) ou nom de l'entreprise (ajout manuel) — dénormalisé depuis `raw_data` pour les requêtes SQL |
| `description` | `TEXT` | nullable | Description du poste ou profil recherché — dénormalisé depuis `raw_data` |
| `company_name` | `VARCHAR(255)` | nullable | Nom entreprise pour les offres manuelles |
| `company_description` | `TEXT` | nullable | Description entreprise (offre manuelle) |
| `why_us` | `TEXT` | nullable | "Pourquoi nous" (offre manuelle) |
| `expires_at` | `TIMESTAMPTZ` | `DEFAULT NOW() + 30 days` | TTL automatique |
| `created_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | — |

**Structure `raw_data` attendue (offre scrapée) :**
```json
{
  "title": "Senior React Developer",
  "company": "Acme Corp",
  "description": "...",
  "contractType": "CDI",
  "salary": "55k-70k",
  "location": "Paris / Remote",
  "postedAt": "2026-02-20T09:00:00Z"
}
```

**Structure `raw_data` pour une offre manuelle (`is_manual = TRUE`) :**
```json
{
  "company_name": "Acme Corp",
  "company_description": "Scale-up SaaS B2B...",
  "location": "Paris",
  "profile_wanted": "Fullstack senior, maîtrise React + Node.js",
  "start_date": "2026-04-01",
  "duration": "CDI",
  "why_us": "Produit ambitieux, stack moderne"
}
```

---

### `applications`

Candidatures actives — le CRM Kanban. Créée automatiquement quand une offre est `APPROVED`.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | `UUID` | PK | — |
| `user_id` | `UUID` | FK → `users(id)` ON DELETE CASCADE | Propriétaire |
| `job_feed_id` | `UUID` | FK → `job_feed(id)` ON DELETE SET NULL | Offre d'origine (nullable si l'offre expire) |
| `current_status` | `application_status` | `DEFAULT 'TO_APPLY'` | Position dans le Kanban |
| `ai_analysis` | `JSONB` | `DEFAULT '{}'` | Résultat de l'analyse IA |
| `generated_cover_letter` | `TEXT` | nullable | Lettre de motivation générée |
| `user_notes` | `TEXT` | nullable | Notes libres du candidat |
| `user_rating` | `SMALLINT` | `CHECK (1..5)` | Note personnelle (★ 1-5) |
| `relance_reminder_at` | `TIMESTAMPTZ` | nullable | Date de relance planifiée (exposé via GraphQL comme `relanceAt`) |
| `history_log` | `JSONB` | `DEFAULT '[]'` | Audit trail des transitions Kanban |
| `created_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | — |
| `updated_at` | `TIMESTAMPTZ` | trigger auto | — |

**Structure `ai_analysis` :**
```json
{
  "score": 85,
  "pros": ["Maîtrise de React demandée", "Expérience startup pertinente"],
  "cons": ["GraphQL non mentionné dans le profil", "Salaire légèrement en-dessous"],
  "suggested_cv_content": "Reformulation suggérée de l'expérience X..."
}
```

**Structure `history_log` :**
```json
[
  { "from": "TO_APPLY", "to": "APPLIED",   "at": "2026-02-21T10:00:00Z" },
  { "from": "APPLIED",  "to": "INTERVIEW", "at": "2026-02-23T14:30:00Z" }
]
```

---

## 4. Index

| Index | Table | Colonnes | Type |
|---|---|---|---|
| `idx_profiles_user_id` | `profiles` | `user_id` | btree |
| `idx_search_configs_user_id` | `search_configs` | `user_id` | btree |
| `idx_search_configs_active` | `search_configs` | `is_active` | partial (`WHERE is_active = TRUE`) |
| `idx_job_feed_search_config_id` | `job_feed` | `search_config_id` | btree |
| `idx_job_feed_status` | `job_feed` | `status` | btree |
| `idx_job_feed_expires_at` | `job_feed` | `expires_at` | btree |
| `idx_job_feed_title` | `job_feed` | `title` | btree |
| `idx_applications_user_id` | `applications` | `user_id` | btree |
| `idx_applications_current_status` | `applications` | `current_status` | btree |
| `idx_applications_job_feed_id` | `applications` | `job_feed_id` | btree |

---

## 5. Triggers

`trigger_set_updated_at()` — mis à jour automatiquement sur `users`, `profiles`, `search_configs`, `applications` à chaque `UPDATE`.

---

## 6. Extensions PostgreSQL

| Extension | Usage |
|---|---|
| `uuid-ossp` | Génération d'UUID v4 via `uuid_generate_v4()` |
| `pg_trgm` | Recherche ILIKE rapide et similarité sur les colonnes texte |

---

## 7. Migrations

Le fichier `infra/postgres/init.sql` fait foi pour les installations fraîches. Pour les bases existantes, les migrations incrémentales sont dans `infra/postgres/migrations/`.

| Fichier | Description |
|---|---|
| `001_job_feed_add_title_description.sql` | Ajout des colonnes `title` et `description` + index `idx_job_feed_title` sur `job_feed` |

**Appliquer une migration :**
```bash
psql -U postgres -d jobmate -f infra/postgres/migrations/001_job_feed_add_title_description.sql
```

Toutes les migrations sont idempotentes (`IF NOT EXISTS`).
