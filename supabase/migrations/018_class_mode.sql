-- Add online/offline mode to classes (default: offline)
ALTER TABLE classes ADD COLUMN IF NOT EXISTS mode TEXT
  DEFAULT 'offline' CHECK (mode IN ('online', 'offline'));
