import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseConfig } from '../config/types';
import { DatabaseManager as IDatabaseManager } from './types';
import { ALL_TABLES, CREATE_INDEXES, SCHEMA_VERSION } from './schema';

export class DatabaseManager implements IDatabaseManager {
  private db: Database.Database | null = null;
  private config: DatabaseConfig;

  constructor(config: DatabaseConfig) {
    this.config = config;
  }

  public async initialize(): Promise<void> {
    try {
      // Ensure the directory exists
      const dbDir = path.dirname(this.config.path);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      // Initialize database connection
      this.db = new Database(this.config.path, this.config.options || {});
      
      // Enable foreign keys
      this.db.pragma('foreign_keys = ON');
      
      // Set WAL mode for better concurrency
      this.db.pragma('journal_mode = WAL');
      
      console.log(`Database initialized at: ${this.config.path}`);
      
      // Run migrations
      await this.migrate();
      
    } catch (error) {
      console.error('Failed to initialize database:', error);
      throw new Error(`Database initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public getConnection(): Database.Database {
    if (!this.db) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.db;
  }

  public close(): void {
    if (this.db) {
      try {
        this.db.close();
        this.db = null;
        console.log('Database connection closed');
      } catch (error) {
        console.error('Error closing database:', error);
      }
    }
  }

  public async migrate(): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      // Create schema_version table if it doesn't exist
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (
          version INTEGER PRIMARY KEY,
          applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Get current schema version
      const currentVersion = this.getCurrentSchemaVersion();
      
      if (currentVersion < SCHEMA_VERSION) {
        console.log(`Migrating database from version ${currentVersion} to ${SCHEMA_VERSION}`);
        
        // Run migration in a transaction
        const transaction = this.db.transaction(() => {
          // Create all tables
          for (const tableSQL of ALL_TABLES) {
            this.db!.exec(tableSQL);
          }
          
          // Create indexes
          for (const indexSQL of CREATE_INDEXES) {
            this.db!.exec(indexSQL);
          }
          
          // Update schema version
          this.db!.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
        });
        
        transaction();
        console.log('Database migration completed successfully');
      } else {
        console.log('Database schema is up to date');
      }
      
    } catch (error) {
      console.error('Database migration failed:', error);
      throw new Error(`Migration failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private getCurrentSchemaVersion(): number {
    if (!this.db) {
      return 0;
    }

    try {
      const result = this.db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number } | undefined;
      return result?.version || 0;
    } catch (error) {
      // Table doesn't exist yet
      return 0;
    }
  }

  public isInitialized(): boolean {
    return this.db !== null;
  }

  public async healthCheck(): Promise<boolean> {
    if (!this.db) {
      return false;
    }

    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch (error) {
      console.error('Database health check failed:', error);
      return false;
    }
  }
}