import * as dotenv from 'dotenv';
import { BotConfig, DatabaseConfig, VectorServiceConfig } from './types';
import { validateAndLogVectorServiceConfig } from './validation';

// Load environment variables from .env file
dotenv.config();

class ConfigManager {
  private static instance: ConfigManager;
  private botConfig: BotConfig;
  private databaseConfig: DatabaseConfig;
  private vectorServiceConfig: VectorServiceConfig;

  private constructor() {
    this.validateEnvironmentVariables();
    this.botConfig = this.loadBotConfig();
    this.databaseConfig = this.loadDatabaseConfig();
    this.vectorServiceConfig = this.loadVectorServiceConfig();
    
    // Validate vector service configuration
    validateAndLogVectorServiceConfig(this.vectorServiceConfig, process.env);
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

  private loadVectorServiceConfig(): VectorServiceConfig {
    // Parse boolean values with proper defaults
    const enabled = this.parseBoolean(process.env.VECTOR_SERVICE_ENABLED, true);
    
    // Parse numeric values with validation
    const timeout = this.parseNumber(process.env.VECTOR_SERVICE_TIMEOUT, 5000, 1000, 30000);
    const retryAttempts = this.parseNumber(process.env.VECTOR_SERVICE_RETRY_ATTEMPTS, 3, 1, 10);
    const retryDelay = this.parseNumber(process.env.VECTOR_SERVICE_RETRY_DELAY, 1000, 100, 10000);
    const similarityThreshold = this.parseNumber(process.env.VECTOR_SIMILARITY_THRESHOLD, 0.7, 0.1, 1.0);
    const maxResponseLength = this.parseNumber(process.env.VECTOR_MAX_RESPONSE_LENGTH, 2000, 100, 10000);
    
    // Validate base URL
    const baseUrl = process.env.VECTOR_SERVICE_URL || 'http://localhost:8000';
    this.validateUrl(baseUrl);

    return {
      enabled,
      baseUrl,
      timeout,
      retryAttempts,
      retryDelay,
      similarityThreshold,
      maxResponseLength
    };
  }

  private parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
    if (!value) return defaultValue;
    
    const lowerValue = value.toLowerCase().trim();
    if (lowerValue === 'true' || lowerValue === '1' || lowerValue === 'yes') {
      return true;
    }
    if (lowerValue === 'false' || lowerValue === '0' || lowerValue === 'no') {
      return false;
    }
    
    console.warn(`⚠️ Invalid boolean value "${value}", using default: ${defaultValue}`);
    return defaultValue;
  }

  private parseNumber(value: string | undefined, defaultValue: number, min?: number, max?: number): number {
    if (!value) return defaultValue;
    
    const parsed = parseFloat(value);
    if (isNaN(parsed)) {
      console.warn(`⚠️ Invalid number value "${value}", using default: ${defaultValue}`);
      return defaultValue;
    }
    
    if (min !== undefined && parsed < min) {
      console.warn(`⚠️ Value ${parsed} is below minimum ${min}, using minimum`);
      return min;
    }
    
    if (max !== undefined && parsed > max) {
      console.warn(`⚠️ Value ${parsed} is above maximum ${max}, using maximum`);
      return max;
    }
    
    return parsed;
  }

  private validateUrl(url: string): void {
    try {
      new URL(url);
    } catch (error) {
      throw new Error(`Invalid vector service URL: ${url}. Please provide a valid HTTP/HTTPS URL.`);
    }
  }

  public getBotConfig(): BotConfig {
    return { ...this.botConfig };
  }

  public getDatabaseConfig(): DatabaseConfig {
    return { ...this.databaseConfig };
  }

  public getVectorServiceConfig(): VectorServiceConfig {
    return { ...this.vectorServiceConfig };
  }
}

// Export singleton instance
export const config = ConfigManager.getInstance();
export { BotConfig, DatabaseConfig, VectorServiceConfig } from './types';