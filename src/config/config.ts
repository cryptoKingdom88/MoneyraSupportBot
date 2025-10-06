import * as dotenv from 'dotenv';
import { BotConfig, DatabaseConfig } from './types';

// Load environment variables from .env file
dotenv.config();

class ConfigManager {
  private static instance: ConfigManager;
  private botConfig: BotConfig;
  private databaseConfig: DatabaseConfig;

  private constructor() {
    this.validateEnvironmentVariables();
    this.botConfig = this.loadBotConfig();
    this.databaseConfig = this.loadDatabaseConfig();
  }

  public static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  private validateEnvironmentVariables(): void {
    const requiredVars = ['BOT_API_TOKEN', 'SUPER_ADMIN_USERNAME'];
    const missingVars: string[] = [];

    for (const varName of requiredVars) {
      if (!process.env[varName]) {
        missingVars.push(varName);
      }
    }

    if (missingVars.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missingVars.join(', ')}. ` +
        'Please check your .env file and ensure all required variables are set.'
      );
    }
  }

  private loadBotConfig(): BotConfig {
    return {
      botToken: process.env.BOT_API_TOKEN!,
      superAdminUsername: process.env.SUPER_ADMIN_USERNAME!,
      dbPath: process.env.DB_PATH || './data/support.db'
    };
  }

  private loadDatabaseConfig(): DatabaseConfig {
    return {
      path: this.botConfig.dbPath,
      options: {
        verbose: process.env.NODE_ENV === 'development' ? console.log : undefined,
        fileMustExist: false
      }
    };
  }

  public getBotConfig(): BotConfig {
    return { ...this.botConfig };
  }

  public getDatabaseConfig(): DatabaseConfig {
    return { ...this.databaseConfig };
  }
}

// Export singleton instance
export const config = ConfigManager.getInstance();
export { BotConfig, DatabaseConfig } from './types';