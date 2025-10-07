export interface VectorServiceConfig {
  enabled: boolean;
  baseUrl: string;
  timeout: number;
  retryAttempts: number;
  retryDelay: number;
  similarityThreshold: number;
  maxResponseLength: number;
}

export interface VectorResponse {
  success: boolean;
  vector_data?: number[];
  message: string;
}

export interface SearchResponse {
  success: boolean;
  match_found: boolean;
  similarity_score?: number;
  kb_id?: number;
  answer?: string;
  message: string;
}

export interface HealthResponse {
  status: string;
  index_size?: number;
  message?: string;
}

export interface AddVectorRequest {
  id: number;
  input_text: string;
  answer: string;
}

export interface UpdateVectorRequest {
  id: number;
  input_text: string;
  answer: string;
}

export interface DeleteVectorRequest {
  id: number;
}

export interface SearchVectorRequest {
  query: string;
}

export enum VectorServiceError {
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  TIMEOUT = 'TIMEOUT',
  INVALID_RESPONSE = 'INVALID_RESPONSE',
  NETWORK_ERROR = 'NETWORK_ERROR',
  AUTHENTICATION_ERROR = 'AUTHENTICATION_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR'
}

export interface VectorServiceErrorDetails {
  error: VectorServiceError;
  message: string;
  operation: string;
  statusCode?: number;
  originalError?: Error;
}