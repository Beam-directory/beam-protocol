import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import type { Database as DB } from 'better-sqlite3'
import type {
  AgentIntentStats,
  AgentKeyRow,
  AgentRow,
  AuditLogRow,
  BusinessVerificationRow,
  DelegationRow,
  DomainVerificationRow,
  DirectoryRoleRow,
  DnsCacheRow,
  FederatedAgentRow,
  FunnelEventRow,
  FederatedTrustRow,
  IntentFrame,
  IntentLogRow,
  IntentTraceEventRow,
  OperatorNotificationRow,
  OrgAgentRow,
  OrgRow,
  ReportRow,
  RegisterRequest,
  ShieldAuditLogRow,
  TrustScoreRow,
  VerificationTier,
  WorkspaceIdentityBindingRow,
  WorkspacePartnerChannelRow,
  WorkspacePolicy,
  WorkspacePolicyRow,
  WorkspaceRow,
  WorkspaceThreadParticipantRow,
  WorkspaceThreadRow,
} from './types.js'
import { generateDIDDocument, generateDIDDocumentWithKeys, toBeamDID, type DIDDocument } from './did.js'
import {
  assertIntentLifecycleTransition,
  classifyIntentLifecycle,
  isIntentLifecycleFailure,
  isIntentLifecycleSuccess,
  normalizeIntentLifecycleStatus,
  normalizeLegacyTraceLifecycle,
  type IntentLifecycleStatus,
} from './intent-lifecycle.js'
import {
  parsePublicEndpointShieldPolicy,
  type PublicEndpointShieldPolicy,
} from './shield/policies.js'
import { mergeWorkspacePolicy, parseWorkspacePolicy } from './workspace-policy.js'

const BEAM_DOMAIN_SUFFIX = 'beam.directory'
const PUBLIC_ENDPOINT_POLICY_KEY = 'public-endpoints'

export function createDatabase(dbPath = process.env.DB_PATH || './beam-directory.db'): DB {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  initSchema(db)
  return db
}

function initSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orgs (
      name TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      domain TEXT,
      beam_domain TEXT NOT NULL UNIQUE,
      api_key_hash TEXT NOT NULL,
      verification_token TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      verified_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_orgs_domain ON orgs(domain);
    CREATE INDEX IF NOT EXISTS idx_orgs_verified ON orgs(verified, created_at DESC);

    CREATE TABLE IF NOT EXISTS org_agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_name TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      beam_id TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      capabilities TEXT NOT NULL DEFAULT '[]',
      public_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (org_name) REFERENCES orgs(name) ON DELETE CASCADE,
      UNIQUE(org_name, agent_name)
    );

    CREATE INDEX IF NOT EXISTS idx_org_agents_org_name ON org_agents(org_name, agent_name);

    CREATE TABLE IF NOT EXISTS agents (
      beam_id TEXT PRIMARY KEY,
      org TEXT,
      personal INTEGER NOT NULL DEFAULT 0,
      display_name TEXT NOT NULL,
      capabilities TEXT NOT NULL DEFAULT '[]',
      public_key TEXT NOT NULL,
      api_key_hash TEXT,
      email TEXT,
      email_verified INTEGER NOT NULL DEFAULT 0,
      description TEXT,
      logo_url TEXT,
      website TEXT,
      trust_score REAL NOT NULL DEFAULT 0.5,
      verified INTEGER NOT NULL DEFAULT 0,
      verification_tier TEXT NOT NULL DEFAULT 'basic' CHECK(verification_tier IN ('basic', 'verified', 'business', 'enterprise')),
      email_token TEXT,
      created_at TEXT NOT NULL,
      last_seen TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agents_org ON agents(org);
    CREATE INDEX IF NOT EXISTS idx_agents_trust ON agents(trust_score DESC);
    CREATE INDEX IF NOT EXISTS idx_agents_email_verified ON agents(email_verified, trust_score DESC);

    CREATE TABLE IF NOT EXISTS did_documents (
      did TEXT PRIMARY KEY,
      document TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_did_documents_updated_at
      ON did_documents(updated_at DESC);

    CREATE TABLE IF NOT EXISTS nonces (
      nonce TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_nonces_expires ON nonces(expires_at);

    CREATE TABLE IF NOT EXISTS verification_tokens (
      token TEXT PRIMARY KEY,
      beam_id TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (beam_id) REFERENCES agents(beam_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_verification_tokens_beam_id ON verification_tokens(beam_id);
    CREATE INDEX IF NOT EXISTS idx_verification_tokens_expires_at ON verification_tokens(expires_at);

    CREATE TABLE IF NOT EXISTS intent_acls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_beam_id TEXT NOT NULL,
      intent_type TEXT NOT NULL,
      allowed_from TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (target_beam_id) REFERENCES agents(beam_id),
      UNIQUE(target_beam_id, intent_type, allowed_from)
    );

    CREATE INDEX IF NOT EXISTS idx_intent_acls_target_intent
      ON intent_acls(target_beam_id, intent_type);

    CREATE TABLE IF NOT EXISTS waitlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      source TEXT,
      company TEXT,
      agent_count INTEGER,
      workflow_type TEXT,
      workflow_summary TEXT,
      proof_intent_nonce TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      owner TEXT,
      operator_notes TEXT,
      next_action TEXT,
      last_contact_at TEXT,
      blocked_prerequisites TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_waitlist_created_at
      ON waitlist(created_at DESC);

    CREATE TABLE IF NOT EXISTS workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      org_name TEXT,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'archived')),
      default_thread_scope TEXT NOT NULL DEFAULT 'internal' CHECK(default_thread_scope IN ('internal', 'handoff')),
      external_handoffs_enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (org_name) REFERENCES orgs(name) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workspaces_status
      ON workspaces(status, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_workspaces_org_name
      ON workspaces(org_name, updated_at DESC);

    CREATE TABLE IF NOT EXISTS workspace_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      principal_id TEXT NOT NULL,
      principal_type TEXT NOT NULL CHECK(principal_type IN ('human', 'agent', 'service', 'partner')),
      role TEXT NOT NULL CHECK(role IN ('owner', 'operator', 'viewer')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      UNIQUE(workspace_id, principal_id, principal_type)
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace
      ON workspace_members(workspace_id, role, principal_id);

    CREATE TABLE IF NOT EXISTS workspace_identity_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      beam_id TEXT NOT NULL,
      binding_type TEXT NOT NULL CHECK(binding_type IN ('agent', 'service', 'partner')),
      owner TEXT,
      runtime_type TEXT,
      policy_profile TEXT,
      default_thread_scope TEXT NOT NULL DEFAULT 'internal' CHECK(default_thread_scope IN ('internal', 'handoff')),
      can_initiate_external INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused')),
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      UNIQUE(workspace_id, beam_id)
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_identity_bindings_workspace
      ON workspace_identity_bindings(workspace_id, status, beam_id);

    CREATE INDEX IF NOT EXISTS idx_workspace_identity_bindings_beam_id
      ON workspace_identity_bindings(beam_id, status);

    CREATE TABLE IF NOT EXISTS workspace_partner_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      partner_beam_id TEXT NOT NULL,
      label TEXT,
      owner TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'trial', 'blocked')),
      notes TEXT,
      last_success_at TEXT,
      last_failure_at TEXT,
      last_intent_nonce TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      UNIQUE(workspace_id, partner_beam_id)
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_partner_channels_workspace
      ON workspace_partner_channels(workspace_id, status, partner_beam_id);

    CREATE TABLE IF NOT EXISTS workspace_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('internal', 'handoff')),
      title TEXT NOT NULL,
      summary TEXT,
      owner TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'blocked', 'closed')),
      workflow_type TEXT,
      draft_intent_type TEXT,
      draft_payload_json TEXT,
      linked_intent_nonce TEXT,
      last_activity_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (linked_intent_nonce) REFERENCES intent_log(nonce) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_threads_workspace
      ON workspace_threads(workspace_id, status, last_activity_at DESC);

    CREATE INDEX IF NOT EXISTS idx_workspace_threads_nonce
      ON workspace_threads(linked_intent_nonce);

    CREATE TABLE IF NOT EXISTS workspace_thread_participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL,
      principal_id TEXT NOT NULL,
      principal_type TEXT NOT NULL CHECK(principal_type IN ('human', 'agent', 'service', 'partner')),
      display_name TEXT,
      beam_id TEXT,
      workspace_binding_id INTEGER,
      role TEXT NOT NULL DEFAULT 'participant' CHECK(role IN ('owner', 'participant', 'observer', 'approver')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES workspace_threads(id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_binding_id) REFERENCES workspace_identity_bindings(id) ON DELETE SET NULL,
      UNIQUE(thread_id, principal_id, principal_type, role)
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_thread_participants_thread
      ON workspace_thread_participants(thread_id, role, principal_type);

    CREATE TABLE IF NOT EXISTS workspace_policies (
      workspace_id INTEGER PRIMARY KEY,
      policy_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      updated_by TEXT,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS operator_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL CHECK(source_type IN ('beta_request', 'critical_alert')),
      source_key TEXT NOT NULL UNIQUE,
      beta_request_id INTEGER,
      alert_id TEXT,
      severity TEXT NOT NULL CHECK(severity IN ('info', 'warning', 'critical')),
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      href TEXT,
      owner TEXT,
      next_action TEXT,
      status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new', 'acknowledged', 'acted')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      acknowledged_at TEXT,
      acted_at TEXT,
      actor TEXT,
      details_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_operator_notifications_status
      ON operator_notifications(status, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_operator_notifications_source
      ON operator_notifications(source_type, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_operator_notifications_beta_request
      ON operator_notifications(beta_request_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS funnel_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      page_key TEXT NOT NULL,
      event_category TEXT NOT NULL CHECK(event_category IN ('page_view', 'cta_click', 'request', 'demo_milestone')),
      cta_key TEXT,
      target_page TEXT,
      workflow_type TEXT,
      milestone_key TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_funnel_events_created_at
      ON funnel_events(created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_funnel_events_category
      ON funnel_events(event_category, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_funnel_events_session
      ON funnel_events(session_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS intent_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nonce TEXT NOT NULL UNIQUE,
      from_beam_id TEXT NOT NULL,
      to_beam_id TEXT NOT NULL,
      intent_type TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      completed_at TEXT,
      round_trip_latency_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'received',
      error_code TEXT,
      result_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_intent_log_requested_at
      ON intent_log(requested_at DESC);

    CREATE INDEX IF NOT EXISTS idx_intent_log_from_to
      ON intent_log(from_beam_id, to_beam_id);

    CREATE TABLE IF NOT EXISTS intent_trace_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nonce TEXT NOT NULL,
      from_beam_id TEXT NOT NULL,
      to_beam_id TEXT NOT NULL,
      intent_type TEXT NOT NULL,
      stage TEXT NOT NULL,
      status TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      details TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_intent_trace_timestamp
      ON intent_trace_events(timestamp DESC);

    CREATE TABLE IF NOT EXISTS trust_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_beam_id TEXT NOT NULL,
      target_beam_id TEXT NOT NULL,
      score REAL NOT NULL,
      last_updated TEXT NOT NULL,
      FOREIGN KEY (source_beam_id) REFERENCES agents(beam_id),
      FOREIGN KEY (target_beam_id) REFERENCES agents(beam_id),
      UNIQUE(source_beam_id, target_beam_id)
    );

    CREATE INDEX IF NOT EXISTS idx_trust_scores_updated
      ON trust_scores(last_updated DESC);

    CREATE TABLE IF NOT EXISTS federation_peers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      directory_url TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      trust_level REAL NOT NULL DEFAULT 0.5,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      last_seen TEXT,
      synced_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_federation_peers_status
      ON federation_peers(status, trust_level DESC);

    CREATE TABLE IF NOT EXISTS federated_agents (
      beam_id TEXT PRIMARY KEY,
      home_directory_url TEXT NOT NULL,
      cached_document TEXT NOT NULL,
      cached_at TEXT NOT NULL,
      ttl INTEGER NOT NULL DEFAULT 300
    );

    CREATE INDEX IF NOT EXISTS idx_federated_agents_home
      ON federated_agents(home_directory_url, cached_at DESC);

    CREATE TABLE IF NOT EXISTS directory_roles (
      user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'operator', 'viewer')),
      directory_url TEXT NOT NULL,
      PRIMARY KEY (user_id, directory_url)
    );

    CREATE INDEX IF NOT EXISTS idx_directory_roles_role
      ON directory_roles(role, directory_url);

    CREATE TABLE IF NOT EXISTS admin_magic_links (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'operator', 'viewer')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_admin_magic_links_email
      ON admin_magic_links(email, created_at DESC);

    CREATE TABLE IF NOT EXISTS admin_sessions (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'operator', 'viewer')),
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_admin_sessions_email
      ON admin_sessions(email, created_at DESC);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      target TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      details TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp
      ON audit_log(timestamp DESC);

    CREATE TABLE IF NOT EXISTS dns_cache (
      cache_key TEXT PRIMARY KEY,
      record_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      cached_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_dns_cache_expires
      ON dns_cache(expires_at);

    CREATE TABLE IF NOT EXISTS federated_trust (
      beam_id TEXT NOT NULL,
      source_directory_url TEXT NOT NULL,
      origin_directory_url TEXT NOT NULL,
      asserted_trust REAL NOT NULL,
      effective_trust REAL NOT NULL,
      hop_count INTEGER NOT NULL DEFAULT 1,
      asserted_at TEXT NOT NULL,
      PRIMARY KEY (beam_id, source_directory_url, origin_directory_url)
    );

    CREATE INDEX IF NOT EXISTS idx_federated_trust_lookup
      ON federated_trust(beam_id, asserted_at DESC, effective_trust DESC);

    CREATE TABLE IF NOT EXISTS agent_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      beam_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER,
      UNIQUE(beam_id, public_key)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_keys_beam_id ON agent_keys(beam_id);

    CREATE TABLE IF NOT EXISTS domain_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      beam_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      challenge_token TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      verified_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_domain_verifications_beam_id ON domain_verifications(beam_id);

    CREATE TABLE IF NOT EXISTS business_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      beam_id TEXT NOT NULL,
      country TEXT NOT NULL,
      registration_number TEXT NOT NULL,
      legal_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      verification_source TEXT,
      source_reference TEXT,
      evidence TEXT,
      created_at TEXT NOT NULL,
      verified_at TEXT,
      FOREIGN KEY (beam_id) REFERENCES agents(beam_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_business_verifications_beam_id
      ON business_verifications(beam_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS delegations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grantor_beam_id TEXT NOT NULL,
      grantee_beam_id TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      expires_at TEXT,
      revoked INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_delegations_grantor ON delegations(grantor_beam_id);
    CREATE INDEX IF NOT EXISTS idx_delegations_grantee ON delegations(grantee_beam_id);

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_beam_id TEXT NOT NULL,
      target_beam_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open'
    );

    CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_beam_id);

    CREATE TABLE IF NOT EXISTS billing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      beam_id TEXT NOT NULL UNIQUE,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      tier TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      current_period_end TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (beam_id) REFERENCES agents(beam_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_billing_beam_id ON billing(beam_id);

    CREATE TABLE IF NOT EXISTS shield_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nonce TEXT,
      timestamp TEXT,
      sender_beam_id TEXT,
      sender_trust REAL,
      intent_type TEXT,
      payload_hash TEXT,
      decision TEXT,
      risk_score REAL,
      response_size INTEGER,
      anomaly_flags TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_shield_audit_sender ON shield_audit_log(sender_beam_id);
    CREATE INDEX IF NOT EXISTS idx_shield_audit_created ON shield_audit_log(created_at);

    CREATE TABLE IF NOT EXISTS shield_policies (
      policy_key TEXT PRIMARY KEY,
      config_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pinned_keys (
      beam_id TEXT NOT NULL,
      pinned_beam_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(beam_id, pinned_beam_id)
    );

    CREATE TABLE IF NOT EXISTS rate_limits (
      rate_key TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 1,
      window_start INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage_metering (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      beam_id TEXT NOT NULL,
      period TEXT NOT NULL,
      intent_count INTEGER NOT NULL DEFAULT 0,
      encrypted_count INTEGER NOT NULL DEFAULT 0,
      direct_count INTEGER NOT NULL DEFAULT 0,
      relayed_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(beam_id, period)
    );
    CREATE INDEX IF NOT EXISTS idx_usage_beam_period ON usage_metering(beam_id, period);
  `)

  ensureColumn(db, 'agents', 'email', 'TEXT')
  ensureColumn(db, 'agents', 'email_verified', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'agents', 'description', 'TEXT')
  ensureColumn(db, 'agents', 'logo_url', 'TEXT')
  ensureColumn(db, 'agents', 'website', 'TEXT')
  ensureColumn(db, 'agents', 'api_key_hash', 'TEXT')
  ensureColumn(db, 'agents', 'email_token', 'TEXT')
  ensureColumn(db, 'agents', 'verification_tier', "TEXT NOT NULL DEFAULT 'basic'")
  ensureColumn(db, 'agents', 'flagged', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'agents', 'visibility', "TEXT NOT NULL DEFAULT 'unlisted'")
  ensureColumn(db, 'agents', 'shield_config', 'TEXT')
  // S4: P2P HTTP direct delivery endpoint
  ensureColumn(db, 'agents', 'http_endpoint', 'TEXT')
  // S5: E2E encryption public key (X25519)
  ensureColumn(db, 'agents', 'dh_public_key', 'TEXT')
  // S3: Billing plan tier
  ensureColumn(db, 'agents', 'plan', "TEXT NOT NULL DEFAULT 'free'")

  // Create indexes that depend on ensureColumn'd columns
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_verification_tier ON agents(verification_tier, trust_score DESC)`)
  ensureColumn(db, 'agents', 'personal', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'waitlist', 'workflow_type', 'TEXT')
  ensureColumn(db, 'waitlist', 'workflow_summary', 'TEXT')
  ensureColumn(db, 'waitlist', 'proof_intent_nonce', 'TEXT')
  ensureColumn(db, 'waitlist', 'status', "TEXT NOT NULL DEFAULT 'new'")
  ensureColumn(db, 'waitlist', 'owner', 'TEXT')
  ensureColumn(db, 'waitlist', 'operator_notes', 'TEXT')
  ensureColumn(db, 'waitlist', 'next_action', 'TEXT')
  ensureColumn(db, 'waitlist', 'last_contact_at', 'TEXT')
  ensureColumn(db, 'waitlist', 'next_meeting_at', 'TEXT')
  ensureColumn(db, 'waitlist', 'reminder_at', 'TEXT')
  ensureColumn(db, 'waitlist', 'blocked_prerequisites', 'TEXT')
  ensureColumn(db, 'waitlist', 'stage_entered_at', 'TEXT')
  ensureColumn(db, 'waitlist', 'updated_at', 'TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS idx_waitlist_status ON waitlist(status, created_at DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_waitlist_owner ON waitlist(owner, created_at DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_waitlist_last_contact ON waitlist(last_contact_at, updated_at DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_waitlist_next_meeting ON waitlist(next_meeting_at, updated_at DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_waitlist_reminder ON waitlist(reminder_at, updated_at DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_waitlist_proof_intent_nonce ON waitlist(proof_intent_nonce)')
  db.prepare(`
    UPDATE waitlist
    SET status = COALESCE(NULLIF(status, ''), 'new'),
        updated_at = COALESCE(NULLIF(updated_at, ''), created_at),
        stage_entered_at = COALESCE(NULLIF(stage_entered_at, ''), NULLIF(updated_at, ''), created_at)
  `).run()
  db.prepare(`
    UPDATE waitlist
    SET last_contact_at = CASE
      WHEN COALESCE(NULLIF(last_contact_at, ''), '') = '' AND status IN ('contacted', 'scheduled', 'active')
        THEN updated_at
      ELSE last_contact_at
    END
  `).run()
  db.exec('CREATE INDEX IF NOT EXISTS idx_operator_notifications_status ON operator_notifications(status, updated_at DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_operator_notifications_source ON operator_notifications(source_type, created_at DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_operator_notifications_beta_request ON operator_notifications(beta_request_id, created_at DESC)')
  ensureColumn(db, 'operator_notifications', 'owner', 'TEXT')
  ensureColumn(db, 'operator_notifications', 'next_action', 'TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS idx_operator_notifications_owner ON operator_notifications(owner, updated_at DESC)')
  db.exec(`CREATE TABLE IF NOT EXISTS funnel_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    origin TEXT NOT NULL,
    page_key TEXT NOT NULL,
    event_category TEXT NOT NULL CHECK(event_category IN ('page_view', 'cta_click', 'request', 'demo_milestone')),
    cta_key TEXT,
    target_page TEXT,
    workflow_type TEXT,
    milestone_key TEXT,
    created_at TEXT NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_funnel_events_created_at ON funnel_events(created_at DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_funnel_events_category ON funnel_events(event_category, created_at DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_funnel_events_session ON funnel_events(session_id, created_at DESC)')
  ensureIntentLogSchema(db)
  ensureColumn(db, 'intent_trace_events', 'nonce', 'TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS idx_intent_trace_nonce ON intent_trace_events(nonce, timestamp ASC, id ASC)')
  ensureColumn(db, 'shield_audit_log', 'nonce', 'TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS idx_shield_audit_nonce ON shield_audit_log(nonce)')
  ensureColumn(db, 'intent_log', 'result_json', 'TEXT')
  ensureColumn(db, 'workspace_threads', 'draft_intent_type', 'TEXT')
  ensureColumn(db, 'workspace_threads', 'draft_payload_json', 'TEXT')

  db.prepare(`
    UPDATE agents
    SET verification_tier = CASE
      WHEN verification_tier IS NULL OR verification_tier = '' OR verification_tier = 'unverified' THEN 'basic'
      ELSE verification_tier
    END
  `).run()

  const backfillKeysCreatedAt = Date.now()
  db.prepare(`
    INSERT OR IGNORE INTO agent_keys (beam_id, public_key, created_at, revoked_at)
    SELECT beam_id, public_key, ?, NULL
    FROM agents
  `).run(backfillKeysCreatedAt)

  migrateIntentLifecycleModel(db)
}

function ensureColumn(db: DB, tableName: string, columnName: string, definition: string): void {
  const columns = getTableColumnNames(db, tableName)
  if (columns.size === 0 || columns.has(columnName)) {
    return
  }

  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`)
}

function getTableColumnNames(db: DB, tableName: string): Set<string> {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  return new Set(columns.map((column) => column.name))
}

function ensureIntentLogSchema(db: DB): void {
  const columns = getTableColumnNames(db, 'intent_log')
  if (columns.size === 0) {
    return
  }

  const foreignKeys = db.prepare(`PRAGMA foreign_key_list(intent_log)`).all() as Array<{ table: string }>
  const needsNonceMigration = !columns.has('nonce')
  const needsForeignKeyMigration = foreignKeys.length > 0
  if (!needsNonceMigration && !needsForeignKeyMigration) {
    return
  }

  db.exec('PRAGMA foreign_keys = OFF')

  try {
    const migrate = db.transaction(() => {
      db.exec('ALTER TABLE intent_log RENAME TO intent_log_legacy')
      db.exec('DROP INDEX IF EXISTS idx_intent_log_requested_at')
      db.exec('DROP INDEX IF EXISTS idx_intent_log_from_to')
      db.exec(`
        CREATE TABLE intent_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          nonce TEXT NOT NULL UNIQUE,
          from_beam_id TEXT NOT NULL,
          to_beam_id TEXT NOT NULL,
          intent_type TEXT NOT NULL,
          requested_at TEXT NOT NULL,
          completed_at TEXT,
          round_trip_latency_ms INTEGER,
          status TEXT NOT NULL DEFAULT 'received',
          error_code TEXT,
          result_json TEXT
        );
      `)
      const legacyRows = db.prepare('SELECT * FROM intent_log_legacy ORDER BY id ASC').all() as Array<Record<string, unknown>>
      const insert = db.prepare(`
        INSERT INTO intent_log (
          id,
          nonce,
          from_beam_id,
          to_beam_id,
          intent_type,
          requested_at,
          completed_at,
          round_trip_latency_ms,
          status,
          error_code,
          result_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      for (const row of legacyRows) {
        const legacyId = typeof row['id'] === 'number' ? row['id'] : null
        const legacyNonce = typeof row['nonce'] === 'string' && row['nonce'].length > 0
          ? row['nonce']
          : `legacy-intent-${legacyId ?? randomBytes(8).toString('hex')}`
        const fromBeamId = typeof row['from_beam_id'] === 'string' ? row['from_beam_id'] : 'unknown@legacy.beam.directory'
        const toBeamId = typeof row['to_beam_id'] === 'string' ? row['to_beam_id'] : 'unknown@legacy.beam.directory'
        const intentType = typeof row['intent_type'] === 'string' ? row['intent_type'] : 'legacy.intent'
        const requestedAt = typeof row['requested_at'] === 'string' ? row['requested_at'] : nowIso()
        const completedAt = typeof row['completed_at'] === 'string' ? row['completed_at'] : null
        const roundTripLatencyMs = typeof row['round_trip_latency_ms'] === 'number' ? row['round_trip_latency_ms'] : null
        const status = typeof row['status'] === 'string' && row['status'].length > 0 ? row['status'] : 'received'
        const errorCode = typeof row['error_code'] === 'string' ? row['error_code'] : null
        const resultJson = typeof row['result_json'] === 'string' ? row['result_json'] : null

        insert.run(
          legacyId,
          legacyNonce,
          fromBeamId,
          toBeamId,
          intentType,
          requestedAt,
          completedAt,
          roundTripLatencyMs,
          status,
          errorCode,
          resultJson,
        )
      }

      db.exec('DROP TABLE intent_log_legacy')
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_intent_log_requested_at
          ON intent_log(requested_at DESC);
      `)
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_intent_log_from_to
          ON intent_log(from_beam_id, to_beam_id);
      `)
    })

    migrate()
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}

function migrateIntentLifecycleModel(db: DB): void {
  db.prepare(`
    UPDATE intent_log
    SET status = CASE
      WHEN status = 'pending' THEN 'received'
      WHEN status = 'success' THEN 'acked'
      WHEN status = 'error' THEN 'failed'
      ELSE status
    END
  `).run()

  const rows = db.prepare(`
    SELECT id, stage, status, details
    FROM intent_trace_events
    ORDER BY id ASC
  `).all() as Array<{ id: number; stage: string; status: string; details: string | null }>

  const update = db.prepare(`
    UPDATE intent_trace_events
    SET stage = ?, status = ?, details = ?
    WHERE id = ?
  `)
  const remove = db.prepare('DELETE FROM intent_trace_events WHERE id = ?')

  const migrate = db.transaction(() => {
    for (const row of rows) {
      const lifecycle = normalizeLegacyTraceLifecycle(row.stage, row.status)
      if (!lifecycle) {
        remove.run(row.id)
        continue
      }

      let details = row.details
      if (row.stage !== lifecycle || row.status !== lifecycle) {
        let parsedDetails: Record<string, unknown> | null = null
        if (row.details) {
          try {
            const parsed = JSON.parse(row.details) as unknown
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              parsedDetails = parsed as Record<string, unknown>
            }
          } catch {
            parsedDetails = null
          }
        }

        details = JSON.stringify({
          ...(parsedDetails ?? {}),
          legacyStage: row.stage,
          legacyStatus: row.status,
        })
      }

      update.run(lifecycle, lifecycle, details, row.id)
    }
  })

  migrate()
}

function nowIso(): string {
  return new Date().toISOString()
}

function nowMs(): number {
  return Date.now()
}

export function buildBeamDomain(orgName: string): string {
  return `${orgName}.${BEAM_DOMAIN_SUFFIX}`
}

export function createOrg(
  db: DB,
  input: {
    name: string
    displayName: string
    domain?: string | null
    apiKeyHash: string
    verificationToken: string
  }
): OrgRow {
  const now = nowIso()
  const beamDomain = buildBeamDomain(input.name)

  db.prepare(`
    INSERT INTO orgs (
      name,
      display_name,
      domain,
      beam_domain,
      api_key_hash,
      verification_token,
      verified,
      created_at,
      verified_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL)
  `).run(
    input.name,
    input.displayName,
    input.domain ?? null,
    beamDomain,
    input.apiKeyHash,
    input.verificationToken,
    now,
  )

  return getOrg(db, input.name) as OrgRow
}

export function getOrg(db: DB, name: string): OrgRow | null {
  const row = db.prepare('SELECT * FROM orgs WHERE name = ?').get(name) as OrgRow | undefined
  return row ?? null
}

function ensureWorkspacePolicyRecord(db: DB, workspaceId: number, updatedAt: string, updatedBy: string | null = null): void {
  db.prepare(`
    INSERT OR IGNORE INTO workspace_policies (workspace_id, policy_json, updated_at, updated_by)
    VALUES (?, '{}', ?, ?)
  `).run(workspaceId, updatedAt, updatedBy)
}

export function createWorkspace(
  db: DB,
  input: {
    slug: string
    name: string
    orgName?: string | null
    description?: string | null
    status?: WorkspaceRow['status']
    defaultThreadScope?: WorkspaceRow['default_thread_scope']
    externalHandoffsEnabled?: boolean
  },
): WorkspaceRow {
  const now = nowIso()

  const result = db.prepare(`
    INSERT INTO workspaces (
      slug,
      name,
      org_name,
      description,
      status,
      default_thread_scope,
      external_handoffs_enabled,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.slug,
    input.name,
    input.orgName ?? null,
    input.description ?? null,
    input.status ?? 'active',
    input.defaultThreadScope ?? 'internal',
    input.externalHandoffsEnabled ? 1 : 0,
    now,
    now,
  )

  const workspace = getWorkspaceById(db, Number(result.lastInsertRowid))
  if (!workspace) {
    throw new Error('Workspace insert succeeded but row was not found')
  }

  ensureWorkspacePolicyRecord(db, workspace.id, now)
  return workspace
}

export function getWorkspaceById(db: DB, id: number): WorkspaceRow | null {
  const row = db.prepare(`
    SELECT *
    FROM workspaces
    WHERE id = ?
    LIMIT 1
  `).get(id) as WorkspaceRow | undefined

  return row ?? null
}

export function getWorkspaceBySlug(db: DB, slug: string): WorkspaceRow | null {
  const row = db.prepare(`
    SELECT *
    FROM workspaces
    WHERE slug = ?
    LIMIT 1
  `).get(slug) as WorkspaceRow | undefined

  return row ?? null
}

export function listWorkspaces(db: DB): WorkspaceRow[] {
  return db.prepare(`
    SELECT *
    FROM workspaces
    ORDER BY datetime(updated_at) DESC, slug ASC
  `).all() as WorkspaceRow[]
}

export function getWorkspaceSummary(
  db: DB,
  workspaceId: number,
): {
  identityCount: number
  externalInitiatorCount: number
  memberCount: number
  partnerChannelCount: number
} {
  const identityCount = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM workspace_identity_bindings
    WHERE workspace_id = ?
  `).get(workspaceId) as { count: number } | undefined)?.count ?? 0

  const externalInitiatorCount = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM workspace_identity_bindings
    WHERE workspace_id = ? AND can_initiate_external = 1 AND status = 'active'
  `).get(workspaceId) as { count: number } | undefined)?.count ?? 0

  const memberCount = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM workspace_members
    WHERE workspace_id = ?
  `).get(workspaceId) as { count: number } | undefined)?.count ?? 0

  const partnerChannelCount = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM workspace_partner_channels
    WHERE workspace_id = ?
  `).get(workspaceId) as { count: number } | undefined)?.count ?? 0

  return {
    identityCount,
    externalInitiatorCount,
    memberCount,
    partnerChannelCount,
  }
}

export function getWorkspacePolicy(db: DB, workspaceId: number): WorkspacePolicyRow | null {
  const row = db.prepare(`
    SELECT *
    FROM workspace_policies
    WHERE workspace_id = ?
    LIMIT 1
  `).get(workspaceId) as WorkspacePolicyRow | undefined

  return row ?? null
}

export function getWorkspaceIdentityBindingById(db: DB, id: number): WorkspaceIdentityBindingRow | null {
  const row = db.prepare(`
    SELECT *
    FROM workspace_identity_bindings
    WHERE id = ?
    LIMIT 1
  `).get(id) as WorkspaceIdentityBindingRow | undefined

  return row ?? null
}

export function getWorkspaceIdentityBindingByBeamId(
  db: DB,
  workspaceId: number,
  beamId: string,
): WorkspaceIdentityBindingRow | null {
  const row = db.prepare(`
    SELECT *
    FROM workspace_identity_bindings
    WHERE workspace_id = ? AND beam_id = ?
    LIMIT 1
  `).get(workspaceId, beamId) as WorkspaceIdentityBindingRow | undefined

  return row ?? null
}

export function listWorkspaceIdentityBindings(db: DB, workspaceId: number): WorkspaceIdentityBindingRow[] {
  return db.prepare(`
    SELECT *
    FROM workspace_identity_bindings
    WHERE workspace_id = ?
    ORDER BY
      CASE status
        WHEN 'active' THEN 0
        ELSE 1
      END ASC,
      COALESCE(owner, '') ASC,
      beam_id ASC
  `).all(workspaceId) as WorkspaceIdentityBindingRow[]
}

export function listWorkspaceIdentityBindingsByBeamId(
  db: DB,
  beamId: string,
  options?: {
    excludeWorkspaceId?: number
  },
): WorkspaceIdentityBindingRow[] {
  const clauses = ['beam_id = ?']
  const params: Array<number | string> = [beamId]

  if (options?.excludeWorkspaceId != null) {
    clauses.push('workspace_id != ?')
    params.push(options.excludeWorkspaceId)
  }

  return db.prepare(`
    SELECT *
    FROM workspace_identity_bindings
    WHERE ${clauses.join(' AND ')}
    ORDER BY
      CASE status
        WHEN 'active' THEN 0
        ELSE 1
      END ASC,
      CASE binding_type
        WHEN 'partner' THEN 1
        ELSE 0
      END ASC,
      workspace_id ASC,
      id ASC
  `).all(...params) as WorkspaceIdentityBindingRow[]
}

export function getWorkspacePartnerChannelById(db: DB, id: number): WorkspacePartnerChannelRow | null {
  const row = db.prepare(`
    SELECT *
    FROM workspace_partner_channels
    WHERE id = ?
    LIMIT 1
  `).get(id) as WorkspacePartnerChannelRow | undefined

  return row ?? null
}

export function getWorkspacePartnerChannelByBeamId(
  db: DB,
  workspaceId: number,
  partnerBeamId: string,
): WorkspacePartnerChannelRow | null {
  const row = db.prepare(`
    SELECT *
    FROM workspace_partner_channels
    WHERE workspace_id = ? AND partner_beam_id = ?
    LIMIT 1
  `).get(workspaceId, partnerBeamId) as WorkspacePartnerChannelRow | undefined

  return row ?? null
}

export function listWorkspacePartnerChannels(db: DB, workspaceId: number): WorkspacePartnerChannelRow[] {
  return db.prepare(`
    SELECT *
    FROM workspace_partner_channels
    WHERE workspace_id = ?
    ORDER BY
      CASE status
        WHEN 'blocked' THEN 0
        WHEN 'trial' THEN 1
        ELSE 2
      END ASC,
      COALESCE(owner, '') ASC,
      COALESCE(label, partner_beam_id) ASC,
      id ASC
  `).all(workspaceId) as WorkspacePartnerChannelRow[]
}

export function createWorkspacePartnerChannel(
  db: DB,
  input: {
    workspaceId: number
    partnerBeamId: string
    label?: string | null
    owner?: string | null
    status?: WorkspacePartnerChannelRow['status']
    notes?: string | null
    lastSuccessAt?: string | null
    lastFailureAt?: string | null
    lastIntentNonce?: string | null
  },
): WorkspacePartnerChannelRow {
  const now = nowIso()
  const result = db.prepare(`
    INSERT INTO workspace_partner_channels (
      workspace_id,
      partner_beam_id,
      label,
      owner,
      status,
      notes,
      last_success_at,
      last_failure_at,
      last_intent_nonce,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.workspaceId,
    input.partnerBeamId,
    input.label ?? null,
    input.owner ?? null,
    input.status ?? 'trial',
    input.notes ?? null,
    input.lastSuccessAt ?? null,
    input.lastFailureAt ?? null,
    input.lastIntentNonce ?? null,
    now,
    now,
  )

  const channel = getWorkspacePartnerChannelById(db, Number(result.lastInsertRowid))
  if (!channel) {
    throw new Error('Workspace partner channel insert succeeded but row was not found')
  }

  return channel
}

export function updateWorkspacePartnerChannel(
  db: DB,
  input: {
    id: number
    label: string | null
    owner: string | null
    status: WorkspacePartnerChannelRow['status']
    notes: string | null
    lastSuccessAt?: string | null
    lastFailureAt?: string | null
    lastIntentNonce?: string | null
  },
): WorkspacePartnerChannelRow | null {
  const existing = getWorkspacePartnerChannelById(db, input.id)
  if (!existing) {
    return null
  }

  const updatedAt = nowIso()
  db.prepare(`
    UPDATE workspace_partner_channels
    SET label = ?,
        owner = ?,
        status = ?,
        notes = ?,
        last_success_at = ?,
        last_failure_at = ?,
        last_intent_nonce = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    input.label,
    input.owner,
    input.status,
    input.notes,
    input.lastSuccessAt === undefined ? existing.last_success_at : input.lastSuccessAt,
    input.lastFailureAt === undefined ? existing.last_failure_at : input.lastFailureAt,
    input.lastIntentNonce === undefined ? existing.last_intent_nonce : input.lastIntentNonce,
    updatedAt,
    input.id,
  )

  return getWorkspacePartnerChannelById(db, input.id)
}

export function createWorkspaceIdentityBinding(
  db: DB,
  input: {
    workspaceId: number
    beamId: string
    bindingType: WorkspaceIdentityBindingRow['binding_type']
    owner?: string | null
    runtimeType?: string | null
    policyProfile?: string | null
    defaultThreadScope?: WorkspaceIdentityBindingRow['default_thread_scope']
    canInitiateExternal?: boolean
    status?: WorkspaceIdentityBindingRow['status']
    notes?: string | null
  },
): WorkspaceIdentityBindingRow {
  const now = nowIso()
  const result = db.prepare(`
    INSERT INTO workspace_identity_bindings (
      workspace_id,
      beam_id,
      binding_type,
      owner,
      runtime_type,
      policy_profile,
      default_thread_scope,
      can_initiate_external,
      status,
      notes,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.workspaceId,
    input.beamId,
    input.bindingType,
    input.owner ?? null,
    input.runtimeType ?? null,
    input.policyProfile ?? null,
    input.defaultThreadScope ?? 'internal',
    input.canInitiateExternal ? 1 : 0,
    input.status ?? 'active',
    input.notes ?? null,
    now,
    now,
  )

  const binding = getWorkspaceIdentityBindingById(db, Number(result.lastInsertRowid))
  if (!binding) {
    throw new Error('Workspace identity binding insert succeeded but row was not found')
  }

  return binding
}

export function updateWorkspaceIdentityBinding(
  db: DB,
  input: {
    id: number
    owner: string | null
    runtimeType: string | null
    policyProfile: string | null
    defaultThreadScope: WorkspaceIdentityBindingRow['default_thread_scope']
    canInitiateExternal: boolean
    status: WorkspaceIdentityBindingRow['status']
    notes: string | null
  },
): WorkspaceIdentityBindingRow | null {
  const updatedAt = nowIso()
  db.prepare(`
    UPDATE workspace_identity_bindings
    SET owner = ?,
        runtime_type = ?,
        policy_profile = ?,
        default_thread_scope = ?,
        can_initiate_external = ?,
        status = ?,
        notes = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    input.owner,
    input.runtimeType,
    input.policyProfile,
    input.defaultThreadScope,
    input.canInitiateExternal ? 1 : 0,
    input.status,
    input.notes,
    updatedAt,
    input.id,
  )

  return getWorkspaceIdentityBindingById(db, input.id)
}

export function getWorkspaceThreadById(db: DB, id: number): WorkspaceThreadRow | null {
  const row = db.prepare(`
    SELECT *
    FROM workspace_threads
    WHERE id = ?
    LIMIT 1
  `).get(id) as WorkspaceThreadRow | undefined

  return row ?? null
}

export function getWorkspaceThreadByLinkedIntentNonce(
  db: DB,
  workspaceId: number,
  linkedIntentNonce: string,
): WorkspaceThreadRow | null {
  const row = db.prepare(`
    SELECT *
    FROM workspace_threads
    WHERE workspace_id = ? AND linked_intent_nonce = ?
    ORDER BY id ASC
    LIMIT 1
  `).get(workspaceId, linkedIntentNonce) as WorkspaceThreadRow | undefined

  return row ?? null
}

export function listWorkspaceThreads(db: DB, workspaceId: number): WorkspaceThreadRow[] {
  return db.prepare(`
    SELECT *
    FROM workspace_threads
    WHERE workspace_id = ?
    ORDER BY datetime(last_activity_at) DESC, id DESC
  `).all(workspaceId) as WorkspaceThreadRow[]
}

export function createWorkspaceThread(
  db: DB,
  input: {
    workspaceId: number
    kind: WorkspaceThreadRow['kind']
    title: string
    summary?: string | null
    owner?: string | null
    status?: WorkspaceThreadRow['status']
    workflowType?: string | null
    draftIntentType?: string | null
    draftPayloadJson?: string | null
    linkedIntentNonce?: string | null
    lastActivityAt?: string
  },
): WorkspaceThreadRow {
  const now = nowIso()
  const result = db.prepare(`
    INSERT INTO workspace_threads (
      workspace_id,
      kind,
      title,
      summary,
      owner,
      status,
      workflow_type,
      draft_intent_type,
      draft_payload_json,
      linked_intent_nonce,
      last_activity_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.workspaceId,
    input.kind,
    input.title,
    input.summary ?? null,
    input.owner ?? null,
    input.status ?? 'open',
    input.workflowType ?? null,
    input.draftIntentType ?? null,
    input.draftPayloadJson ?? null,
    input.linkedIntentNonce ?? null,
    input.lastActivityAt ?? now,
    now,
    now,
  )

  const thread = getWorkspaceThreadById(db, Number(result.lastInsertRowid))
  if (!thread) {
    throw new Error('Workspace thread insert succeeded but row was not found')
  }

  return thread
}

export function updateWorkspaceThread(
  db: DB,
  input: {
    id: number
    title?: string | null
    summary?: string | null
    owner?: string | null
    status?: WorkspaceThreadRow['status']
    workflowType?: string | null
    draftIntentType?: string | null
    draftPayloadJson?: string | null
    linkedIntentNonce?: string | null
    lastActivityAt?: string
  },
): WorkspaceThreadRow | null {
  const existing = getWorkspaceThreadById(db, input.id)
  if (!existing) {
    return null
  }

  const updatedAt = nowIso()
  db.prepare(`
    UPDATE workspace_threads
    SET title = ?,
        summary = ?,
        owner = ?,
        status = ?,
        workflow_type = ?,
        draft_intent_type = ?,
        draft_payload_json = ?,
        linked_intent_nonce = ?,
        last_activity_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    input.title ?? existing.title,
    input.summary === undefined ? existing.summary : input.summary,
    input.owner === undefined ? existing.owner : input.owner,
    input.status ?? existing.status,
    input.workflowType === undefined ? existing.workflow_type : input.workflowType,
    input.draftIntentType === undefined ? existing.draft_intent_type : input.draftIntentType,
    input.draftPayloadJson === undefined ? existing.draft_payload_json : input.draftPayloadJson,
    input.linkedIntentNonce === undefined ? existing.linked_intent_nonce : input.linkedIntentNonce,
    input.lastActivityAt ?? existing.last_activity_at,
    updatedAt,
    input.id,
  )

  return getWorkspaceThreadById(db, input.id)
}

export function listWorkspaceThreadParticipants(db: DB, threadId: number): WorkspaceThreadParticipantRow[] {
  return db.prepare(`
    SELECT *
    FROM workspace_thread_participants
    WHERE thread_id = ?
    ORDER BY
      CASE role
        WHEN 'owner' THEN 0
        WHEN 'approver' THEN 1
        WHEN 'participant' THEN 2
        ELSE 3
      END ASC,
      COALESCE(display_name, principal_id) ASC,
      id ASC
  `).all(threadId) as WorkspaceThreadParticipantRow[]
}

export function createWorkspaceThreadParticipant(
  db: DB,
  input: {
    threadId: number
    principalId: string
    principalType: WorkspaceThreadParticipantRow['principal_type']
    displayName?: string | null
    beamId?: string | null
    workspaceBindingId?: number | null
    role?: WorkspaceThreadParticipantRow['role']
  },
): WorkspaceThreadParticipantRow {
  const now = nowIso()
  const result = db.prepare(`
    INSERT INTO workspace_thread_participants (
      thread_id,
      principal_id,
      principal_type,
      display_name,
      beam_id,
      workspace_binding_id,
      role,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.threadId,
    input.principalId,
    input.principalType,
    input.displayName ?? null,
    input.beamId ?? null,
    input.workspaceBindingId ?? null,
    input.role ?? 'participant',
    now,
    now,
  )

  return db.prepare(`
    SELECT *
    FROM workspace_thread_participants
    WHERE id = ?
  `).get(Number(result.lastInsertRowid)) as WorkspaceThreadParticipantRow
}

export function getWorkspacePolicyDocument(
  db: DB,
  workspaceId: number,
): { policy: WorkspacePolicy; updatedAt: string | null; updatedBy: string | null } {
  const row = getWorkspacePolicy(db, workspaceId)
  return {
    policy: parseWorkspacePolicy(row?.policy_json),
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
  }
}

export function updateWorkspacePolicyDocument(
  db: DB,
  workspaceId: number,
  patch: Partial<WorkspacePolicy>,
  updatedBy: string | null,
): { policy: WorkspacePolicy; updatedAt: string; updatedBy: string | null } {
  const current = getWorkspacePolicyDocument(db, workspaceId).policy
  const merged = mergeWorkspacePolicy(current, patch)
  const updatedAt = nowIso()

  db.prepare(`
    INSERT INTO workspace_policies (workspace_id, policy_json, updated_at, updated_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET
      policy_json = excluded.policy_json,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).run(
    workspaceId,
    JSON.stringify(merged),
    updatedAt,
    updatedBy,
  )

  return {
    policy: merged,
    updatedAt,
    updatedBy,
  }
}

export function listOrgAgents(db: DB, orgName: string): Array<OrgAgentRow & Partial<AgentRow>> {
  return db.prepare(`
    SELECT
      oa.id,
      oa.org_name,
      oa.agent_name,
      oa.beam_id,
      oa.display_name,
      oa.capabilities,
      oa.public_key,
      oa.created_at,
      oa.updated_at,
      a.org,
      a.trust_score,
      a.verified,
      a.verification_tier,
      a.flagged,
      a.last_seen
    FROM org_agents oa
    LEFT JOIN agents a ON a.beam_id = oa.beam_id
    WHERE oa.org_name = ?
    ORDER BY oa.agent_name ASC
  `).all(orgName) as Array<OrgAgentRow & Partial<AgentRow>>
}

export function markOrgVerified(db: DB, name: string): OrgRow | null {
  const now = nowIso()
  db.prepare('UPDATE orgs SET verified = 1, verified_at = ? WHERE name = ?').run(now, name)
  return getOrg(db, name)
}

function orgExists(db: DB, name: string): boolean {
  const row = db.prepare('SELECT 1 FROM orgs WHERE name = ? LIMIT 1').get(name) as { 1: number } | undefined
  return Boolean(row)
}

function extractAgentName(beamId: string): string {
  return beamId.split('@')[0] ?? beamId
}

function syncOrgAgent(db: DB, data: RegisterRequest, createdAt: string): void {
  if (!data.org || data.personal) {
    return
  }

  if (!orgExists(db, data.org)) {
    return
  }

  const now = nowIso()
  db.prepare(`
    INSERT INTO org_agents (
      org_name,
      agent_name,
      beam_id,
      display_name,
      capabilities,
      public_key,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(org_name, agent_name) DO UPDATE SET
      beam_id = excluded.beam_id,
      display_name = excluded.display_name,
      capabilities = excluded.capabilities,
      public_key = excluded.public_key,
      updated_at = excluded.updated_at
  `).run(
    data.org,
    extractAgentName(data.beamId),
    data.beamId,
    data.displayName,
    JSON.stringify(data.capabilities),
    data.publicKey,
    createdAt,
    now,
  )
}

function syncOrgAgentPublicKey(db: DB, beamId: string, publicKey: string): void {
  db.prepare(`
    UPDATE org_agents
    SET public_key = ?, updated_at = ?
    WHERE beam_id = ?
  `).run(publicKey, nowIso(), beamId)
}

function createKeyLifecycleError(code: 'ACTIVE_KEY_REQUIRED' | 'KEY_ALREADY_REVOKED' | 'KEY_NOT_FOUND', message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

function assertKeyCanBecomeActive(db: DB, beamId: string, publicKey: string): void {
  const existing = db.prepare(`
    SELECT revoked_at
    FROM agent_keys
    WHERE beam_id = ? AND public_key = ?
    LIMIT 1
  `).get(beamId, publicKey) as { revoked_at: number | null } | undefined

  if (existing && existing.revoked_at !== null) {
    throw createKeyLifecycleError(
      'KEY_ALREADY_REVOKED',
      `Key ${publicKey.slice(0, 16)}… has already been revoked for ${beamId}`,
    )
  }
}

function ensureAgentKeyRecorded(db: DB, beamId: string, publicKey: string, createdAt: number): void {
  assertKeyCanBecomeActive(db, beamId, publicKey)
  db.prepare(`
    INSERT OR IGNORE INTO agent_keys (beam_id, public_key, created_at, revoked_at)
    VALUES (?, ?, ?, NULL)
  `).run(beamId, publicKey, createdAt)
}

export function listAgentKeys(db: DB, beamId: string): AgentKeyRow[] {
  return db.prepare(`
    SELECT *
    FROM agent_keys
    WHERE beam_id = ?
    ORDER BY CASE WHEN revoked_at IS NULL THEN 0 ELSE 1 END ASC,
             COALESCE(revoked_at, created_at) DESC,
             id DESC
  `).all(beamId) as AgentKeyRow[]
}

export function getActiveAgentKey(db: DB, beamId: string): AgentKeyRow | null {
  const row = db.prepare(`
    SELECT *
    FROM agent_keys
    WHERE beam_id = ? AND revoked_at IS NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(beamId) as AgentKeyRow | undefined

  return row ?? null
}

export function refreshAgentDIDDocument(db: DB, beamId: string): DIDDocument | null {
  const agent = getAgent(db, beamId)
  if (!agent) {
    return null
  }

  const document = generateDIDDocumentWithKeys(agent, listAgentKeys(db, beamId))
  return upsertDIDDocument(db, document)
}

export function registerAgent(db: DB, data: RegisterRequest): AgentRow {
  const now = nowIso()
  const createdAtMs = nowMs()
  const capabilitiesJson = JSON.stringify(data.capabilities)
  const personal = data.personal === true ? 1 : 0

  const existing = getAgent(db, data.beamId)
  if (!existing || existing.public_key !== data.publicKey) {
    assertKeyCanBecomeActive(db, data.beamId, data.publicKey)
  }
  const normalizedEmail = data.email?.trim().toLowerCase() || null
  const emailChanged = normalizedEmail !== (existing?.email ?? null)
  const emailVerified = normalizedEmail
    ? (data.emailVerified ? 1 : emailChanged ? 0 : existing?.email_verified ?? 0)
    : 0
  const verificationTier: VerificationTier = data.verificationTier ?? (emailVerified === 1 ? 'verified' : 'basic')
  const verified = verificationTier !== 'basic' || emailVerified === 1 ? 1 : 0
  const emailToken = normalizedEmail ? (emailChanged ? null : existing?.email_token ?? null) : null

  const visibility = data.visibility ?? existing?.visibility ?? 'unlisted'

  if (existing) {
    db.prepare(`
      UPDATE agents
      SET org = ?,
          personal = ?,
          display_name = ?,
          capabilities = ?,
          public_key = ?,
          api_key_hash = ?,
          email = ?,
          email_verified = ?,
          verification_tier = ?,
          description = ?,
          logo_url = ?,
          verified = ?,
          email_token = ?,
          visibility = ?,
          http_endpoint = ?,
          dh_public_key = ?,
          last_seen = ?
      WHERE beam_id = ?
    `).run(
      data.org ?? null,
      personal,
      data.displayName,
      capabilitiesJson,
      data.publicKey,
      data.apiKeyHash ?? existing?.api_key_hash ?? null,
      normalizedEmail,
      emailVerified,
      verificationTier,
      data.description ?? null,
      data.logoUrl ?? null,
      verified,
      emailToken,
      visibility,
      data.httpEndpoint ?? existing?.http_endpoint ?? null,
      data.dhPublicKey ?? existing?.dh_public_key ?? null,
      now,
      data.beamId,
    )
  } else {
    db.prepare(`
      INSERT INTO agents (
        beam_id,
        org,
        personal,
        display_name,
        capabilities,
        public_key,
        api_key_hash,
        email,
        email_verified,
        description,
        logo_url,
        trust_score,
        verified,
        verification_tier,
        flagged,
        email_token,
        visibility,
        http_endpoint,
        dh_public_key,
        created_at,
        last_seen
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0.3, ?, ?, 0, ?, ?, ?, ?, ?, ?)
    `).run(
      data.beamId,
      data.org ?? null,
      personal,
      data.displayName,
      capabilitiesJson,
      data.publicKey,
      data.apiKeyHash ?? null,
      normalizedEmail,
      emailVerified,
      data.description ?? null,
      data.logoUrl ?? null,
      verified,
      verificationTier,
      emailToken,
      visibility,
      data.httpEndpoint ?? null,
      data.dhPublicKey ?? null,
      now,
      now,
    )
  }

  syncOrgAgent(db, data, existing?.created_at ?? now)
  ensureAgentKeyRecorded(db, data.beamId, data.publicKey, createdAtMs)
  if (existing && existing.public_key !== data.publicKey) {
    db.prepare(`
      UPDATE agent_keys
      SET revoked_at = ?
      WHERE beam_id = ? AND public_key = ? AND revoked_at IS NULL
    `).run(createdAtMs, data.beamId, existing.public_key)
  }

  const score = calculateTrustScore(db, data.beamId)
  db.prepare('UPDATE agents SET trust_score = ? WHERE beam_id = ?').run(score, data.beamId)

  const agent = getAgent(db, data.beamId) as AgentRow
  refreshAgentDIDDocument(db, data.beamId)
  return agent
}

export function getAgent(db: DB, beamId: string): AgentRow | null {
  const row = db.prepare('SELECT * FROM agents WHERE beam_id = ?').get(beamId) as AgentRow | undefined
  return row ?? null
}

export function deleteAgent(db: DB, beamId: string): boolean {
  const existing = getAgent(db, beamId)
  if (!existing) {
    return false
  }

  const remove = db.transaction((targetBeamId: string) => {
    db.prepare('DELETE FROM verification_tokens WHERE beam_id = ?').run(targetBeamId)
    db.prepare('DELETE FROM intent_acls WHERE target_beam_id = ?').run(targetBeamId)
    db.prepare('DELETE FROM trust_scores WHERE source_beam_id = ? OR target_beam_id = ?').run(targetBeamId, targetBeamId)
    db.prepare('DELETE FROM intent_log WHERE from_beam_id = ? OR to_beam_id = ?').run(targetBeamId, targetBeamId)
    db.prepare('DELETE FROM delegations WHERE grantor_beam_id = ? OR grantee_beam_id = ?').run(targetBeamId, targetBeamId)
    db.prepare('DELETE FROM reports WHERE reporter_beam_id = ? OR target_beam_id = ?').run(targetBeamId, targetBeamId)
    db.prepare('DELETE FROM billing WHERE beam_id = ?').run(targetBeamId)
    db.prepare('DELETE FROM business_verifications WHERE beam_id = ?').run(targetBeamId)
    db.prepare('DELETE FROM domain_verifications WHERE beam_id = ?').run(targetBeamId)
    db.prepare('DELETE FROM agent_keys WHERE beam_id = ?').run(targetBeamId)
    db.prepare('DELETE FROM pinned_keys WHERE beam_id = ? OR pinned_beam_id = ?').run(targetBeamId, targetBeamId)
    db.prepare('DELETE FROM usage_metering WHERE beam_id = ?').run(targetBeamId)
    db.prepare('DELETE FROM org_agents WHERE beam_id = ?').run(targetBeamId)
    db.prepare('DELETE FROM did_documents WHERE did = ?').run(toBeamDID(targetBeamId))
    db.prepare('DELETE FROM agents WHERE beam_id = ?').run(targetBeamId)
  })

  remove(beamId)
  return true
}

export function setAgentEmailToken(db: DB, beamId: string, token: string | null): AgentRow | null {
  db.prepare(`
    UPDATE agents
    SET email_token = ?,
        email_verified = CASE WHEN ? IS NULL THEN email_verified ELSE 0 END
    WHERE beam_id = ?
  `).run(token, token, beamId)

  return getAgent(db, beamId)
}

export function updateAgentProfile(
  db: DB,
  beamId: string,
  updates: {
    displayName?: string
    capabilities?: string[]
    email?: string | null
    emailVerified?: boolean
    verificationTier?: VerificationTier
    description?: string | null
    logoUrl?: string | null
    website?: string | null
  },
): AgentRow | null {
  const existing = getAgent(db, beamId)
  if (!existing) {
    return null
  }

  const normalizedEmail = updates.email === undefined
    ? existing.email
    : updates.email?.trim().toLowerCase() || null
  const emailChanged = normalizedEmail !== existing.email
  const emailVerified = normalizedEmail
    ? (updates.emailVerified === true ? 1 : emailChanged ? 0 : existing.email_verified)
    : 0
  const verificationTier = updates.verificationTier ?? existing.verification_tier
  const verified = verificationTier !== 'basic' || emailVerified === 1 ? 1 : 0
  const capabilities = updates.capabilities === undefined ? existing.capabilities : JSON.stringify(updates.capabilities)
  const emailToken = normalizedEmail ? (emailChanged ? null : existing.email_token) : null

  db.prepare(`
    UPDATE agents
    SET display_name = ?,
        capabilities = ?,
        email = ?,
        email_verified = ?,
        verification_tier = ?,
        description = ?,
        logo_url = ?,
        website = ?,
        verified = ?,
        email_token = ?,
        last_seen = ?
    WHERE beam_id = ?
  `).run(
    updates.displayName ?? existing.display_name,
    capabilities,
    normalizedEmail,
    emailVerified,
    verificationTier,
    updates.description === undefined ? existing.description : updates.description,
    updates.logoUrl === undefined ? existing.logo_url : updates.logoUrl,
    updates.website === undefined ? existing.website : updates.website,
    verified,
    emailToken,
    nowIso(),
    beamId,
  )

  const score = calculateTrustScore(db, beamId)
  db.prepare('UPDATE agents SET trust_score = ? WHERE beam_id = ?').run(score, beamId)
  return getAgent(db, beamId)
}

export function createVerificationToken(
  db: DB,
  input: { token?: string; beam_id: string; email: string; expires_at: number },
): { token: string; beam_id: string; email: string; created_at: number; expires_at: number } {
  const token = input.token ?? randomBytes(24).toString('hex')
  const createdAt = nowMs()

  db.prepare('DELETE FROM verification_tokens WHERE beam_id = ?').run(input.beam_id)
  db.prepare(`
    INSERT INTO verification_tokens (token, beam_id, email, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(token, input.beam_id, input.email, createdAt, input.expires_at)

  return {
    token,
    beam_id: input.beam_id,
    email: input.email,
    created_at: createdAt,
    expires_at: input.expires_at,
  }
}

export function verifyAgentEmailToken(db: DB, token: string): AgentRow | null {
  const tokenRow = db.prepare(`
    SELECT token, beam_id, email, expires_at
    FROM verification_tokens
    WHERE token = ?
  `).get(token) as { token: string; beam_id: string; email: string; expires_at: number } | undefined

  if (!tokenRow) {
    return null
  }

  if (tokenRow.expires_at < nowMs()) {
    db.prepare('DELETE FROM verification_tokens WHERE token = ?').run(token)
    return null
  }

  const agent = getAgent(db, tokenRow.beam_id)
  if (!agent || agent.email !== tokenRow.email) {
    db.prepare('DELETE FROM verification_tokens WHERE token = ?').run(token)
    return null
  }

  db.prepare(`
    UPDATE agents
    SET email_verified = 1,
        verified = 1,
        email_token = NULL
    WHERE beam_id = ?
  `).run(tokenRow.beam_id)

  db.prepare('DELETE FROM verification_tokens WHERE token = ?').run(token)
  return getAgent(db, tokenRow.beam_id)
}

export function findAgentByHandle(db: DB, handle: string): AgentRow | null {
  const rows = db.prepare(`
    SELECT *
    FROM agents
    WHERE beam_id = ? OR beam_id GLOB ?
    ORDER BY created_at ASC
    LIMIT 2
  `).all(`${handle}@beam.directory`, `${handle}@*.beam.directory`) as AgentRow[]

  if (rows.length !== 1) {
    return null
  }

  return rows[0] ?? null
}

export function upsertDIDDocument(db: DB, document: DIDDocument): DIDDocument {
  const now = new Date().toISOString()
  const existing = getDIDDocument(db, document.id)
  db.prepare(`
    INSERT INTO did_documents (did, document, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(did) DO UPDATE SET
      document = excluded.document,
      updated_at = excluded.updated_at
  `).run(
    document.id,
    JSON.stringify(document),
    existing?.created ?? now,
    now
  )

  return getDIDDocument(db, document.id) as DIDDocument
}

export function getDIDDocument(db: DB, did: string): DIDDocument | null {
  const row = db.prepare('SELECT document FROM did_documents WHERE did = ?').get(did) as { document: string } | undefined
  if (!row) {
    return null
  }

  return JSON.parse(row.document) as DIDDocument
}

export function getPublicEndpointShieldPolicy(db: DB): { policy: PublicEndpointShieldPolicy; updatedAt: string | null } {
  const row = db.prepare(`
    SELECT config_json, updated_at
    FROM shield_policies
    WHERE policy_key = ?
    LIMIT 1
  `).get(PUBLIC_ENDPOINT_POLICY_KEY) as { config_json: string; updated_at: string } | undefined

  return {
    policy: parsePublicEndpointShieldPolicy(row?.config_json),
    updatedAt: row?.updated_at ?? null,
  }
}

export function updatePublicEndpointShieldPolicy(
  db: DB,
  patch: Partial<PublicEndpointShieldPolicy>,
): { policy: PublicEndpointShieldPolicy; updatedAt: string } {
  const current = getPublicEndpointShieldPolicy(db).policy
  const merged = parsePublicEndpointShieldPolicy(JSON.stringify({ ...current, ...patch }))
  const updatedAt = nowIso()

  db.prepare(`
    INSERT INTO shield_policies (policy_key, config_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(policy_key) DO UPDATE SET
      config_json = excluded.config_json,
      updated_at = excluded.updated_at
  `).run(PUBLIC_ENDPOINT_POLICY_KEY, JSON.stringify(merged), updatedAt)

  return { policy: merged, updatedAt }
}

export interface SearchQuery {
  org?: string
  personal?: boolean
  capabilities?: string[]
  minTrustScore?: number
  verificationTier?: VerificationTier
  verifiedOnly?: boolean
  limit?: number
  offset?: number
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

function buildSearchAgentsWhereClause(query: SearchQuery): { where: string; params: Array<string | number> } {
  const params: Array<string | number> = []
  const conditions: string[] = []

  if (query.personal === true) {
    conditions.push('personal = 1')
  } else if (query.org) {
    conditions.push('org = ?')
    params.push(query.org)
  }

  if (query.minTrustScore !== undefined) {
    conditions.push('trust_score >= ?')
    params.push(query.minTrustScore)
  }

  if (query.verificationTier) {
    conditions.push('verification_tier = ?')
    params.push(query.verificationTier)
  }

  if (query.verifiedOnly) {
    conditions.push('(verified = 1 OR verification_tier != ? OR email_verified = 1)')
    params.push('basic')
  }

  if (query.capabilities && query.capabilities.length > 0) {
    for (const capability of query.capabilities) {
      conditions.push(`capabilities LIKE ? ESCAPE '\\'`)
      params.push(`%"${escapeLikePattern(capability)}"%`)
    }
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  }
}

export function countSearchAgents(db: DB, query: SearchQuery): number {
  const { where, params } = buildSearchAgentsWhereClause(query)
  const row = db.prepare(`SELECT COUNT(*) AS cnt FROM agents ${where}`).get(...params) as { cnt: number }
  return row.cnt
}

export function searchAgents(
  db: DB,
  query: SearchQuery,
): AgentRow[] {
  const { where, params } = buildSearchAgentsWhereClause(query)
  const limit = query.limit !== undefined ? Math.max(1, Math.min(500, query.limit)) : 100
  const offset = query.offset !== undefined ? Math.max(0, query.offset) : 0
  const sql = `SELECT * FROM agents ${where} ORDER BY trust_score DESC, beam_id ASC LIMIT ? OFFSET ?`

  return db.prepare(sql).all(...params, limit, offset) as AgentRow[]
}

export function updateLastSeen(db: DB, beamId: string): void {
  const now = nowIso()
  db.prepare('UPDATE agents SET last_seen = ? WHERE beam_id = ?').run(now, beamId)

  const score = calculateTrustScore(db, beamId)
  db.prepare('UPDATE agents SET trust_score = ? WHERE beam_id = ?').run(score, beamId)
}

export function recordNonce(db: DB, nonce: string): boolean {
  const expiresAt = Date.now() + 5 * 60 * 1000

  try {
    db.prepare('INSERT INTO nonces (nonce, expires_at) VALUES (?, ?)').run(nonce, expiresAt)
    return true
  } catch {
    return false
  }
}

export function cleanExpiredNonces(db: DB): void {
  db.prepare('DELETE FROM nonces WHERE expires_at < ?').run(Date.now())
}

export function calculateTrustScore(db: DB, beamId: string): number {
  const row = getAgent(db, beamId)
  if (!row) return 0.0
  if (row.flagged === 1) return 0.0

  let score = 0.3

  if (row.verified === 1) {
    score += 0.3
  }

  if (row.verification_tier !== 'basic') {
    score += 0.2
  }

  const lastSeen = new Date(row.last_seen).getTime()
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000
  if (lastSeen >= oneDayAgo) {
    score += 0.2
  }

  const createdAt = new Date(row.created_at).getTime()
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  if (createdAt <= sevenDaysAgo) {
    score += 0.2
  }

  return clampScore(score)
}

export function createDomainVerification(
  db: DB,
  input: { beamId: string; domain: string; challengeToken: string },
): DomainVerificationRow {
  const createdAt = nowMs()

  const transaction = db.transaction(() => {
    db.prepare(`
      UPDATE domain_verifications
      SET status = 'superseded'
      WHERE beam_id = ? AND domain = ? AND status = 'pending'
    `).run(input.beamId, input.domain)

    const result = db.prepare(`
      INSERT INTO domain_verifications (beam_id, domain, challenge_token, status, created_at)
      VALUES (?, ?, ?, 'pending', ?)
    `).run(input.beamId, input.domain, input.challengeToken, createdAt)

    return result.lastInsertRowid
  })

  const id = Number(transaction())
  return db.prepare('SELECT * FROM domain_verifications WHERE id = ?').get(id) as DomainVerificationRow
}

export function getLatestDomainVerification(db: DB, beamId: string): DomainVerificationRow | null {
  const row = db.prepare(`
    SELECT *
    FROM domain_verifications
    WHERE beam_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(beamId) as DomainVerificationRow | undefined

  return row ?? null
}

export function updateDomainVerificationStatus(db: DB, id: number, status: string): DomainVerificationRow | null {
  const verifiedAt = status === 'verified' ? nowIso() : null
  db.prepare('UPDATE domain_verifications SET status = ?, verified_at = ? WHERE id = ?').run(status, verifiedAt, id)
  const row = db.prepare('SELECT * FROM domain_verifications WHERE id = ?').get(id) as DomainVerificationRow | undefined
  return row ?? null
}

export function createBusinessVerification(
  db: DB,
  input: {
    beamId: string
    country: string
    registrationNumber: string
    legalName: string
    status?: string
    verificationSource?: string | null
    sourceReference?: string | null
    evidence?: unknown
    verifiedAt?: string | null
  },
): BusinessVerificationRow {
  const createdAt = nowIso()
  const status = input.status ?? 'pending'
  const verifiedAt = input.verifiedAt ?? (status === 'verified' ? createdAt : null)

  const result = db.prepare(`
    INSERT INTO business_verifications (
      beam_id,
      country,
      registration_number,
      legal_name,
      status,
      verification_source,
      source_reference,
      evidence,
      created_at,
      verified_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.beamId,
    input.country,
    input.registrationNumber,
    input.legalName,
    status,
    input.verificationSource ?? null,
    input.sourceReference ?? null,
    input.evidence === undefined ? null : JSON.stringify(input.evidence),
    createdAt,
    verifiedAt,
  )

  return db.prepare('SELECT * FROM business_verifications WHERE id = ?').get(Number(result.lastInsertRowid)) as BusinessVerificationRow
}

export function getLatestBusinessVerification(db: DB, beamId: string): BusinessVerificationRow | null {
  const row = db.prepare(`
    SELECT *
    FROM business_verifications
    WHERE beam_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(beamId) as BusinessVerificationRow | undefined

  return row ?? null
}

export function markAgentBusinessVerified(db: DB, beamId: string): AgentRow | null {
  db.prepare(`
    UPDATE agents
    SET verification_tier = 'business',
        verified = 1,
        flagged = 0,
        last_seen = ?
    WHERE beam_id = ?
  `).run(nowIso(), beamId)

  const score = calculateTrustScore(db, beamId)
  db.prepare('UPDATE agents SET trust_score = ? WHERE beam_id = ?').run(score, beamId)
  return getAgent(db, beamId)
}

export function markAgentDomainVerified(db: DB, beamId: string): AgentRow | null {
  db.prepare(`
    UPDATE agents
    SET verification_tier = 'verified',
        verified = 1,
        flagged = 0
    WHERE beam_id = ?
  `).run(beamId)

  const score = calculateTrustScore(db, beamId)
  db.prepare('UPDATE agents SET trust_score = ? WHERE beam_id = ?').run(score, beamId)
  return getAgent(db, beamId)
}

export function rotateAgentKey(db: DB, beamId: string, newPublicKey: string): AgentRow | null {
  const existing = getAgent(db, beamId)
  if (!existing) {
    return null
  }

  assertKeyCanBecomeActive(db, beamId, newPublicKey)

  const revokedAt = nowMs()
  const transaction = db.transaction(() => {
    db.prepare('UPDATE agents SET public_key = ? WHERE beam_id = ?').run(newPublicKey, beamId)
    db.prepare(`
      UPDATE agent_keys
      SET revoked_at = ?
      WHERE beam_id = ? AND public_key = ? AND revoked_at IS NULL
    `).run(revokedAt, beamId, existing.public_key)
    db.prepare(`
      INSERT OR IGNORE INTO agent_keys (beam_id, public_key, created_at, revoked_at)
      VALUES (?, ?, ?, NULL)
    `).run(beamId, newPublicKey, revokedAt)
    syncOrgAgentPublicKey(db, beamId, newPublicKey)
    refreshAgentDIDDocument(db, beamId)
  })

  transaction()
  return getAgent(db, beamId)
}

export function revokeAgentKey(db: DB, beamId: string, publicKey: string): AgentRow | null {
  const existing = getAgent(db, beamId)
  if (!existing) {
    return null
  }

  if (existing.public_key === publicKey) {
    throw createKeyLifecycleError(
      'ACTIVE_KEY_REQUIRED',
      'The active signing key must be rotated before it can be revoked',
    )
  }

  const key = db.prepare(`
    SELECT *
    FROM agent_keys
    WHERE beam_id = ? AND public_key = ?
    LIMIT 1
  `).get(beamId, publicKey) as AgentKeyRow | undefined

  if (!key) {
    throw createKeyLifecycleError('KEY_NOT_FOUND', `Key ${publicKey.slice(0, 16)}… was not found for ${beamId}`)
  }

  if (key.revoked_at !== null) {
    throw createKeyLifecycleError('KEY_ALREADY_REVOKED', `Key ${publicKey.slice(0, 16)}… has already been revoked`)
  }

  const revokedAt = nowMs()
  const transaction = db.transaction(() => {
    db.prepare(`
      UPDATE agent_keys
      SET revoked_at = ?
      WHERE beam_id = ? AND public_key = ? AND revoked_at IS NULL
    `).run(revokedAt, beamId, publicKey)
    refreshAgentDIDDocument(db, beamId)
  })

  transaction()
  return getAgent(db, beamId)
}

export function listRevokedAgentKeys(db: DB): AgentKeyRow[] {
  return db.prepare(`
    SELECT *
    FROM agent_keys
    WHERE revoked_at IS NOT NULL
    ORDER BY revoked_at DESC, id DESC
  `).all() as AgentKeyRow[]
}

export function createDelegation(
  db: DB,
  input: { grantorBeamId: string; granteeBeamId: string; scope: string; expiresAt: number },
): DelegationRow {
  const createdAt = nowMs()
  const result = db.prepare(`
    INSERT INTO delegations (grantor_beam_id, grantee_beam_id, scope, created_at, expires_at, revoked)
    VALUES (?, ?, ?, ?, ?, 0)
  `).run(input.grantorBeamId, input.granteeBeamId, input.scope, createdAt, input.expiresAt)

  return db.prepare('SELECT * FROM delegations WHERE id = ?').get(Number(result.lastInsertRowid)) as DelegationRow
}

export function listActiveDelegations(db: DB, beamId: string, currentTime = nowMs()): DelegationRow[] {
  return db.prepare(`
    SELECT *
    FROM delegations
    WHERE grantor_beam_id = ?
      AND revoked = 0
      AND expires_at > ?
    ORDER BY created_at DESC, id DESC
  `).all(beamId, currentTime) as DelegationRow[]
}

export function revokeDelegation(db: DB, grantorBeamId: string, id: number): boolean {
  const result = db.prepare(`
    UPDATE delegations
    SET revoked = 1
    WHERE id = ? AND grantor_beam_id = ? AND revoked = 0
  `).run(id, grantorBeamId)

  return result.changes > 0
}

export function hasActiveDelegation(
  db: DB,
  input: { grantorBeamId: string; granteeBeamId: string; scope: string; currentTime?: number },
): boolean {
  const row = db.prepare(`
    SELECT id
    FROM delegations
    WHERE grantor_beam_id = ?
      AND grantee_beam_id = ?
      AND revoked = 0
      AND expires_at > ?
      AND (scope = '*' OR scope = ?)
    LIMIT 1
  `).get(
    input.grantorBeamId,
    input.granteeBeamId,
    input.currentTime ?? nowMs(),
    input.scope,
  ) as { id: number } | undefined

  return Boolean(row)
}

export function createReport(
  db: DB,
  input: { reporterBeamId: string; targetBeamId: string; reason: string },
): ReportRow {
  const createdAt = nowMs()

  const transaction = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO reports (reporter_beam_id, target_beam_id, reason, created_at, status)
      VALUES (?, ?, ?, ?, 'pending')
    `).run(input.reporterBeamId, input.targetBeamId, input.reason, createdAt)

    const pendingCount = getPendingReportCount(db, input.targetBeamId)
    if (pendingCount >= 5) {
      db.prepare(`
        UPDATE agents
        SET flagged = 1,
            trust_score = 0.0
        WHERE beam_id = ?
      `).run(input.targetBeamId)
    }

    return result.lastInsertRowid
  })

  const id = Number(transaction())
  return db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as ReportRow
}

export function getPendingReportCount(db: DB, targetBeamId: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM reports
    WHERE target_beam_id = ? AND status = 'pending'
  `).get(targetBeamId) as { count: number } | undefined

  return row?.count ?? 0
}

export function listReportsForTarget(db: DB, targetBeamId: string): ReportRow[] {
  return db.prepare(`
    SELECT *
    FROM reports
    WHERE target_beam_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(targetBeamId) as ReportRow[]
}

export function logIntentStart(db: DB, frame: IntentFrame): void {
  db.prepare(`
    INSERT INTO intent_log (
      nonce,
      from_beam_id,
      to_beam_id,
      intent_type,
      requested_at,
      status
    ) VALUES (?, ?, ?, ?, ?, 'received')
    ON CONFLICT(nonce) DO UPDATE SET
      from_beam_id = excluded.from_beam_id,
      to_beam_id = excluded.to_beam_id,
      intent_type = excluded.intent_type,
      requested_at = excluded.requested_at,
      status = 'received',
      completed_at = NULL,
      round_trip_latency_ms = NULL,
      error_code = NULL,
      result_json = NULL
  `).run(
    frame.nonce,
    frame.from,
    frame.to,
    frame.intent,
    frame.timestamp,
  )
}

export function setIntentLifecycleStatus(
  db: DB,
  input: {
    nonce: string
    status: IntentLifecycleStatus
    errorCode?: string | null
  },
): void {
  const existing = getIntentLogByNonce(db, input.nonce)
  if (!existing) {
    return
  }

  const current = normalizeIntentLifecycleStatus(existing.status) ?? 'received'
  assertIntentLifecycleTransition(current, input.status, `intent ${input.nonce}`)

  const nextBucket = classifyIntentLifecycle(input.status)
  db.prepare(`
    UPDATE intent_log
    SET status = ?,
        error_code = ?
    WHERE nonce = ?
  `).run(
    input.status,
    nextBucket === 'error' ? (input.errorCode ?? existing.error_code) : null,
    input.nonce,
  )
}

export function finalizeIntentLog(
  db: DB,
  input: {
    nonce: string
    fromBeamId: string
    toBeamId: string
    status: IntentLifecycleStatus
    latencyMs: number | null
    errorCode?: string
    resultJson?: string | null
  },
): void {
  const completedAt = nowIso()
  const existing = getIntentLogByNonce(db, input.nonce)
  const current = normalizeIntentLifecycleStatus(existing?.status) ?? 'received'
  assertIntentLifecycleTransition(current, input.status, `intent ${input.nonce}`)

  writeIntentLogFinalState(db, input, completedAt)
}

export function reconcileIntentLog(
  db: DB,
  input: {
    nonce: string
    fromBeamId: string
    toBeamId: string
    status: IntentLifecycleStatus
    latencyMs: number | null
    errorCode?: string
    resultJson?: string | null
  },
): void {
  const completedAt = nowIso()
  writeIntentLogFinalState(db, input, completedAt)
}

function writeIntentLogFinalState(
  db: DB,
  input: {
    nonce: string
    fromBeamId: string
    toBeamId: string
    status: IntentLifecycleStatus
    latencyMs: number | null
    errorCode?: string
    resultJson?: string | null
  },
  completedAt: string,
): void {

  db.prepare(`
    UPDATE intent_log
    SET completed_at = ?,
        round_trip_latency_ms = ?,
        status = ?,
        error_code = ?,
        result_json = ?
    WHERE nonce = ?
  `).run(
    completedAt,
    input.latencyMs,
    input.status,
    input.errorCode ?? null,
    input.resultJson ?? null,
    input.nonce,
  )

  updatePairTrustScore(db, {
    ...input,
    success: isIntentLifecycleSuccess(input.status),
  })
}

export function listRecentIntentLogs(db: DB, limit = 50): IntentLogRow[] {
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit) || 50))
  return db.prepare(`
    SELECT *
    FROM intent_log
    ORDER BY requested_at DESC
    LIMIT ?
  `).all(safeLimit) as IntentLogRow[]
}

export function listInFlightIntentLogs(db: DB): IntentLogRow[] {
  return db.prepare(`
    SELECT *
    FROM intent_log
    WHERE status IN ('received', 'validated', 'queued', 'dispatched', 'delivered')
    ORDER BY requested_at ASC, id ASC
  `).all() as IntentLogRow[]
}

export function getIntentLogByNonce(db: DB, nonce: string): IntentLogRow | null {
  const row = db.prepare(`
    SELECT *
    FROM intent_log
    WHERE nonce = ?
    LIMIT 1
  `).get(nonce) as IntentLogRow | undefined

  return row ?? null
}

export function getLatestIntentTraceEvent(db: DB, nonce: string): IntentTraceEventRow | null {
  const row = db.prepare(`
    SELECT *
    FROM intent_trace_events
    WHERE nonce = ?
    ORDER BY timestamp DESC, id DESC
    LIMIT 1
  `).get(nonce) as IntentTraceEventRow | undefined

  return row ?? null
}

export function appendIntentTraceEvent(
  db: DB,
  input: {
    nonce: string
    fromBeamId: string
    toBeamId: string
    intentType: string
    stage: IntentLifecycleStatus
    status?: IntentLifecycleStatus
    timestamp?: string
    details?: unknown
  },
): IntentTraceEventRow {
  const timestamp = input.timestamp ?? nowIso()
  const details = input.details === undefined ? null : JSON.stringify(input.details)
  const status = input.status ?? input.stage

  const result = db.prepare(`
    INSERT INTO intent_trace_events (
      nonce,
      from_beam_id,
      to_beam_id,
      intent_type,
      stage,
      status,
      timestamp,
      details
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.nonce,
    input.fromBeamId,
    input.toBeamId,
    input.intentType,
    input.stage,
    status,
    timestamp,
    details,
  )

  return db.prepare('SELECT * FROM intent_trace_events WHERE id = ?').get(Number(result.lastInsertRowid)) as IntentTraceEventRow
}

export function listIntentTraceEvents(db: DB, nonce: string): IntentTraceEventRow[] {
  return db.prepare(`
    SELECT *
    FROM intent_trace_events
    WHERE nonce = ?
    ORDER BY timestamp ASC, id ASC
  `).all(nonce) as IntentTraceEventRow[]
}

export function getAgentIntentStats(db: DB, beamId: string): AgentIntentStats {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS received,
      SUM(CASE WHEN status = 'acked' THEN 1 ELSE 0 END) AS responded,
      AVG(CASE WHEN status = 'acked' THEN round_trip_latency_ms END) AS avg_response_time_ms
    FROM intent_log
    WHERE to_beam_id = ?
  `).get(beamId) as {
    received: number | null
    responded: number | null
    avg_response_time_ms: number | null
  } | undefined

  return {
    received: row?.received ?? 0,
    responded: row?.responded ?? 0,
    avg_response_time_ms: row?.avg_response_time_ms == null ? null : Math.round(row.avg_response_time_ms),
  }
}

export function getAgentDirectoryStats(db: DB): {
  total_agents: number
  verified_agents: number
  intents_processed: number
  avg_response_time_ms: number | null
} {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total_agents,
      SUM(CASE WHEN verified = 1 OR verification_tier != 'basic' THEN 1 ELSE 0 END) AS verified_agents,
      (
        SELECT COUNT(*)
        FROM intent_log
      ) AS intents_processed,
      (
        SELECT AVG(round_trip_latency_ms)
        FROM intent_log
        WHERE status = 'acked' AND round_trip_latency_ms IS NOT NULL
      ) AS avg_response_time_ms
    FROM agents
  `).get() as {
    total_agents: number | null
    verified_agents: number | null
    intents_processed: number | null
    avg_response_time_ms: number | null
  } | undefined

  return {
    total_agents: row?.total_agents ?? 0,
    verified_agents: row?.verified_agents ?? 0,
    intents_processed: row?.intents_processed ?? 0,
    avg_response_time_ms: row?.avg_response_time_ms == null ? null : Math.round(row.avg_response_time_ms),
  }
}

export function listTrustScores(db: DB): TrustScoreRow[] {
  return db.prepare(`
    SELECT *
    FROM trust_scores
    ORDER BY last_updated DESC, score DESC
  `).all() as TrustScoreRow[]
}

export function upsertFederatedAgentCache(
  db: DB,
  input: {
    beamId: string
    homeDirectoryUrl: string
    document: object
    cachedAt?: string
    ttl?: number
  }
): FederatedAgentRow {
  const cachedAt = input.cachedAt ?? new Date().toISOString()
  const ttl = Math.max(1, Math.trunc(input.ttl ?? 300))

  db.prepare(`
    INSERT INTO federated_agents (beam_id, home_directory_url, cached_document, cached_at, ttl)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(beam_id) DO UPDATE SET
      home_directory_url = excluded.home_directory_url,
      cached_document = excluded.cached_document,
      cached_at = excluded.cached_at,
      ttl = excluded.ttl
  `).run(
    input.beamId,
    input.homeDirectoryUrl,
    JSON.stringify(input.document),
    cachedAt,
    ttl
  )

  return db.prepare('SELECT * FROM federated_agents WHERE beam_id = ?').get(input.beamId) as FederatedAgentRow
}

export function getFederatedAgentCache(db: DB, beamId: string): FederatedAgentRow | null {
  const row = db.prepare('SELECT * FROM federated_agents WHERE beam_id = ?').get(beamId) as FederatedAgentRow | undefined
  return row ?? null
}

export function deleteFederatedAgentCache(db: DB, beamId: string): void {
  db.prepare('DELETE FROM federated_agents WHERE beam_id = ?').run(beamId)
}

export function assignDirectoryRole(
  db: DB,
  input: { userId: string; role: DirectoryRoleRow['role']; directoryUrl: string }
): DirectoryRoleRow {
  db.prepare(`
    INSERT INTO directory_roles (user_id, role, directory_url)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, directory_url) DO UPDATE SET
      role = excluded.role
  `).run(input.userId, input.role, input.directoryUrl)

  return db.prepare(`
    SELECT * FROM directory_roles
    WHERE user_id = ? AND directory_url = ?
  `).get(input.userId, input.directoryUrl) as DirectoryRoleRow
}

export function getDirectoryRole(db: DB, userId: string, directoryUrl: string): DirectoryRoleRow | null {
  const row = db.prepare(`
    SELECT * FROM directory_roles
    WHERE user_id = ? AND directory_url = ?
  `).get(userId, directoryUrl) as DirectoryRoleRow | undefined

  return row ?? null
}

export function listDirectoryRoles(
  db: DB,
  directoryUrl: string,
): DirectoryRoleRow[] {
  return db.prepare(`
    SELECT *
    FROM directory_roles
    WHERE directory_url = ?
    ORDER BY
      CASE role
        WHEN 'admin' THEN 0
        WHEN 'operator' THEN 1
        ELSE 2
      END,
      user_id ASC
  `).all(directoryUrl) as DirectoryRoleRow[]
}

export function deleteDirectoryRole(
  db: DB,
  input: { userId: string; directoryUrl: string }
): boolean {
  const result = db.prepare(`
    DELETE FROM directory_roles
    WHERE user_id = ? AND directory_url = ?
  `).run(input.userId, input.directoryUrl)

  return result.changes > 0
}

export function logAuditEvent(
  db: DB,
  input: { action: string; actor: string; target: string; details?: unknown; timestamp?: string }
): AuditLogRow {
  const timestamp = input.timestamp ?? new Date().toISOString()
  const details = input.details === undefined ? null : JSON.stringify(input.details)

  const result = db.prepare(`
    INSERT INTO audit_log (action, actor, target, timestamp, details)
    VALUES (?, ?, ?, ?, ?)
  `).run(input.action, input.actor, input.target, timestamp, details)

  return db.prepare('SELECT * FROM audit_log WHERE id = ?').get(Number(result.lastInsertRowid)) as AuditLogRow
}

export function listAuditLog(
  db: DB,
  query: { limit?: number; action?: string; actor?: string; target?: string } = {}
): AuditLogRow[] {
  const limit = Math.max(1, Math.min(500, Math.trunc(query.limit ?? 100)))
  const conditions: string[] = []
  const params: string[] = []

  if (query.action) {
    conditions.push('action = ?')
    params.push(query.action)
  }

  if (query.actor) {
    conditions.push('actor = ?')
    params.push(query.actor)
  }

  if (query.target) {
    conditions.push('target = ?')
    params.push(query.target)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  return db.prepare(`
    SELECT *
    FROM audit_log
    ${where}
    ORDER BY timestamp DESC, id DESC
    LIMIT ${limit}
  `).all(...params) as AuditLogRow[]
}

export function getOperatorNotificationById(db: DB, id: number): OperatorNotificationRow | null {
  const row = db.prepare(`
    SELECT *
    FROM operator_notifications
    WHERE id = ?
    LIMIT 1
  `).get(id) as OperatorNotificationRow | undefined

  return row ?? null
}

export function getOperatorNotificationBySourceKey(db: DB, sourceKey: string): OperatorNotificationRow | null {
  const row = db.prepare(`
    SELECT *
    FROM operator_notifications
    WHERE source_key = ?
    LIMIT 1
  `).get(sourceKey) as OperatorNotificationRow | undefined

  return row ?? null
}

export function listOperatorNotificationsBySourceKeys(db: DB, sourceKeys: string[]): OperatorNotificationRow[] {
  const uniqueKeys = [...new Set(sourceKeys.map((value) => value.trim()).filter(Boolean))]
  if (uniqueKeys.length === 0) {
    return []
  }

  const placeholders = uniqueKeys.map(() => '?').join(', ')
  return db.prepare(`
    SELECT *
    FROM operator_notifications
    WHERE source_key IN (${placeholders})
    ORDER BY created_at DESC, id DESC
  `).all(...uniqueKeys) as OperatorNotificationRow[]
}

export function listOperatorNotifications(
  db: DB,
  query: {
    limit?: number
    status?: string
    sourceType?: string
    betaRequestId?: number
    q?: string
  } = {},
): OperatorNotificationRow[] {
  const limit = Math.max(1, Math.min(500, Math.trunc(query.limit ?? 100)))
  const conditions: string[] = []
  const params: Array<string | number> = []

  if (query.status) {
    conditions.push('status = ?')
    params.push(query.status)
  }

  if (query.sourceType) {
    conditions.push('source_type = ?')
    params.push(query.sourceType)
  }

  if (query.betaRequestId) {
    conditions.push('beta_request_id = ?')
    params.push(query.betaRequestId)
  }

  if (query.q) {
    const needle = `%${query.q.trim()}%`
    conditions.push(`(
      title LIKE ?
      OR message LIKE ?
      OR COALESCE(actor, '') LIKE ?
      OR COALESCE(owner, '') LIKE ?
      OR COALESCE(next_action, '') LIKE ?
      OR COALESCE(alert_id, '') LIKE ?
      OR COALESCE(source_key, '') LIKE ?
    )`)
    params.push(needle, needle, needle, needle, needle, needle, needle)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  return db.prepare(`
    SELECT *
    FROM operator_notifications
    ${where}
    ORDER BY CASE status
      WHEN 'new' THEN 0
      WHEN 'acknowledged' THEN 1
      WHEN 'acted' THEN 2
      ELSE 3
    END ASC,
    datetime(updated_at) DESC,
    id DESC
    LIMIT ${limit}
  `).all(...params) as OperatorNotificationRow[]
}

export function countOperatorNotifications(
  db: DB,
  query: { status?: string; sourceType?: string } = {},
): number {
  const conditions: string[] = []
  const params: string[] = []

  if (query.status) {
    conditions.push('status = ?')
    params.push(query.status)
  }

  if (query.sourceType) {
    conditions.push('source_type = ?')
    params.push(query.sourceType)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  return (db.prepare(`
    SELECT COUNT(*) AS count
    FROM operator_notifications
    ${where}
  `).get(...params) as { count: number } | undefined)?.count ?? 0
}

export function upsertOperatorNotification(
  db: DB,
  input: {
    sourceType: OperatorNotificationRow['source_type']
    sourceKey: string
    betaRequestId?: number | null
    alertId?: string | null
    severity: OperatorNotificationRow['severity']
    title: string
    message: string
    href?: string | null
    owner?: string | null
    nextAction?: string | null
    defaultNextAction?: string | null
    details?: unknown
    resetStatus?: boolean
  },
): OperatorNotificationRow {
  const now = nowIso()
  const existing = getOperatorNotificationBySourceKey(db, input.sourceKey)
  const details = input.details === undefined ? null : JSON.stringify(input.details)

  if (existing) {
    const nextStatus = input.resetStatus ? 'new' : existing.status
    const acknowledgedAt = input.resetStatus ? null : existing.acknowledged_at
    const actedAt = input.resetStatus ? null : existing.acted_at
    const actor = input.resetStatus ? null : existing.actor

    db.prepare(`
      UPDATE operator_notifications
      SET source_type = ?,
          beta_request_id = ?,
          alert_id = ?,
          severity = ?,
          title = ?,
          message = ?,
          href = ?,
          owner = ?,
          next_action = ?,
          status = ?,
          updated_at = ?,
          acknowledged_at = ?,
          acted_at = ?,
          actor = ?,
          details_json = ?
      WHERE id = ?
    `).run(
      input.sourceType,
      input.betaRequestId ?? existing.beta_request_id,
      input.alertId ?? existing.alert_id,
      input.severity,
      input.title,
      input.message,
      input.href ?? existing.href,
      input.owner ?? existing.owner,
      input.nextAction ?? existing.next_action ?? input.defaultNextAction ?? null,
      nextStatus,
      now,
      acknowledgedAt,
      actedAt,
      actor,
      details,
      existing.id,
    )

    return getOperatorNotificationById(db, existing.id) as OperatorNotificationRow
  }

  const result = db.prepare(`
    INSERT INTO operator_notifications (
      source_type,
      source_key,
      beta_request_id,
      alert_id,
      severity,
      title,
      message,
      href,
      owner,
      next_action,
      status,
      created_at,
      updated_at,
      acknowledged_at,
      acted_at,
      actor,
      details_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, NULL, NULL, NULL, ?)
  `).run(
    input.sourceType,
    input.sourceKey,
    input.betaRequestId ?? null,
    input.alertId ?? null,
    input.severity,
    input.title,
    input.message,
    input.href ?? null,
    input.owner ?? null,
    input.nextAction ?? input.defaultNextAction ?? null,
    now,
    now,
    details,
  )

  return getOperatorNotificationById(db, Number(result.lastInsertRowid)) as OperatorNotificationRow
}

export function updateOperatorNotificationStatus(
  db: DB,
  input: {
    id: number
    status?: OperatorNotificationRow['status']
    actor: string
    owner?: string | null
    nextAction?: string | null
  },
): OperatorNotificationRow | null {
  const existing = getOperatorNotificationById(db, input.id)
  if (!existing) {
    return null
  }

  const now = nowIso()
  const nextStatus = input.status ?? existing.status
  const acknowledgedAt = nextStatus === 'new'
    ? null
    : nextStatus === 'acknowledged'
      ? (existing.acknowledged_at ?? now)
      : (existing.acknowledged_at ?? now)
  const actedAt = nextStatus === 'acted' ? now : null
  const actor = nextStatus === 'new' ? null : input.actor
  const owner = input.owner === undefined ? existing.owner : input.owner
  const nextAction = input.nextAction === undefined ? existing.next_action : input.nextAction

  db.prepare(`
    UPDATE operator_notifications
    SET status = ?,
        owner = ?,
        next_action = ?,
        updated_at = ?,
        acknowledged_at = ?,
        acted_at = ?,
        actor = ?
    WHERE id = ?
  `).run(nextStatus, owner, nextAction, now, acknowledgedAt, actedAt, actor, input.id)

  return getOperatorNotificationById(db, input.id)
}

export function insertFunnelEvent(
  db: DB,
  input: {
    sessionId: string
    origin: string
    pageKey: string
    eventCategory: FunnelEventRow['event_category']
    ctaKey?: string | null
    targetPage?: string | null
    workflowType?: string | null
    milestoneKey?: string | null
    createdAt?: string
  },
): FunnelEventRow {
  const createdAt = input.createdAt ?? nowIso()
  const result = db.prepare(`
    INSERT INTO funnel_events (
      session_id,
      origin,
      page_key,
      event_category,
      cta_key,
      target_page,
      workflow_type,
      milestone_key,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.sessionId,
    input.origin,
    input.pageKey,
    input.eventCategory,
    input.ctaKey ?? null,
    input.targetPage ?? null,
    input.workflowType ?? null,
    input.milestoneKey ?? null,
    createdAt,
  )

  return db.prepare('SELECT * FROM funnel_events WHERE id = ?').get(Number(result.lastInsertRowid)) as FunnelEventRow
}

export function listFunnelEvents(
  db: DB,
  query: {
    since?: string
    limit?: number
    eventCategory?: FunnelEventRow['event_category']
    pageKey?: string
  } = {},
): FunnelEventRow[] {
  const limit = Math.max(1, Math.min(10000, Math.trunc(query.limit ?? 5000)))
  const conditions: string[] = []
  const params: Array<string | number> = []

  if (query.since) {
    conditions.push('created_at >= ?')
    params.push(query.since)
  }

  if (query.eventCategory) {
    conditions.push('event_category = ?')
    params.push(query.eventCategory)
  }

  if (query.pageKey) {
    conditions.push('page_key = ?')
    params.push(query.pageKey)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  return db.prepare(`
    SELECT *
    FROM funnel_events
    ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
  `).all(...params) as FunnelEventRow[]
}

export function listShieldAuditLog(
  db: DB,
  query: { limit?: number; nonce?: string; senderBeamId?: string } = {}
): ShieldAuditLogRow[] {
  const limit = Math.max(1, Math.min(500, Math.trunc(query.limit ?? 100)))
  const conditions: string[] = []
  const params: string[] = []

  if (query.nonce) {
    conditions.push('nonce = ?')
    params.push(query.nonce)
  }

  if (query.senderBeamId) {
    conditions.push('sender_beam_id = ?')
    params.push(query.senderBeamId)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  return db.prepare(`
    SELECT *
    FROM shield_audit_log
    ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
  `).all(...params) as ShieldAuditLogRow[]
}

export function getDnsCache(db: DB, cacheKey: string, recordType: string): DnsCacheRow | null {
  const row = db.prepare(`
    SELECT *
    FROM dns_cache
    WHERE cache_key = ? AND record_type = ? AND expires_at > ?
  `).get(cacheKey, recordType, Date.now()) as DnsCacheRow | undefined

  return row ?? null
}

export function setDnsCache(
  db: DB,
  input: { cacheKey: string; recordType: string; payload: unknown; ttlSeconds: number }
): DnsCacheRow {
  const cachedAt = new Date().toISOString()
  const ttlSeconds = Math.max(1, Math.trunc(input.ttlSeconds))
  const expiresAt = Date.now() + ttlSeconds * 1000

  db.prepare(`
    INSERT INTO dns_cache (cache_key, record_type, payload, expires_at, cached_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      record_type = excluded.record_type,
      payload = excluded.payload,
      expires_at = excluded.expires_at,
      cached_at = excluded.cached_at
  `).run(input.cacheKey, input.recordType, JSON.stringify(input.payload), expiresAt, cachedAt)

  return db.prepare('SELECT * FROM dns_cache WHERE cache_key = ?').get(input.cacheKey) as DnsCacheRow
}

export function cleanExpiredDnsCache(db: DB): void {
  db.prepare('DELETE FROM dns_cache WHERE expires_at <= ?').run(Date.now())
}

export function upsertFederatedTrust(
  db: DB,
  input: {
    beamId: string
    sourceDirectoryUrl: string
    originDirectoryUrl: string
    assertedTrust: number
    effectiveTrust: number
    hopCount: number
    assertedAt?: string
  }
): FederatedTrustRow {
  const assertedAt = input.assertedAt ?? new Date().toISOString()

  db.prepare(`
    INSERT INTO federated_trust (
      beam_id,
      source_directory_url,
      origin_directory_url,
      asserted_trust,
      effective_trust,
      hop_count,
      asserted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(beam_id, source_directory_url, origin_directory_url) DO UPDATE SET
      asserted_trust = excluded.asserted_trust,
      effective_trust = excluded.effective_trust,
      hop_count = excluded.hop_count,
      asserted_at = excluded.asserted_at
  `).run(
    input.beamId,
    input.sourceDirectoryUrl,
    input.originDirectoryUrl,
    input.assertedTrust,
    input.effectiveTrust,
    input.hopCount,
    assertedAt
  )

  return db.prepare(`
    SELECT *
    FROM federated_trust
    WHERE beam_id = ? AND source_directory_url = ? AND origin_directory_url = ?
  `).get(input.beamId, input.sourceDirectoryUrl, input.originDirectoryUrl) as FederatedTrustRow
}

export function listFederatedTrust(db: DB, beamId?: string): FederatedTrustRow[] {
  if (beamId) {
    return db.prepare(`
      SELECT *
      FROM federated_trust
      WHERE beam_id = ?
      ORDER BY asserted_at DESC, effective_trust DESC
    `).all(beamId) as FederatedTrustRow[]
  }

  return db.prepare(`
    SELECT *
    FROM federated_trust
    ORDER BY asserted_at DESC, effective_trust DESC
  `).all() as FederatedTrustRow[]
}

function updatePairTrustScore(
  db: DB,
  input: {
    fromBeamId: string
    toBeamId: string
    success: boolean
    latencyMs: number | null
    errorCode?: string
  },
): void {
  const sender = getAgent(db, input.fromBeamId)
  const recipient = getAgent(db, input.toBeamId)
  if (!sender || !recipient) {
    return
  }

  const existing = db.prepare(`
    SELECT score
    FROM trust_scores
    WHERE source_beam_id = ? AND target_beam_id = ?
  `).get(input.fromBeamId, input.toBeamId) as { score: number } | undefined

  const base = ((sender?.trust_score ?? 0.5) + (recipient?.trust_score ?? 0.5)) / 2
  const latencyPenalty = input.latencyMs === null ? 0 : Math.min(input.latencyMs, 60_000) / 60_000 * 0.15
  const signal = input.success
    ? Math.max(0.55, 0.95 - latencyPenalty)
    : input.errorCode === 'OFFLINE' || input.errorCode === 'TIMEOUT'
      ? 0.3
      : 0.15
  const targetScore = clampScore(base * 0.6 + signal * 0.4)
  const nextScore = clampScore((existing?.score ?? base) * 0.7 + targetScore * 0.3)
  const lastUpdated = nowIso()

  db.prepare(`
    INSERT INTO trust_scores (source_beam_id, target_beam_id, score, last_updated)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(source_beam_id, target_beam_id) DO UPDATE SET
      score = excluded.score,
      last_updated = excluded.last_updated
  `).run(input.fromBeamId, input.toBeamId, nextScore, lastUpdated)
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(1, Math.round(score * 100) / 100))
}
