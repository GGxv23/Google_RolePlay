/*
  # VelvetCore Roleplay Database Schema

  ## Overview
  This migration creates the complete database schema for the VelvetCore roleplay platform,
  enabling persistent storage of characters, chat sessions, messages, lorebooks, and user settings.

  ## New Tables
  
  ### 1. `characters`
  Stores character profiles with all their attributes
  - `id` (uuid, primary key) - Unique character identifier
  - `name` (text) - Character name
  - `tagline` (text) - Short description
  - `description` (text) - Full background and lore
  - `appearance` (text) - Visual description
  - `personality` (text) - Psychological profile
  - `first_message` (text) - Initial greeting
  - `chat_examples` (text) - Example dialogue
  - `avatar_url` (text) - Character avatar URL or base64
  - `scenario` (text) - Current situation
  - `event_sequence` (text) - Narrative/plot sequence
  - `style` (text) - Writing style instructions
  - `jailbreak` (text) - System logic instructions
  - `created_at` (timestamptz) - Creation timestamp
  - `updated_at` (timestamptz) - Last update timestamp
  - `user_id` (text) - Browser fingerprint for ownership

  ### 2. `chat_sessions`
  Stores individual chat sessions linked to characters
  - `id` (uuid, primary key) - Unique session identifier
  - `character_id` (uuid, foreign key) - References characters.id
  - `name` (text) - Session name
  - `summary` (text) - Summarized history for context
  - `last_summarized_message_id` (uuid) - Tracks last summarized message
  - `last_updated` (timestamptz) - Last activity timestamp
  - `created_at` (timestamptz) - Creation timestamp
  - `user_id` (text) - Browser fingerprint for ownership

  ### 3. `messages`
  Stores individual messages within chat sessions
  - `id` (uuid, primary key) - Unique message identifier
  - `session_id` (uuid, foreign key) - References chat_sessions.id
  - `role` (text) - Message role: 'user', 'model', or 'system'
  - `content` (text) - Message content
  - `timestamp` (bigint) - Unix timestamp in milliseconds
  - `swipes` (jsonb) - Array of message variations
  - `current_index` (int) - Current active variation index
  - `created_at` (timestamptz) - Creation timestamp
  - `user_id` (text) - Browser fingerprint for ownership

  ### 4. `lorebooks`
  Stores lorebook collections (world info)
  - `id` (uuid, primary key) - Unique lorebook identifier
  - `name` (text) - Lorebook name
  - `description` (text) - Lorebook description
  - `enabled` (boolean) - Whether lorebook is active
  - `character_id` (uuid, nullable) - Optional character association
  - `is_global` (boolean) - Whether it's a global lorebook
  - `created_at` (timestamptz) - Creation timestamp
  - `user_id` (text) - Browser fingerprint for ownership

  ### 5. `lorebook_entries`
  Stores individual entries within lorebooks
  - `id` (uuid, primary key) - Unique entry identifier
  - `lorebook_id` (uuid, foreign key) - References lorebooks.id
  - `keys` (jsonb) - Array of trigger keywords
  - `content` (text) - Entry content
  - `enabled` (boolean) - Whether entry is active
  - `created_at` (timestamptz) - Creation timestamp

  ### 6. `app_settings`
  Stores user application settings
  - `id` (uuid, primary key) - Unique settings identifier
  - `user_id` (text) - Browser fingerprint for ownership
  - `settings_data` (jsonb) - Complete settings object
  - `created_at` (timestamptz) - Creation timestamp
  - `updated_at` (timestamptz) - Last update timestamp

  ## Security
  All tables use browser fingerprint-based ownership model:
  - No authentication required (anonymous usage)
  - RLS policies allow full access to own data based on browser fingerprint
  - Each user sees only their own data

  ## Important Notes
  1. Browser fingerprint (`user_id`) is generated client-side and stored in localStorage
  2. Data is isolated per fingerprint - clearing browser data will create new identity
  3. No server-side authentication required for quick start
  4. All timestamps use UTC
*/

-- Create characters table
CREATE TABLE IF NOT EXISTS characters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  tagline text DEFAULT '',
  description text DEFAULT '',
  appearance text DEFAULT '',
  personality text DEFAULT '',
  first_message text DEFAULT '',
  chat_examples text DEFAULT '',
  avatar_url text DEFAULT '',
  scenario text DEFAULT '',
  event_sequence text DEFAULT '',
  style text DEFAULT '',
  jailbreak text DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  user_id text NOT NULL
);

-- Create chat_sessions table
CREATE TABLE IF NOT EXISTS chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  name text NOT NULL,
  summary text DEFAULT '',
  last_summarized_message_id uuid,
  last_updated timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  user_id text NOT NULL
);

-- Create messages table
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'model', 'system')),
  content text NOT NULL,
  timestamp bigint NOT NULL,
  swipes jsonb DEFAULT '[]',
  current_index int DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  user_id text NOT NULL
);

-- Create lorebooks table
CREATE TABLE IF NOT EXISTS lorebooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text DEFAULT '',
  enabled boolean DEFAULT true,
  character_id uuid REFERENCES characters(id) ON DELETE CASCADE,
  is_global boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  user_id text NOT NULL
);

-- Create lorebook_entries table
CREATE TABLE IF NOT EXISTS lorebook_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lorebook_id uuid NOT NULL REFERENCES lorebooks(id) ON DELETE CASCADE,
  keys jsonb NOT NULL DEFAULT '[]',
  content text NOT NULL,
  enabled boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- Create app_settings table
CREATE TABLE IF NOT EXISTS app_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL UNIQUE,
  settings_data jsonb NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_characters_user_id ON characters(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_character_id ON chat_sessions(character_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id ON chat_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_lorebooks_character_id ON lorebooks(character_id);
CREATE INDEX IF NOT EXISTS idx_lorebooks_user_id ON lorebooks(user_id);
CREATE INDEX IF NOT EXISTS idx_lorebook_entries_lorebook_id ON lorebook_entries(lorebook_id);

-- Enable Row Level Security
ALTER TABLE characters ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE lorebooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE lorebook_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

-- RLS Policies for characters table
CREATE POLICY "Users can view own characters"
  ON characters FOR SELECT
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR user_id = current_setting('app.user_id', true));

CREATE POLICY "Users can insert own characters"
  ON characters FOR INSERT
  WITH CHECK (user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR user_id = current_setting('app.user_id', true));

CREATE POLICY "Users can update own characters"
  ON characters FOR UPDATE
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR user_id = current_setting('app.user_id', true));

CREATE POLICY "Users can delete own characters"
  ON characters FOR DELETE
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR user_id = current_setting('app.user_id', true));

-- RLS Policies for chat_sessions table
CREATE POLICY "Users can view own sessions"
  ON chat_sessions FOR SELECT
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR user_id = current_setting('app.user_id', true));

CREATE POLICY "Users can insert own sessions"
  ON chat_sessions FOR INSERT
  WITH CHECK (user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR user_id = current_setting('app.user_id', true));

CREATE POLICY "Users can update own sessions"
  ON chat_sessions FOR UPDATE
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR user_id = current_setting('app.user_id', true));

CREATE POLICY "Users can delete own sessions"
  ON chat_sessions FOR DELETE
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR user_id = current_setting('app.user_id', true));

-- RLS Policies for messages table
CREATE POLICY "Users can view own messages"
  ON messages FOR SELECT
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR user_id = current_setting('app.user_id', true));

CREATE POLICY "Users can insert own messages"
  ON messages FOR INSERT
  WITH CHECK (user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR user_id = current_setting('app.user_id', true));

CREATE POLICY "Users can update own messages"
  ON messages FOR UPDATE
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR user_id = current_setting('app.user_id', true));

CREATE POLICY "Users can delete own messages"
  ON messages FOR DELETE
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR user_id = current_setting('app.user_id', true));

-- RLS Policies for lorebooks table
CREATE POLICY "Users can view own lorebooks"
  ON lorebooks FOR SELECT
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR user_id = current_setting('app.user_id', true));

CREATE POLICY "Users can insert own lorebooks"
  ON lorebooks FOR INSERT
  WITH CHECK (user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR user_id = current_setting('app.user_id', true));

CREATE POLICY "Users can update own lorebooks"
  ON lorebooks FOR UPDATE
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('request.jwt.
claims', true)::json->>'sub' OR user_id = current_setting('app.user_id', true));

CREATE POLICY "Users can delete own lorebooks"
  ON lorebooks FOR DELETE
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR user_id = current_setting('app.user_id', true));

-- RLS Policies for lorebook_entries table
CREATE POLICY "Users can view entries of own lorebooks"
  ON lorebook_entries FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM lorebooks 
    WHERE lorebooks.id = lorebook_entries.lorebook_id 
    AND (lorebooks.user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR lorebooks.user_id = current_setting('app.user_id', true))
  ));

CREATE POLICY "Users can insert entries into own lorebooks"
  ON lorebook_entries FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM lorebooks 
    WHERE lorebooks.id = lorebook_entries.lorebook_id 
    AND (lorebooks.user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR lorebooks.user_id = current_setting('app.user_id', true))
  ));

CREATE POLICY "Users can update entries in own lorebooks"
  ON lorebook_entries FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM lorebooks 
    WHERE lorebooks.id = lorebook_entries.lorebook_id 
    AND (lorebooks.user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR lorebooks.user_id = current_setting('app.user_id', true))
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM lorebooks 
    WHERE lorebooks.id = lorebook_entries.lorebook_id 
    AND (lorebooks.user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR lorebooks.user_id = current_setting('app.user_id', true))
  ));

CREATE POLICY "Users can delete entries from own lorebooks"
  ON lorebook_entries FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM lorebooks 
    WHERE lorebooks.id = lorebook_entries.lorebook_id 
    AND (lorebooks.user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR lorebooks.user_id = current_setting('app.user_id', true))
  ));

-- RLS Policies for app_settings table
CREATE POLICY "Users can view own settings"
  ON app_settings FOR SELECT
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR user_id = current_setting('app.user_id', true));

CREATE POLICY "Users can insert own settings"
  ON app_settings FOR INSERT
  WITH CHECK (user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR user_id = current_setting('app.user_id', true));

CREATE POLICY "Users can update own settings"
  ON app_settings FOR UPDATE
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR user_id = current_setting('app.user_id', true));

CREATE POLICY "Users can delete own settings"
  ON app_settings FOR DELETE
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub' OR user_id = current_setting('app.user_id', true));