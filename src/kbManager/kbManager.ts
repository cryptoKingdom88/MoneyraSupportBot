import Database from 'better-sqlite3';
import { KBManager as IKBManager, KnowledgeBase } from './types';

export class KBManager implements IKBManager {
  private db: Database.Database;

  constructor(database: Database.Database) {
    this.db = database;
  }

  public async addEntry(category: string, question: string, context: string, answer: string): Promise<number> {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO knowledge_base (category, question, context, answer)
        VALUES (?, ?, ?, ?)
      `);
      
      const result = stmt.run(category, question, context, answer);
      return result.lastInsertRowid as number;
    } catch (error) {
      console.error('Error adding KB entry:', error);
      throw new Error(`Failed to add KB entry: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async updateEntry(id: number, category: string, question: string, context: string, answer: string): Promise<boolean> {
    try {
      const stmt = this.db.prepare(`
        UPDATE knowledge_base 
        SET category = ?, question = ?, context = ?, answer = ?, update_time = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      
      const result = stmt.run(category, question, context, answer, id);
      return result.changes > 0;
    } catch (error) {
      console.error('Error updating KB entry:', error);
      throw new Error(`Failed to update KB entry: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async deleteEntry(id: number): Promise<boolean> {
    try {
      const stmt = this.db.prepare('DELETE FROM knowledge_base WHERE id = ?');
      const result = stmt.run(id);
      return result.changes > 0;
    } catch (error) {
      console.error('Error deleting KB entry:', error);
      throw new Error(`Failed to delete KB entry: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async getAllEntries(): Promise<KnowledgeBase[]> {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM knowledge_base 
        ORDER BY category, question
      `);
      
      const results = stmt.all() as KnowledgeBase[];
      return results;
    } catch (error) {
      console.error('Error getting all KB entries:', error);
      throw new Error(`Failed to get all KB entries: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async searchEntries(query: string): Promise<KnowledgeBase[]> {
    try {
      const searchTerm = `%${query.toLowerCase()}%`;
      const stmt = this.db.prepare(`
        SELECT * FROM knowledge_base 
        WHERE LOWER(category) LIKE ? 
           OR LOWER(question) LIKE ? 
           OR LOWER(context) LIKE ? 
           OR LOWER(answer) LIKE ?
        ORDER BY 
          CASE 
            WHEN LOWER(question) LIKE ? THEN 1
            WHEN LOWER(category) LIKE ? THEN 2
            WHEN LOWER(answer) LIKE ? THEN 3
            ELSE 4
          END,
          category, question
      `);
      
      const results = stmt.all(
        searchTerm, searchTerm, searchTerm, searchTerm,
        searchTerm, searchTerm, searchTerm
      ) as KnowledgeBase[];
      
      return results;
    } catch (error) {
      console.error('Error searching KB entries:', error);
      throw new Error(`Failed to search KB entries: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async getEntryById(id: number): Promise<KnowledgeBase | null> {
    try {
      const stmt = this.db.prepare('SELECT * FROM knowledge_base WHERE id = ?');
      const result = stmt.get(id) as KnowledgeBase | undefined;
      return result || null;
    } catch (error) {
      console.error('Error getting KB entry by ID:', error);
      throw new Error(`Failed to get KB entry by ID: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async getEntriesByCategory(category: string): Promise<KnowledgeBase[]> {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM knowledge_base 
        WHERE LOWER(category) = LOWER(?)
        ORDER BY question
      `);
      
      const results = stmt.all(category) as KnowledgeBase[];
      return results;
    } catch (error) {
      console.error('Error getting KB entries by category:', error);
      throw new Error(`Failed to get KB entries by category: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async getCategories(): Promise<string[]> {
    try {
      const stmt = this.db.prepare(`
        SELECT DISTINCT category FROM knowledge_base 
        ORDER BY category
      `);
      
      const results = stmt.all() as { category: string }[];
      return results.map(row => row.category);
    } catch (error) {
      console.error('Error getting KB categories:', error);
      throw new Error(`Failed to get KB categories: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async getEntryCount(): Promise<number> {
    try {
      const stmt = this.db.prepare('SELECT COUNT(*) as count FROM knowledge_base');
      const result = stmt.get() as { count: number };
      return result.count;
    } catch (error) {
      console.error('Error getting KB entry count:', error);
      throw new Error(`Failed to get KB entry count: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}