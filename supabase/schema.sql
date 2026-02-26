CREATE TABLE IF NOT EXISTS photos (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL,
  file_id TEXT NOT NULL,
  file_unique_id TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_photos_user_unique UNIQUE (user_id, file_unique_id)
);

CREATE INDEX IF NOT EXISTS idx_photos_user_id
  ON photos(user_id);

CREATE INDEX IF NOT EXISTS idx_photos_user_description
  ON photos(user_id, description);

CREATE TABLE IF NOT EXISTS bot_sessions (
  user_id BIGINT PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'idle',
  pending_photos JSONB NOT NULL DEFAULT '[]'::jsonb,
  gallery_page INTEGER NOT NULL DEFAULT 0,
  gallery_selected INTEGER NOT NULL DEFAULT 0,
  gallery_message_id BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bot_sessions_updated_at
  ON bot_sessions(updated_at);
