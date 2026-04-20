-- ─── 073: drop tenant_agents ──────────────────────────────────────────────────
-- Per-user agent keys are replaced by HMAC-SHA256 agent auth (mirrors Messenger's
-- X-Hub-Signature-256 approach). The KuuNyi bot service is the trusted party —
-- it signs every request with AGENT_SECRET. Individual agent keys are no longer
-- needed. Access control is still enforced via tenant_telegram_configs.allowed_chat_ids.
--
-- payments.verified_by_agent (bigint chat_id) is kept for audit purposes.

DROP TABLE IF EXISTS public.tenant_agents;
