export interface BotConfig {
  botToken: string;
  superAdminUsername: string;
  dbPath: string;
}

export interface DatabaseConfig {
  path: string;
  options?: {
    verbose?: (message?: unknown, ...additionalArgs: unknown[]) => void;
    fileMustExist?: boolean;
  };
}

export interface VectorServiceConfig {
  enabled: boolean;
  baseUrl: string;
  timeout: number;
  retryAttempts: number;
  retryDelay: number;
  similarityThreshold: number;
  maxResponseLength: number;
}