import Database from 'better-sqlite3';
import { SessionManager as ISessionManager, Session, TicketStatus } from './types';

export class SessionManager implements ISessionManager {
  private db: Database.Database;

  constructor(database: Database.Database) {
    this.db = database;
  }

  public async createTicket(customerChatId: number, customerUsername: string): Promise<number> {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO sessions (customer_chat_id, customer_username, status)
        VALUES (?, ?, ?)
      `);
      
      const result = stmt.run(customerChatId, customerUsername, TicketStatus.OPEN);
      return result.lastInsertRowid as number;
    } catch (error) {
      console.error('Error creating ticket:', error);
      throw new Error(`Failed to create ticket: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async getOpenTicket(customerChatId: number): Promise<Session | null> {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM sessions 
        WHERE customer_chat_id = ? AND status IN (?, ?, ?)
        ORDER BY create_time DESC
        LIMIT 1
      `);
      
      const result = stmt.get(
        customerChatId, 
        TicketStatus.OPEN, 
        TicketStatus.WAITING_REPLY, 
        TicketStatus.REPLIED
      ) as Session | undefined;
      
      return result || null;
    } catch (error) {
      console.error('Error getting open ticket:', error);
      throw new Error(`Failed to get open ticket: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async assignManager(ticketId: number, managerChatId: number, managerUsername: string): Promise<boolean> {
    try {
      const stmt = this.db.prepare(`
        UPDATE sessions 
        SET operator_chat_id = ?, operator_username = ?, update_time = CURRENT_TIMESTAMP
        WHERE id = ? AND operator_chat_id IS NULL
      `);
      
      const result = stmt.run(managerChatId, managerUsername, ticketId);
      return result.changes > 0;
    } catch (error) {
      console.error('Error assigning manager:', error);
      throw new Error(`Failed to assign manager: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async updateTicketStatus(ticketId: number, status: TicketStatus): Promise<void> {
    try {
      const stmt = this.db.prepare(`
        UPDATE sessions 
        SET status = ?, update_time = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      
      const result = stmt.run(status, ticketId);
      if (result.changes === 0) {
        throw new Error(`Ticket with ID ${ticketId} not found`);
      }
    } catch (error) {
      console.error('Error updating ticket status:', error);
      throw new Error(`Failed to update ticket status: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async getTicketsByManager(managerChatId: number): Promise<Session[]> {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM sessions 
        WHERE operator_chat_id = ? AND status IN (?, ?)
        ORDER BY update_time DESC
      `);
      
      const results = stmt.all(managerChatId, TicketStatus.WAITING_REPLY, TicketStatus.REPLIED) as Session[];
      return results;
    } catch (error) {
      console.error('Error getting tickets by manager:', error);
      throw new Error(`Failed to get tickets by manager: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async closeExpiredTickets(): Promise<number> {
    try {
      // Close tickets that have been in REPLIED status for more than 30 minutes without customer response
      const stmt = this.db.prepare(`
        UPDATE sessions 
        SET status = ?, update_time = CURRENT_TIMESTAMP
        WHERE status = ? 
        AND datetime(update_time, '+30 minutes') <= datetime('now')
      `);
      
      const result = stmt.run(TicketStatus.CLOSED, TicketStatus.REPLIED);
      
      if (result.changes > 0) {
        console.log(`Closed ${result.changes} expired tickets`);
      }
      
      return result.changes;
    } catch (error) {
      console.error('Error closing expired tickets:', error);
      throw new Error(`Failed to close expired tickets: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async updateLastMessageId(ticketId: number, messageId: number): Promise<void> {
    try {
      const stmt = this.db.prepare(`
        UPDATE sessions 
        SET last_message_id = ?, update_time = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      
      const result = stmt.run(messageId, ticketId);
      if (result.changes === 0) {
        throw new Error(`Ticket with ID ${ticketId} not found`);
      }
    } catch (error) {
      console.error('Error updating last message ID:', error);
      throw new Error(`Failed to update last message ID: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async updateLastReplyId(ticketId: number, replyId: number): Promise<void> {
    try {
      const stmt = this.db.prepare(`
        UPDATE sessions 
        SET last_reply_id = ?, update_time = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      
      const result = stmt.run(replyId, ticketId);
      if (result.changes === 0) {
        throw new Error(`Ticket with ID ${ticketId} not found`);
      }
    } catch (error) {
      console.error('Error updating last reply ID:', error);
      throw new Error(`Failed to update last reply ID: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async getTicketById(ticketId: number): Promise<Session | null> {
    try {
      const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
      const result = stmt.get(ticketId) as Session | undefined;
      return result || null;
    } catch (error) {
      console.error('Error getting ticket by ID:', error);
      throw new Error(`Failed to get ticket by ID: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}