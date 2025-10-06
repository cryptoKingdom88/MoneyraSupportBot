export const CREATE_SESSIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_chat_id INTEGER NOT NULL,
    customer_username TEXT NOT NULL,
    operator_chat_id INTEGER,
    operator_username TEXT,
    last_message_id INTEGER,
    last_reply_id INTEGER,
    status INTEGER NOT NULL DEFAULT 0,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    update_time DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`;

export const CREATE_MESSAGE_HISTORY_TABLE = `
  CREATE TABLE IF NOT EXISTS message_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_no INTEGER NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('from', 'to')),
    username TEXT NOT NULL,
    chat_id INTEGER NOT NULL,
    message TEXT NOT NULL,
    message_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ticket_no) REFERENCES sessions(id)
  )
`;

export const CREATE_KNOWLEDGE_BASE_TABLE = `
  CREATE TABLE IF NOT EXISTS knowledge_base (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    question TEXT NOT NULL,
    context TEXT,
    answer TEXT NOT NULL,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    update_time DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`;

export const CREATE_MANAGERS_TABLE = `
  CREATE TABLE IF NOT EXISTS managers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER UNIQUE NOT NULL,
    username TEXT NOT NULL,
    is_active BOOLEAN DEFAULT 1,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    update_time DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`;

export const CREATE_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_sessions_customer_chat_id ON sessions(customer_chat_id)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)',
  'CREATE INDEX IF NOT EXISTS idx_message_history_ticket_no ON message_history(ticket_no)',
  'CREATE INDEX IF NOT EXISTS idx_message_history_side ON message_history(side)',
  'CREATE INDEX IF NOT EXISTS idx_managers_chat_id ON managers(chat_id)',
  'CREATE INDEX IF NOT EXISTS idx_managers_is_active ON managers(is_active)'
];

export const ALL_TABLES = [
  CREATE_SESSIONS_TABLE,
  CREATE_MESSAGE_HISTORY_TABLE,
  CREATE_KNOWLEDGE_BASE_TABLE,
  CREATE_MANAGERS_TABLE
];

export const SCHEMA_VERSION = 1;