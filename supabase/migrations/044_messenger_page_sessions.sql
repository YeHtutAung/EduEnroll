-- Temporary table for multi-page OAuth selection
-- Rows expire after 10 minutes and are cleaned up on select

CREATE TABLE IF NOT EXISTS messenger_page_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL,
  tenant_slug text NOT NULL,
  page_id     text NOT NULL,
  page_name   text NOT NULL,
  page_token_encrypted text NOT NULL,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Index for fast lookup by session_id
CREATE INDEX idx_messenger_page_sessions_session ON messenger_page_sessions(session_id);

-- RLS: service role only (no public access)
ALTER TABLE messenger_page_sessions ENABLE ROW LEVEL SECURITY;
