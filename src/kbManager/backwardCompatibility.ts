import Database from 'better-sqlite3';
import { KBManager } from './kbManager';
import { VectorServiceClient } from '../vectorService/vectorServiceClient';
import { config } from '../config/config';

/**
 * Factory function to create KB Manager with backward compatibility
 * This ensures existing code continues to work while adding vector capabilities when available
 */
export function createKBManager(database: Database.Database, vectorClient?: VectorServiceClient): KBManager {
  const kbManager = new KBManager(database);
  
  // Only set up vector integration if:
  // 1. Vector service is enabled in config
  // 2. Vector client is provided
  // 3. Vector service is actually available
  if (config.getVectorServiceConfig().enabled && vectorClient) {
    try {
      kbManager.setVectorIntegration(vectorClient);
      console.log('✅ KB Manager initialized with vector integration');
    } catch (error) {
      console.warn('⚠️ Failed to initialize vector integration, falling back to basic KB operations:', error);
    }
  } else {
    console.log('ℹ️ KB Manager initialized without vector integration (disabled or client not provided)');
  }
  
  return kbManager;
}

/**
 * Legacy KB Manager factory for complete backward compatibility
 * This creates a KB manager that works exactly like the original implementation
 */
export function createLegacyKBManager(database: Database.Database): KBManager {
  const kbManager = new KBManager(database);
  console.log('ℹ️ Legacy KB Manager initialized (no vector integration)');
  return kbManager;
}

/**
 * Feature flag checker for vector functionality
 */
export class FeatureFlags {
  public static isVectorServiceEnabled(): boolean {
    return config.getVectorServiceConfig().enabled;
  }
  
  public static shouldUseVectorIntegration(): boolean {
    return this.isVectorServiceEnabled();
  }
  
  public static getVectorServiceConfig() {
    return config.getVectorServiceConfig();
  }
  
  /**
   * Check if vector service is available and healthy
   */
  public static async checkVectorServiceHealth(vectorClient?: VectorServiceClient): Promise<boolean> {
    if (!this.isVectorServiceEnabled() || !vectorClient) {
      return false;
    }
    
    try {
      const healthResponse = await vectorClient.healthCheck();
      return healthResponse.status === 'healthy';
    } catch (error) {
      console.warn('Vector service health check failed:', error);
      return false;
    }
  }
}

/**
 * Graceful degradation helper for vector operations
 */
export class VectorServiceFallback {
  /**
   * Execute a vector operation with fallback to non-vector operation
   */
  public static async executeWithFallback<T>(
    vectorOperation: () => Promise<T>,
    fallbackOperation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    if (!FeatureFlags.isVectorServiceEnabled()) {
      console.log(`Vector service disabled, using fallback for ${operationName}`);
      return await fallbackOperation();
    }
    
    try {
      return await vectorOperation();
    } catch (error) {
      console.warn(`Vector operation ${operationName} failed, falling back to basic operation:`, error);
      return await fallbackOperation();
    }
  }
  
  /**
   * Execute vector operation with graceful failure (don't fallback, just log)
   */
  public static async executeWithGracefulFailure<T>(
    operation: () => Promise<T>,
    operationName: string,
    defaultValue: T
  ): Promise<T> {
    if (!FeatureFlags.isVectorServiceEnabled()) {
      console.log(`Vector service disabled, skipping ${operationName}`);
      return defaultValue;
    }
    
    try {
      return await operation();
    } catch (error) {
      console.warn(`Vector operation ${operationName} failed gracefully:`, error);
      return defaultValue;
    }
  }
}