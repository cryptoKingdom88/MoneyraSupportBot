import Database from 'better-sqlite3';
import { KBManager as IKBManager, KnowledgeBase, AutoResponseResult } from './types';
import { VectorIntegration, VectorIntegrationImpl } from './vectorIntegration';
import { VectorServiceClient } from '../vectorService/vectorServiceClient';

export class KBManager implements IKBManager {
  private db: Database.Database;
  private vectorIntegration: VectorIntegration | null = null;

  constructor(database: Database.Database, vectorClient?: VectorServiceClient) {
    this.db = database;

    // Initialize vector integration if vector client is provided
    if (vectorClient) {
      this.vectorIntegration = new VectorIntegrationImpl(vectorClient);
      console.log('✅ KBManager initialized with vector integration');
    } else {
      console.log('ℹ️ KBManager initialized without vector integration');
    }
  }

  // Method to set vector integration after construction (for backward compatibility)
  public setVectorIntegration(vectorClient: VectorServiceClient): void {
    this.vectorIntegration = new VectorIntegrationImpl(vectorClient);
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

  // Vector-enhanced methods with duplicate detection and embedding storage
  public async addEntryWithAutoContext(category: string, question: string, answer: string): Promise<number> {
    console.log(`🔍 DEBUG - addEntryWithAutoContext called: question="${question}"`);
    
    // Check for similar entries before adding
    const duplicateCheck = await this.checkForSimilarEntry(question);
    if (duplicateCheck.hasSimilar) {
      throw new Error(`Similar KB entry already exists: "${duplicateCheck.similarEntry!.question}" (ID: ${duplicateCheck.similarEntry!.id})`);
    }

    // Generate embedding and store it in context field
    const embeddingContext = await this.generateEmbeddingContext(question, answer);
    console.log(`🔍 DEBUG - Generated embeddingContext length: ${embeddingContext.length}`);

    // Add to database with embedding as context
    const kbId = await this.addEntry(category, question, embeddingContext, answer);

    // Then sync with vector service (use original question, not embedding context)
    if (this.vectorIntegration) {
      console.log(`🔍 DEBUG - Calling syncVectorOnAdd with question="${question}", context=""`);
      await this.vectorIntegration.syncVectorOnAdd(kbId, question, '', answer);
    }

    return kbId;
  }

  public async updateEntryWithAutoContext(id: number, category: string, question: string, answer: string): Promise<boolean> {
    // Check for similar entries before updating
    const duplicateCheck = await this.checkForSimilarEntry(question, id);
    if (duplicateCheck.hasSimilar && duplicateCheck.similarEntry!.id !== id) {
      throw new Error(`Similar KB entry already exists: "${duplicateCheck.similarEntry!.question}" (ID: ${duplicateCheck.similarEntry!.id})`);
    }

    // Generate embedding and store it in context field
    const embeddingContext = await this.generateEmbeddingContext(question, answer);

    // Update database with embedding as context
    const success = await this.updateEntry(id, category, question, embeddingContext, answer);

    // Then sync with vector service if database update was successful (use original question, not embedding context)
    if (success && this.vectorIntegration) {
      await this.vectorIntegration.syncVectorOnUpdate(id, question, '', answer);
    }

    return success;
  }

  /**
   * Checks for similar KB entries to prevent duplicates
   * @param question The question to check for similarity
   * @param excludeId Optional ID to exclude from similarity check (for updates)
   * @returns Object indicating if similar entry exists and the entry details
   */
  private async checkForSimilarEntry(question: string, excludeId?: number): Promise<{
    hasSimilar: boolean;
    similarEntry?: KnowledgeBase;
    similarityScore?: number;
  }> {
    if (!this.vectorIntegration) {
      console.log('🔶 Vector integration not available, skipping similarity check');
      return { hasSimilar: false };
    }

    try {
      // Search for similar content using vector service
      const similarResult = await this.vectorIntegration.searchSimilarContent(question);

      if (similarResult && similarResult.kbId) {
        // If we're updating and the similar entry is the same entry, it's not a duplicate
        if (excludeId && similarResult.kbId === excludeId) {
          return { hasSimilar: false };
        }

        // Get the similar KB entry from database
        const similarEntry = await this.getEntryById(similarResult.kbId);

        if (similarEntry) {
          console.log(`🔍 Found similar KB entry: ID ${similarEntry.id}, Score: ${similarResult.similarityScore}`);
          return {
            hasSimilar: true,
            similarEntry,
            similarityScore: similarResult.similarityScore
          };
        }
      }

      return { hasSimilar: false };

    } catch (error) {
      console.warn('⚠️ Failed to check for similar entries:', error);
      // If vector service fails, allow the operation to continue
      return { hasSimilar: false };
    }
  }

  /**
   * Generates embedding vector and stores it as context
   * @param question The question to generate embedding for
   * @param answer The answer to include in embedding generation
   * @returns Embedding vector as JSON string
   */
  private async generateEmbeddingContext(question: string, answer: string): Promise<string> {
    if (!this.vectorIntegration) {
      console.log('🔶 Vector integration not available, using empty context');
      return '';
    }

    try {
      // Get embedding from vector service
      const embedding = await this.vectorIntegration.generateEmbedding(question, answer);
      
      if (embedding && embedding.length > 0) {
        // Store embedding as JSON string in context field
        const embeddingJson = JSON.stringify(Array.from(embedding));
        console.log(`✅ Generated embedding with ${embedding.length} dimensions`);
        return embeddingJson;
      }

      console.warn('⚠️ Failed to generate embedding, using empty context');
      return '';

    } catch (error) {
      console.warn('⚠️ Failed to generate embedding context:', error);
      return '';
    }
  }

  public async searchSimilarContent(query: string): Promise<AutoResponseResult | null> {
    if (!this.vectorIntegration) {
      console.log('Vector integration not available, cannot perform similarity search');
      return null;
    }

    return await this.vectorIntegration.searchSimilarContent(query);
  }

  /**
   * Public method to check for similar entries (for admin review)
   * @param question The question to check for similarity
   * @param excludeId Optional ID to exclude from similarity check
   * @returns Similar entry information if found
   */
  public async findSimilarEntry(question: string, excludeId?: number): Promise<{
    hasSimilar: boolean;
    similarEntry?: KnowledgeBase;
    similarityScore?: number;
  }> {
    return await this.checkForSimilarEntry(question, excludeId);
  }



  // Backward compatibility methods that automatically use vector integration when available
  public async addEntry(category: string, question: string, context: string, answer: string): Promise<number> {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO knowledge_base (category, question, context, answer)
        VALUES (?, ?, ?, ?)
      `);

      const result = stmt.run(category, question, context, answer);
      const kbId = result.lastInsertRowid as number;

      return kbId;
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
      const success = result.changes > 0;

      return success;
    } catch (error) {
      console.error('Error updating KB entry:', error);
      throw new Error(`Failed to update KB entry: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async deleteEntry(id: number): Promise<boolean> {
    try {
      const stmt = this.db.prepare('DELETE FROM knowledge_base WHERE id = ?');
      const result = stmt.run(id);
      const success = result.changes > 0;

      // Auto-sync with vector service if available and enabled
      if (success && this.vectorIntegration && this.vectorIntegration.isVectorServiceEnabled()) {
        await this.vectorIntegration.syncVectorOnDelete(id);
      }

      return success;
    } catch (error) {
      console.error('Error deleting KB entry:', error);
      throw new Error(`Failed to delete KB entry: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}