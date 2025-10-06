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