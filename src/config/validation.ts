import { VectorServiceConfig } from './types';

export class ConfigValidator {
  /**
   * Validates vector service configuration
   * @param config Vector service configuration to validate
   * @throws Error if configuration is invalid
   */
  public static validateVectorServiceConfig(config: VectorServiceConfig): void {
    const errors: string[] = [];

    // Validate baseUrl
    if (!config.baseUrl || typeof config.baseUrl !== 'string') {
      errors.push('baseUrl must be a non-empty string');
    } else {
      try {
        const url = new URL(config.baseUrl);
        if (!['http:', 'https:'].includes(url.protocol)) {
          errors.push('baseUrl must use HTTP or HTTPS protocol');
        }
      } catch (error) {
        errors.push(`baseUrl must be a valid URL: ${error instanceof Error ? error.message : 'Invalid URL'}`);
      }
    }

    // Validate timeout
    if (!Number.isInteger(config.timeout) || config.timeout < 1000 || config.timeout > 30000) {
      errors.push('timeout must be an integer between 1000 and 30000 milliseconds');
    }

    // Validate retryAttempts
    if (!Number.isInteger(config.retryAttempts) || config.retryAttempts < 1 || config.retryAttempts > 10) {
      errors.push('retryAttempts must be an integer between 1 and 10');
    }

    // Validate retryDelay
    if (!Number.isInteger(config.retryDelay) || config.retryDelay < 100 || config.retryDelay > 10000) {
      errors.push('retryDelay must be an integer between 100 and 10000 milliseconds');
    }

    // Validate similarityThreshold
    if (typeof config.similarityThreshold !== 'number' || 
        config.similarityThreshold < 0.1 || 
        config.similarityThreshold > 1.0) {
      errors.push('similarityThreshold must be a number between 0.1 and 1.0');
    }

    // Validate maxResponseLength
    if (!Number.isInteger(config.maxResponseLength) || 
        config.maxResponseLength < 100 || 
        config.maxResponseLength > 10000) {
      errors.push('maxResponseLength must be an integer between 100 and 10000 characters');
    }

    // Validate enabled flag
    if (typeof config.enabled !== 'boolean') {
      errors.push('enabled must be a boolean value');
    }

    if (errors.length > 0) {
      throw new Error(
        `Vector service configuration validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`
      );
    }
  }

  /**
   * Validates environment variables for vector service
   * @param env Environment variables object (process.env)
   * @returns Array of validation warnings (non-fatal issues)
   */
  public static validateVectorServiceEnvironment(env: NodeJS.ProcessEnv): string[] {
    const warnings: string[] = [];

    // Check for deprecated or unknown vector service environment variables
    const knownVectorVars = [
      'VECTOR_SERVICE_ENABLED',
      'VECTOR_SERVICE_URL',
      'VECTOR_SERVICE_TIMEOUT',
      'VECTOR_SERVICE_RETRY_ATTEMPTS',
      'VECTOR_SERVICE_RETRY_DELAY',
      'VECTOR_SIMILARITY_THRESHOLD',
      'VECTOR_MAX_RESPONSE_LENGTH'
    ];

    // Check for variables that start with VECTOR_ but aren't in our known list
    Object.keys(env).forEach(key => {
      if (key.startsWith('VECTOR_') && !knownVectorVars.includes(key)) {
        warnings.push(`Unknown vector service environment variable: ${key}`);
      }
    });

    // Check for common configuration issues
    if (env.VECTOR_SERVICE_ENABLED === 'true' && !env.VECTOR_SERVICE_URL) {
      warnings.push('Vector service is enabled but VECTOR_SERVICE_URL is not set, using default');
    }

    if (env.VECTOR_SERVICE_URL && !env.VECTOR_SERVICE_URL.startsWith('http')) {
      warnings.push('VECTOR_SERVICE_URL should start with http:// or https://');
    }

    // Check for performance-related configuration warnings
    const timeout = parseInt(env.VECTOR_SERVICE_TIMEOUT || '5000');
    const retryAttempts = parseInt(env.VECTOR_SERVICE_RETRY_ATTEMPTS || '3');
    const retryDelay = parseInt(env.VECTOR_SERVICE_RETRY_DELAY || '1000');

    if (timeout > 10000) {
      warnings.push('VECTOR_SERVICE_TIMEOUT is quite high, this may cause slow response times');
    }

    if (retryAttempts > 5) {
      warnings.push('VECTOR_SERVICE_RETRY_ATTEMPTS is quite high, this may cause long delays on failures');
    }

    if (retryDelay > 5000) {
      warnings.push('VECTOR_SERVICE_RETRY_DELAY is quite high, this may cause long delays between retries');
    }

    const similarityThreshold = parseFloat(env.VECTOR_SIMILARITY_THRESHOLD || '0.7');
    if (similarityThreshold < 0.5) {
      warnings.push('VECTOR_SIMILARITY_THRESHOLD is quite low, this may result in irrelevant automated responses');
    }
    if (similarityThreshold > 0.9) {
      warnings.push('VECTOR_SIMILARITY_THRESHOLD is quite high, this may result in fewer automated responses');
    }

    return warnings;
  }

  /**
   * Provides configuration recommendations based on deployment environment
   * @param env Environment variables object
   * @returns Array of configuration recommendations
   */
  public static getConfigurationRecommendations(env: NodeJS.ProcessEnv): string[] {
    const recommendations: string[] = [];
    const nodeEnv = env.NODE_ENV || 'development';

    if (nodeEnv === 'production') {
      // Production recommendations
      if (env.VECTOR_SERVICE_TIMEOUT && parseInt(env.VECTOR_SERVICE_TIMEOUT) > 8000) {
        recommendations.push('Consider reducing VECTOR_SERVICE_TIMEOUT in production for better user experience');
      }

      if (env.VECTOR_SERVICE_RETRY_ATTEMPTS && parseInt(env.VECTOR_SERVICE_RETRY_ATTEMPTS) > 3) {
        recommendations.push('Consider reducing VECTOR_SERVICE_RETRY_ATTEMPTS in production to avoid long delays');
      }

      if (!env.VECTOR_SERVICE_URL || env.VECTOR_SERVICE_URL.includes('localhost')) {
        recommendations.push('Update VECTOR_SERVICE_URL to point to production vector service instance');
      }
    } else if (nodeEnv === 'development') {
      // Development recommendations
      if (env.VECTOR_SERVICE_TIMEOUT && parseInt(env.VECTOR_SERVICE_TIMEOUT) < 10000) {
        recommendations.push('Consider increasing VECTOR_SERVICE_TIMEOUT in development for easier debugging');
      }

      if (!env.VECTOR_SERVICE_URL || !env.VECTOR_SERVICE_URL.includes('localhost')) {
        recommendations.push('Consider using localhost URL for VECTOR_SERVICE_URL in development');
      }
    }

    // General recommendations
    if (env.VECTOR_SERVICE_ENABLED === 'false') {
      recommendations.push('Vector service is disabled - automated responses will not be available');
    }

    return recommendations;
  }

  /**
   * Validates that vector service configuration is compatible with the current environment
   * @param config Vector service configuration
   * @param env Environment variables
   * @throws Error if configuration is incompatible
   */
  public static validateEnvironmentCompatibility(config: VectorServiceConfig, env: NodeJS.ProcessEnv): void {
    const errors: string[] = [];

    // Check if vector service is enabled but URL points to localhost in production
    if (config.enabled && env.NODE_ENV === 'production' && config.baseUrl.includes('localhost')) {
      errors.push('Vector service URL cannot use localhost in production environment');
    }

    // Check if vector service is disabled but other services depend on it
    if (!config.enabled && env.REQUIRE_VECTOR_SERVICE === 'true') {
      errors.push('Vector service is disabled but REQUIRE_VECTOR_SERVICE is set to true');
    }

    if (errors.length > 0) {
      throw new Error(
        `Vector service environment compatibility validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`
      );
    }
  }
}

/**
 * Utility function to validate and log configuration status
 * @param config Vector service configuration
 * @param env Environment variables
 */
export function validateAndLogVectorServiceConfig(config: VectorServiceConfig, env: NodeJS.ProcessEnv): void {
  try {
    // Validate configuration
    ConfigValidator.validateVectorServiceConfig(config);
    ConfigValidator.validateEnvironmentCompatibility(config, env);

    console.log('✅ Vector service configuration validation passed');

    // Log warnings
    const warnings = ConfigValidator.validateVectorServiceEnvironment(env);
    if (warnings.length > 0) {
      console.warn('⚠️ Vector service configuration warnings:');
      warnings.forEach(warning => console.warn(`   ${warning}`));
    }

    // Log recommendations
    const recommendations = ConfigValidator.getConfigurationRecommendations(env);
    if (recommendations.length > 0) {
      console.log('💡 Vector service configuration recommendations:');
      recommendations.forEach(rec => console.log(`   ${rec}`));
    }

    // Log current configuration (without sensitive data)
    console.log('🔧 Vector service configuration:');
    console.log(`   Enabled: ${config.enabled}`);
    console.log(`   Base URL: ${config.baseUrl}`);
    console.log(`   Timeout: ${config.timeout}ms`);
    console.log(`   Retry attempts: ${config.retryAttempts}`);
    console.log(`   Retry delay: ${config.retryDelay}ms`);
    console.log(`   Similarity threshold: ${config.similarityThreshold}`);
    console.log(`   Max response length: ${config.maxResponseLength}`);

  } catch (error) {
    console.error('❌ Vector service configuration validation failed:');
    console.error(error instanceof Error ? error.message : String(error));
    throw error;
  }
}