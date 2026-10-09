
CREATE TABLE IF NOT EXISTS players (
  id UUID PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'Nigeria 🇳🇬',
  region TEXT NOT NULL DEFAULT 'Global',
  personality TEXT NOT NULL DEFAULT 'Ambitious',
  style TEXT NOT NULL DEFAULT 'Street Luxe',
  money INTEGER NOT NULL DEFAULT 10000,
  fame INTEGER NOT NULL DEFAULT 0,
  followers INTEGER NOT NULL DEFAULT 0,
  day INTEGER NOT NULL DEFAULT 1,
  business_level INTEGER NOT NULL DEFAULT 0,
  business_started BOOLEAN NOT NULL DEFAULT FALSE,
  location TEXT NOT NULL DEFAULT 'Home',
  activity TEXT NOT NULL DEFAULT 'New life started',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS life_events (
  id BIGSERIAL PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS life_events_player_created_idx
ON life_events(player_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGSERIAL PRIMARY KEY,
  player_id UUID REFERENCES players(id) ON DELETE SET NULL,
  player_name TEXT NOT NULL,
  location TEXT NOT NULL,
  message TEXT NOT NULL
    CHECK (char_length(message) BETWEEN 1 AND 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS chat_messages_location_created_idx
ON chat_messages(location, created_at DESC);

