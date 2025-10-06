import Database from 'better-sqlite3';
import { HistoryManager as IHistoryManager, MessageHistory, MessageSide } from './types';

export class HistoryManager implements IHistoryManager {
  private db: Database.Database;

  constructor(database: Database.Database) {
    this.db = database;
  }

  public async addMessage(
    ticketId: number, 
    side: MessageSide, 
    username: string, 
    chatId: number, 
    message: string
  ): Promise<number> {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO message_history (ticket_no, side, username, chat_id, message, message_time)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `);
      
      const result = stmt.run(ticketId, side, username, chatId, message);
      return result.lastInsertRowid as number;
    } catch (error) {
      console.error('Error adding message:', error);
      throw new Error(`Failed to add message: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async getTicketHistory(ticketId: number): Promise<MessageHistory[]> {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM message_history 
        WHERE ticket_no = ?
        ORDER BY message_time ASC
      `);
      
      const results = stmt.all(ticketId) as MessageHistory[];
      return results;
    } catch (error) {
      console.error('Error getting ticket history:', error);
      throw new Error(`Failed to get ticket history: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async getLastMessage(ticketId: number, side: MessageSide): Promise<MessageHistory | null> {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM message_history 
        WHERE ticket_no = ? AND side = ?
        ORDER BY message_time DESC
        LIMIT 1
      `);
      
      const result = stmt.get(ticketId, side) as MessageHistory | undefined;
      return result || null;
    } catch (error) {
      console.error('Error getting last message:', error);
      throw new Error(`Failed to get last message: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async updateMessageTime(messageId: number): Promise<void> {
    try {
      const stmt = this.db.prepare(`
        UPDATE message_history 
        SET message_time = CURRENT_TIMESTAMP, update_time = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      
      const result = stmt.run(messageId);
      if (result.changes === 0) {
        throw new Error(`Message with ID ${messageId} not found`);
      }
    } catch (error) {
      console.error('Error updating message time:', error);
      throw new Error(`Failed to update message time: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async getMessageById(messageId: number): Promise<MessageHistory | null> {
    try {
      const stmt = this.db.prepare('SELECT * FROM message_history WHERE id = ?');
      const result = stmt.get(messageId) as MessageHistory | undefined;
      return result || null;
    } catch (error) {
      console.error('Error getting message by ID:', error);
      throw new Error(`Failed to get message by ID: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async getRecentMessages(ticketId: number, limit: number = 10): Promise<MessageHistory[]> {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM message_history 
        WHERE ticket_no = ?
        ORDER BY message_time DESC
        LIMIT ?
      `);
      
      const results = stmt.all(ticketId, limit) as MessageHistory[];
      return results.reverse(); // Return in chronological order
    } catch (error) {
      console.error('Error getting recent messages:', error);
      throw new Error(`Failed to get recent messages: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async getMessageCount(ticketId: number, side?: MessageSide): Promise<number> {
    try {
      let stmt: Database.Statement;
      let params: any[];

      if (side) {
        stmt = this.db.prepare(`
          SELECT COUNT(*) as count FROM message_history 
          WHERE ticket_no = ? AND side = ?
        `);
        params = [ticketId, side];
      } else {
        stmt = this.db.prepare(`
          SELECT COUNT(*) as count FROM message_history 
          WHERE ticket_no = ?
        `);
        params = [ticketId];
      }
      
      const result = stmt.get(...params) as { count: number };
      return result.count;
    } catch (error) {
      console.error('Error getting message count:', error);
      throw new Error(`Failed to get message count: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}