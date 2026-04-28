## 1. Vision Globale

L'application fonctionne comme un entonnoir intelligent.

1. **Acquisition :** Automatique (Cron/Scraping) ou Manuelle.
2. **Tri (Inbox) :** Une zone tampon où l'utilisateur "Approuve" ou "Rejette" les opportunités trouvées.
3. **Enrichissement (AI) :** Une fois approuvée, l'offre est traitée par l'IA (coûteux, donc uniquement sur les offres pertinentes).
4. **Action (Suivi) :** Le CRM de candidature.

## 2. Stack Technologique (Mise à jour)

| **Composant** | **Technologie** | **Justification** |
| --- | --- | --- |
| **API Gateway** | **Node.js (Apollo Server)** | Point d'entrée GraphQL + **Endpoint SSE** pour les notifs. |
| **CV Parser** | **Python (PyResparser / Spacy)** | Extraction structurée des données depuis un PDF uploadé. |
| **Notifications** | **Server-Sent Events (SSE)** | Remplaçant des WebSockets. Plus léger pour du "Server-to-Client". |
| **Job Scheduler** | **Temporal.io** ou **Cron job distribué** | Orchestration des scans quotidiens fiables. |
| **Services Backend** | **Go** (Core/Track) & **Python** (AI/Scrape) | Performance vs Ecosystème Data. |
| **Communication** | **gRPC** (Inter-service) & **Redis Pub/Sub** | Rapidité et découplage asynchrone. |

---

## 3. Architecture des Microservices

### A. API Gateway (BFF)

- **Endpoint GraphQL :** Pour toutes les actions CRUD (Login, Update Profile, ApproveJob, MoveCard).
- **Endpoint SSE (`/events`) :** Le client s'y connecte pour écouter les mises à jour ("Scan terminé", "Analyse prête").

### B. User & Profile Service (Le Dossier Candidat)

- **Rôle :** Gère l'identité et le profil étendu.
- **Feature clé : CV Parsing.** Lorsqu'un utilisateur upload un PDF, ce service extrait automatiquement les "Compétences", "Education", "Expérience" pour pré-remplir le formulaire.
- **Données :** Stocke aussi les **"Search Preferences"** (Localisation, Salaire cible, Mots-clés Red Flags, Template de lettre).

### C. Discovery Service (Le Chasseur de Têtes)

- **Rôle :** C'est le moteur de recherche.
- **Fonctionnement "Daily Batch" :**
    1. Chaque nuit (ou fréquence définie), il récupère les `SearchPreferences` actives.
    2. Il lance les scrapers sur les job boards ciblés.
    3. **Filtrage "Red Flag" :** Il applique *immédiatement* les exclusions (ex: si "ESN" est un red flag, l'offre est jetée avant même d'être montrée).
    4. Il insère les offres restantes dans une table `SuggestedJobs` (La "Waiting List").
- **Gestion manuelle :** Si l'utilisateur ajoute une URL, ce service la scrape immédiatement (Priorité haute).

### D. AI Coach Service (L'Analyste)

- **Trigger :** Ne se déclenche que lorsque l'utilisateur **APPROUVE** une offre ou l'ajoute manuellement.
- **Actions :**
    1. Récupère le Profil Complet + L'Offre.
    2. Génère le `MatchScore`.
    3. Génère `Pros/Cons` (Points forts/Attention).
    4. **Rédige :** Une suggestion de "Contenu CV adapté" et la "Lettre de motivation" basée sur le template utilisateur.

### E. Tracker Service (Le Kanban)

- **Rôle :** Gère le cycle de vie une fois l'offre approuvée.
- **Logique :** C'est la source de vérité du Dashboard "Mes Candidatures". Il gère les statuts (To Apply -> Applied -> Interview -> Hired).

---

## 4. Schéma de Données (PostgreSQL)

Voici la structure relationnelle adaptée à ton flow :

1. **Users** (`id`, email, password_hash)
2. **Profiles** (`user_id`, full_name, status, skills_json, experience_json, projects_json, education_json).
3. **SearchConfig** (Une recherche enregistrée)
    - `id`, `user_id`
    - `keywords` (Array), `red_flags` (Array)
    - `target_salary`, `remote_policy`, `location`.
    - `cl_template_text`.
4. **JobFeed** (La file d'attente "En attente d'approbation")
    - `id`, `search_config_id`
    - `raw_data` (JSON: titre, boite, desc...), `source_url`.
    - `status`: `PENDING` | `APPROVED` | `REJECTED`.
    - *Note : Cette table est nettoyée régulièrement (TTL).*
5. **Applications** (Les candidatures actives - après approbation)
    - `id`, `user_id`, `job_feed_id` (lien vers l'offre originale).
    - `current_status` (TO_APPLY, APPLIED, INTERVIEW, OFFER, REJECTED, HIRED).
    - `ai_analysis` (JSON: Score, Pros, Cons, Suggested_CV_Content).
    - `generated_cover_letter` (Text).
    - `user_notes` (Text), `user_rating` (1-5 stars).
    - `history_log` (JSON: dates des changements de statut).

---

## 5. Le Flow Technique Détaillé (Step-by-Step)

### Phase 1 : Setup & Recherche

1. **Upload CV :** `POST /upload-cv` -> Gateway -> **Profile Service**. Le parser extrait le texte, le transforme en JSON. Le front affiche le formulaire pré-rempli, l'utilisateur valide.
2. **Config Recherche :** L'utilisateur crée une `SearchConfig` (ex: "Dev React, Remote, Pas de ESN, Min 50k").

### Phase 2 : Le Scan Quotidien (Back-office)

1. **Scheduler :** Déclenche le **Discovery Service**.
2. **Scraping :** Récupère 100 offres.
3. **Filtrage 1 :** Élimine 40 offres contenant les mots-clés "Red Flags".
4. **Stockage :** Sauvegarde 60 offres dans `JobFeed` avec statut `PENDING`.
5. **Notif :** Envoie un event SSE `NEW_SUGGESTIONS` (optionnel, ou juste visible à la prochaine connexion).

### Phase 3 : Le Dashboard & Approbation (Action Utilisateur)

1. **User :** Voit 60 offres dans son "Inbox".
2. **Action :** Clique sur "Approuver" sur une offre intéressante.
3. **Gateway :**
    - Change le statut dans `JobFeed` à `APPROVED`.
    - Crée une entrée dans `Applications`.
    - Envoie un message `CMD_ANALYZE_JOB` dans **Redis Pub/Sub**.
4. **AI Coach (Worker) :**
    - Reçoit le message. Fait le matching (Profil vs Offre). Génère la lettre.
    - Met à jour `Applications` avec les résultats.
    - Publie `EVENT_ANALYSIS_DONE` dans Redis.
5. **Gateway (SSE) :**
    - Reçoit l'event. Pousse la donnée au client via la connexion SSE ouverte : *"{ type: 'JOB_UPDATED', applicationId: '123', status: 'READY' }"*.
6. **Frontend :** La carte de la candidature se met à jour instantanément avec le Score et la Lettre générée.

### Phase 4 : Candidature & Suivi

1. **User :** Utilise la lettre générée, postule sur le site externe.
2. **User :** Revient sur JobMate, clique "J'ai postulé".
3. **Tracker Service :** Update `status` = `APPLIED`. Déplace la carte dans la colonne correspondante.
4. **Fin de jeu :** Si status = `HIRED`, marque la `SearchConfig` comme `ARCHIVED`.

```Mermaid
graph TD
    %% --- CLIENT SIDE ---
    subgraph Frontend ["Frontend"]
        WEB["Web App (Next.js)"]
        MOB["Mobile App (React Native)"]
    end

    %% --- EDGE LAYER ---
    subgraph Edge ["Edge / Gateway"]
        GW["API Gateway<br/>Apollo GraphQL"]
        SSE["SSE Handler<br/>Server-Sent Events"]
    end

    %% --- DATA BUS ---
    REDIS_MSG(("Redis Pub/Sub"))
    REDIS_CACHE(("Redis Cache"))

    %% --- DOMAIN SERVICES ---
    subgraph Services ["Microservices Cluster"]
        PROF["Profile Service<br/>+ CV Parser (Python)"]
        DISC["Discovery Service<br/>+ Scheduler (Python)"]
        AI["AI Coach Service<br/>LLM + RAG (Python)"]
        TRACK["Tracker Service<br/>Core Logic (Go)"]
    end

    %% --- STORAGE ---
    subgraph Persistence ["Persistence"]
        DB_USER[("Table Users & Profiles")]
        DB_JOBS[("Table Jobs & Feeds")]
        DB_APP[("Table Applications")]
    end

    %% CONNECTIONS CLIENT
    WEB & MOB -- "Query/Mutation" --> GW
    WEB & MOB -- "Subscribe /events" --> SSE
    GW -- "Push Events" --> SSE

    %% CONNECTIONS GATEWAY TO SERVICES (gRPC)
    GW -- "gRPC" --> PROF
    GW -- "gRPC" --> TRACK
    GW -- "gRPC" --> DISC

    %% ASYNC EVENTS (The Intelligence Loop)
    TRACK -- "Pub: JobApproved" --> REDIS_MSG
    REDIS_MSG -- "Sub" --> AI
    AI -- "Pub: AnalysisComplete" --> REDIS_MSG
    REDIS_MSG -- "Sub" --> SSE
    
    %% DISCOVERY LOOP (Background)
    DISC -- "Scheduled Scan" --> DB_JOBS
    DISC -- "Filter RedFlags" --> DB_JOBS
    
    %% DATA ACCESS
    PROF --> DB_USER
    TRACK --> DB_APP
    DISC --> DB_JOBS
    AI --> DB_USER & DB_JOBS & DB_APP

    %% MANUAL ADD FLOW
    GW -- "Add URL" --> DISC
    DISC -- "Pub: JobScraped" --> REDIS_MSG
    REDIS_MSG -- "Sub" --> TRACK
```