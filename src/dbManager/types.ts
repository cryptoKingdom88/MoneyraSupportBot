import Database from 'better-sqlite3';

export interface DatabaseManager {
  initialize(): Promise<void>;
  getConnection(): Database.Database;
  close(): void;
  migrate(): Promise<void>;
}

export interface Session {
  id: number;
  customer_chat_id: number;
  customer_username: string;
  operator_chat_id?: number;
  operator_username?: string;
  last_message_id?: number;
  last_reply_id?: number;
  status: TicketStatus;
  create_time: string;
  update_time: string;
}

export interface MessageHistory {
  id: number;
  ticket_no: number;
  side: MessageSide;
  username: string;
  chat_id: number;
  message: string;
  message_time: string;
  create_time: string;
  update_time: string;
}

export interface KnowledgeBase {
  id: number;
  category: string;
  question: string;
  context?: string;
  answer: string;
  create_time: string;
  update_time: string;
}

export interface Manager {
  id: number;
  chat_id: number;
  username: string;
  is_active: boolean;
  create_time: string;
  update_time: string;
}

export enum TicketStatus {
  OPEN = 0,
  WAITING_REPLY = 1,
  REPLIED = 2,
  CLOSED = 3
}

export enum MessageSide {
  FROM = 'from', // Customer to Manager
  TO = 'to'      // Manager to Customer
}

export interface DatabaseTables {
  sessions: Session;
  messageHistory: MessageHistory;
  knowledgeBase: KnowledgeBase;
  managers: Manager;
}