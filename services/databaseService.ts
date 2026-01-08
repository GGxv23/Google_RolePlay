import { Character, ChatSession, Message, AppSettings, Lorebook, LorebookEntry } from '../types';

let supabaseClient: any = null;
let currentUserId: string | null = null;

// Generate a persistent browser fingerprint
const getBrowserFingerprint = (): string => {
  let fingerprint = localStorage.getItem('velvetcore_user_id');

  if (!fingerprint) {
    // Generate a unique fingerprint based on browser characteristics
    const nav = navigator;
    const screen = window.screen;

    const data = [
      nav.userAgent,
      nav.language,
      screen.colorDepth,
      screen.width,
      screen.height,
      new Date().getTimezoneOffset(),
      !!window.sessionStorage,
      !!window.localStorage,
      Date.now(),
      Math.random()
    ].join('|||');

    // Simple hash function
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }

    fingerprint = 'user_' + Math.abs(hash).toString(36) + '_' + Date.now().toString(36);
    localStorage.setItem('velvetcore_user_id', fingerprint);
  }

  return fingerprint;
};

// Initialize Supabase client
export const initializeDatabase = async (): Promise<boolean> => {
  try {
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      console.warn('Supabase credentials not found. Data will not persist.');
      return false;
    }

    // Dynamically import Supabase
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');

    currentUserId = getBrowserFingerprint();
    supabaseClient = createClient(supabaseUrl, supabaseKey, {
      global: {
        headers: {
          'X-Client-Info': 'velvetcore-roleplay'
        }
      }
    });

    // Set the user_id for RLS policies
    await supabaseClient.rpc('set_config', {
      setting: 'app.user_id',
      value: currentUserId
    }).catch(() => {
      // Fallback: configure session-level setting differently if RPC fails
      console.log('Using client-side user identification');
    });

    return true;
  } catch (error) {
    console.error('Failed to initialize database:', error);
    return false;
  }
};

// Helper to ensure database is ready
const ensureDatabase = () => {
  if (!supabaseClient) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return supabaseClient;
};

// Helper to add user_id to data
const withUserId = <T extends object>(data: T): T & { user_id: string } => ({
  ...data,
  user_id: currentUserId || getBrowserFingerprint()
});

// ============= CHARACTER OPERATIONS =============

export const saveCharacter = async (character: Character): Promise<void> => {
  const db = ensureDatabase();

  const { id, lorebooks, ...charData } = character;

  const dbChar = {
    id,
    name: charData.name,
    tagline: charData.tagline || '',
    description: charData.description || '',
    appearance: charData.appearance || '',
    personality: charData.personality || '',
    first_message: charData.firstMessage || '',
    chat_examples: charData.chatExamples || '',
    avatar_url: charData.avatarUrl || '',
    scenario: charData.scenario || '',
    event_sequence: charData.eventSequence || '',
    style: charData.style || '',
    jailbreak: charData.jailbreak || '',
    updated_at: new Date().toISOString()
  };

  const { error } = await db
    .from('characters')
    .upsert(withUserId(dbChar));

  if (error) throw error;

  // Save lorebooks
  if (lorebooks && lorebooks.length > 0) {
    for (const lorebook of lorebooks) {
      await saveLorebook(lorebook, id);
    }
  }
};

export const loadCharacters = async (): Promise<Character[]> => {
  const db = ensureDatabase();

  const { data: chars, error } = await db
    .from('characters')
    .select('*')
    .eq('user_id', currentUserId || getBrowserFingerprint())
    .order('created_at', { ascending: false });

  if (error) throw error;

  if (!chars || chars.length === 0) return [];

  // Load lorebooks for each character
  const characters: Character[] = await Promise.all(
    chars.map(async (char: any) => {
      const lorebooks = await loadLorebooks(char.id);

      return {
        id: char.id,
        name: char.name,
        tagline: char.tagline,
        description: char.description,
        appearance: char.appearance,
        personality: char.personality,
        firstMessage: char.first_message,
        chatExamples: char.chat_examples,
        avatarUrl: char.avatar_url,
        scenario: char.scenario,
        eventSequence: char.event_sequence,
        style: char.style,
        jailbreak: char.jailbreak,
        lorebooks: lorebooks
      };
    })
  );

  return characters;
};

export const deleteCharacter = async (characterId: string): Promise<void> => {
  const db = ensureDatabase();

  const { error } = await db
    .from('characters')
    .delete()
    .eq('id', characterId)
    .eq('user_id', currentUserId || getBrowserFingerprint());

  if (error) throw error;
};

// ============= SESSION OPERATIONS =============

export const saveSession = async (session: ChatSession): Promise<void> => {
  const db = ensureDatabase();

  const dbSession = {
    id: session.id,
    character_id: session.characterId,
    name: session.name,
    summary: session.summary || '',
    last_summarized_message_id: session.lastSummarizedMessageId || null,
    last_updated: new Date(session.lastUpdated).toISOString()
  };

  const { error } = await db
    .from('chat_sessions')
    .upsert(withUserId(dbSession));

  if (error) throw error;

  // Save messages
  if (session.messages && session.messages.length > 0) {
    await saveMessages(session.messages, session.id);
  }
};

export const loadSessions = async (): Promise<Record<string, ChatSession>> => {
  const db = ensureDatabase();

  const { data: sessions, error } = await db
    .from('chat_sessions')
    .select('*')
    .eq('user_id', currentUserId || getBrowserFingerprint())
    .order('last_updated', { ascending: false });

  if (error) throw error;

  if (!sessions || sessions.length === 0) return {};

  const sessionMap: Record<string, ChatSession> = {};

  for (const session of sessions) {
    const messages = await loadMessages(session.id);

    sessionMap[session.id] = {
      id: session.id,
      characterId: session.character_id,
      name: session.name,
      summary: session.summary || '',
      lastSummarizedMessageId: session.last_summarized_message_id,
      lastUpdated: new Date(session.last_updated).getTime(),
      messages: messages
    };
  }

  return sessionMap;
};

export const deleteSession = async (sessionId: string): Promise<void> => {
  const db = ensureDatabase();

  const { error } = await db
    .from('chat_sessions')
    .delete()
    .eq('id', sessionId)
    .eq('user_id', currentUserId || getBrowserFingerprint());

  if (error) throw error;
};

// ============= MESSAGE OPERATIONS =============

export const saveMessages = async (messages: Message[], sessionId: string): Promise<void> => {
  const db = ensureDatabase();

  const dbMessages = messages.map(msg => ({
    id: msg.id,
    session_id: sessionId,
    role: msg.role,
    content: msg.content,
    timestamp: msg.timestamp,
    swipes: msg.swipes || [],
    current_index: msg.currentIndex || 0
  }));

  const { error } = await db
    .from('messages')
    .upsert(dbMessages.map(withUserId));

  if (error) throw error;
};

export const loadMessages = async (sessionId: string): Promise<Message[]> => {
  const db = ensureDatabase();

  const { data: messages, error } = await db
    .from('messages')
    .select('*')
    .eq('session_id', sessionId)
    .eq('user_id', currentUserId || getBrowserFingerprint())
    .order('timestamp', { ascending: true });

  if (error) throw error;

  if (!messages) return [];

  return messages.map((msg: any) => ({
    id: msg.id,
    role: msg.role,
    content: msg.content,
    timestamp: msg.timestamp,
    swipes: msg.swipes || [],
    currentIndex: msg.current_index || 0
  }));
};

export const deleteMessage = async (messageId: string): Promise<void> => {
  const db = ensureDatabase();

  const { error } = await db
    .from('messages')
    .delete()
    .eq('id', messageId)
    .eq('user_id', currentUserId || getBrowserFingerprint());

  if (error) throw error;
};

// ============= LOREBOOK OPERATIONS =============

export const saveLorebook = async (lorebook: Lorebook, characterId?: string): Promise<void> => {
  const db = ensureDatabase();

  const dbLorebook = {
    id: lorebook.id,
    name: lorebook.name,
    description: lorebook.description || '',
    enabled: lorebook.enabled,
    character_id: characterId || null,
    is_global: !characterId
  };

  const { error } = await db
    .from('lorebooks')
    .upsert(withUserId(dbLorebook));

  if (error) throw error;

  // Save entries
  if (lorebook.entries && lorebook.entries.length > 0) {
    await saveLorebookEntries(lorebook.entries, lorebook.id);
  }
};

export const loadLorebooks = async (characterId?: string): Promise<Lorebook[]> => {
  const db = ensureDatabase();

  let query = db
    .from('lorebooks')
    .select('*')
    .eq('user_id', currentUserId || getBrowserFingerprint());

  if (characterId) {
    query = query.eq('character_id', characterId);
  } else {
    query = query.eq('is_global', true);
  }

  const { data: lorebooks, error } = await query;

  if (error) throw error;

  if (!lorebooks || lorebooks.length === 0) return [];

  const result: Lorebook[] = await Promise.all(
    lorebooks.map(async (lb: any) => {
      const entries = await loadLorebookEntries(lb.id);

      return {
        id: lb.id,
        name: lb.name,
        description: lb.description,
        enabled: lb.enabled,
        entries: entries
      };
    })
  );

  return result;
};

export const deleteLorebook = async (lorebookId: string): Promise<void> => {
  const db = ensureDatabase();

  const { error } = await db
    .from('lorebooks')
    .delete()
    .eq('id', lorebookId)
    .eq('user_id', currentUserId || getBrowserFingerprint());

  if (error) throw error;
};

// ============= LOREBOOK ENTRY OPERATIONS =============

export const saveLorebookEntries = async (entries: LorebookEntry[], lorebookId: string): Promise<void> => {
  const db = ensureDatabase();

  const dbEntries = entries.map(entry => ({
    id: entry.id,
    lorebook_id: lorebookId,
    keys: entry.keys || [],
    content: entry.content,
    enabled: entry.enabled
  }));

  const { error } = await db
    .from('lorebook_entries')
    .upsert(dbEntries);

  if (error) throw error;
};

export const loadLorebookEntries = async (lorebookId: string): Promise<LorebookEntry[]> => {
  const db = ensureDatabase();

  const { data: entries, error } = await db
    .from('lorebook_entries')
    .select('*')
    .eq('lorebook_id', lorebookId);

  if (error) throw error;

  if (!entries) return [];

  return entries.map((entry: any) => ({
    id: entry.id,
    keys: entry.keys || [],
    content: entry.content,
    enabled: entry.enabled
  }));
};

// ============= SETTINGS OPERATIONS =============

export const saveSettings = async (settings: AppSettings): Promise<void> => {
  const db = ensureDatabase();

  const userId = currentUserId || getBrowserFingerprint();

  const { error } = await db
    .from('app_settings')
    .upsert({
      user_id: userId,
      settings_data: settings,
      updated_at: new Date().toISOString()
    });

  if (error) throw error;
};

export const loadSettings = async (): Promise<AppSettings | null> => {
  const db = ensureDatabase();

  const { data, error } = await db
    .from('app_settings')
    .select('settings_data')
    .eq('user_id', currentUserId || getBrowserFingerprint())
    .single();

  if (error && error.code !== 'PGRST116') throw error; // PGRST116 = no rows returned

  return data?.settings_data || null;
};

// ============= BATCH OPERATIONS =============

export const saveAll = async (
  characters: Character[],
  sessions: Record<string, ChatSession>,
  settings: AppSettings
): Promise<void> => {
  // Save all data in sequence (could be optimized with Promise.all for independent operations)

  for (const character of characters) {
    await saveCharacter(character);
  }

  for (const session of Object.values(sessions)) {
    await saveSession(session);
  }

  await saveSettings(settings);
};

export const loadAll = async (): Promise<{
  characters: Character[];
  sessions: Record<string, ChatSession>;
  settings: AppSettings | null;
}> => {
  const [characters, sessions, settings] = await Promise.all([
    loadCharacters(),
    loadSessions(),
    loadSettings()
  ]);

  return { characters, sessions, settings };
};

// ============= UTILITY =============

export const clearAllData = async (): Promise<void> => {
  const db = ensureDatabase();
  const userId = currentUserId || getBrowserFingerprint();

  await Promise.all([
    db.from('characters').delete().eq('user_id', userId),
    db.from('chat_sessions').delete().eq('user_id', userId),
    db.from('messages').delete().eq('user_id', userId),
    db.from('lorebooks').delete().eq('user_id', userId),
    db.from('app_settings').delete().eq('user_id', userId)
  ]);
};

export const isDatabaseAvailable = (): boolean => {
  return supabaseClient !== null;
};
