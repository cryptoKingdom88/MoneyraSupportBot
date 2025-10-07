import Database from 'better-sqlite3';
import { VectorServiceClient } from '../vectorService/vectorServiceClient';
import { KnowledgeBase } from './types';

/**
 * Migration helper for existing KB installations to add vector support
 */
export class VectorMigrationHelper {
  private db: Database.Database;
  private vectorClient: VectorServiceClient;

  constructor(database: Database.Database, vectorClient: VectorServiceClient) {
    this.db = database;
    this.vectorClient = vectorClient;
  }

  /**
   * Migrate all existing KB entries to vector service
   * This should be run once when enabling vector service for existing installations
   */
  public async migrateExistingEntries(): Promise<{ success: number; failed: number; total: number }> {
    console.log('🔄 Starting migration of existing KB entries to vector service...');
    
    const stats = { success: 0, failed: 0, total: 0 };
    
    try {
      // Get all existing KB entries
      const stmt = this.db.prepare('SELECT * FROM knowledge_base ORDER BY id');
      const entries = stmt.all() as KnowledgeBase[];
      
      stats.total = entries.length;
      console.log(`Found ${stats.total} KB entries to migrate`);
      
      if (stats.total === 0) {
        console.log('✅ No entries to migrate');
        return stats;
      }

      // Check vector service health
      const healthCheck = await this.vectorClient.healthCheck();
      if (healthCheck.status !== 'healthy') {
        throw new Error('Vector service is not healthy, cannot proceed with migration');
      }

      // Migrate entries in batches to avoid overwhelming the service
      const batchSize = 10;
      for (let i = 0; i < entries.length; i += batchSize) {
        const batch = entries.slice(i, i + batchSize);
        await this.migrateBatch(batch, stats);
        
        // Small delay between batches
        if (i + batchSize < entries.length) {
          await this.delay(100);
        }
      }

      console.log(`✅ Migration completed: ${stats.success} successful, ${stats.failed} failed out of ${stats.total} total`);
      
    } catch (error) {
      console.error('❌ Migration failed:', error);
      throw error;
    }
    
    return stats;
  }

  private async migrateBatch(entries: KnowledgeBase[], stats: { success: number; failed: number }): Promise<void> {
    const promises = entries.map(async (entry) => {
      try {
        const inputText = this.combineQuestionAndContext(entry.question, entry.context || '');
        const response = await this.vectorClient.addVector(entry.id, inputText, entry.answer);
        
        if (response.success) {
          stats.success++;
          console.log(`✅ Migrated KB entry ${entry.id}: ${entry.question.substring(0, 50)}...`);
        } else {
          stats.failed++;
          console.warn(`⚠️ Failed to migrate KB entry ${entry.id}: ${response.message}`);
        }
      } catch (error) {
        stats.failed++;
        console.error(`❌ Error migrating KB entry ${entry.id}:`, error);
      }
    });

    await Promise.all(promises);
  }

  private combineQuestionAndContext(question: string, context: string): string {
    if (context && context.trim()) {
      return `${question} ${context}`;
    }
    return question;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Verify migration by checking if all KB entries have corresponding vectors
   */
  public async verifyMigration(): Promise<{ verified: number; missing: number; total: number }> {
    console.log('🔍 Verifying migration...');
    
    const stats = { verified: 0, missing: 0, total: 0 };
    
    try {
      // Get all KB entries
      const stmt = this.db.prepare('SELECT id, question FROM knowledge_base ORDER BY id');
      const entries = stmt.all() as { id: number; question: string }[];
      
      stats.total = entries.length;
      
      // Check vector service health
      const healthCheck = await this.vectorClient.healthCheck();
      if (healthCheck.status !== 'healthy') {
        throw new Error('Vector service is not healthy, cannot verify migration');
      }

      console.log(`Verifying ${stats.total} entries...`);
      
      // For now, we'll assume verification by checking if we can search for each entry
      // In a real implementation, you might want to add a specific verification endpoint
      for (const entry of entries) {
        try {
          const searchResponse = await this.vectorClient.searchSimilar(entry.question);
          if (searchResponse.success && searchResponse.match_found && searchResponse.kb_id === entry.id) {
            stats.verified++;
          } else {
            stats.missing++;
            console.warn(`⚠️ KB entry ${entry.id} may not have been migrated properly`);
          }
        } catch (error) {
          stats.missing++;
          console.error(`❌ Error verifying KB entry ${entry.id}:`, error);
        }
      }

      console.log(`✅ Verification completed: ${stats.verified} verified, ${stats.missing} missing out of ${stats.total} total`);
      
    } catch (error) {
      console.error('❌ Verification failed:', error);
      throw error;
    }
    
    return stats;
  }

  /**
   * Clean up vector data (useful for testing or rollback)
   */
  public async cleanupVectorData(): Promise<void> {
    console.log('🧹 Cleaning up vector data...');
    
    try {
      // Get all KB entry IDs
      const stmt = this.db.prepare('SELECT id FROM knowledge_base ORDER BY id');
      const entries = stmt.all() as { id: number }[];
      
      console.log(`Cleaning up ${entries.length} vector entries...`);
      
      // Delete vectors in batches
      const batchSize = 10;
      let deleted = 0;
      
      for (let i = 0; i < entries.length; i += batchSize) {
        const batch = entries.slice(i, i + batchSize);
        const promises = batch.map(async (entry) => {
          try {
            const response = await this.vectorClient.deleteVector(entry.id);
            if (response.success) {
              deleted++;
            }
          } catch (error) {
            console.warn(`Failed to delete vector for KB entry ${entry.id}:`, error);
          }
        });
        
        await Promise.all(promises);
        
        // Small delay between batches
        if (i + batchSize < entries.length) {
          await this.delay(100);
        }
      }
      
      console.log(`✅ Cleanup completed: ${deleted} vectors deleted`);
      
    } catch (error) {
      console.error('❌ Cleanup failed:', error);
      throw error;
    }
  }
}