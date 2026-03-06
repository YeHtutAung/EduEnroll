-- Add Messenger bot configuration to tenants
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS messenger_enabled BOOLEAN DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS messenger_page_id TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS messenger_page_token TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS messenger_verify_token TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS messenger_greeting TEXT;
