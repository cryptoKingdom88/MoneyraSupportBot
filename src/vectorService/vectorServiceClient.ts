import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import {
  VectorServiceConfig,
  VectorResponse,
  SearchResponse,
  HealthResponse,
  AddVectorRequest,
  UpdateVectorRequest,
  DeleteVectorRequest,
  SearchVectorRequest,
  VectorServiceError,
  VectorServiceErrorDetails
} from './types';
import { VectorServiceErrorHandler } from './errorHandler';

export class VectorServiceClient {
  private config: VectorServiceConfig;
  private errorHandler: VectorServiceErrorHandler;

  constructor(config: VectorServiceConfig) {
    this.config = config;
    this.errorHandler = VectorServiceErrorHandler.getInstance();
  }

  public async addVector(kbId: number, inputText: string, answer: string): Promise<VectorResponse> {
    const operation = 'addVector';

    if (!this.config.enabled) {
      console.log(`🔶 Vector service disabled, skipping ${operation}`);
      return { success: true, message: 'Vector service disabled' };
    }

    const request: AddVectorRequest = {
      id: kbId,
      input_text: inputText,
      answer: answer
    };

    return this.retryWithExponentialBackoff(
      () => this.makeRequest('POST', '/vectors/add', request),
      operation,
      { kbId, inputText, answer }
    );
  }

  public async updateVector(kbId: number, inputText: string, answer: string): Promise<VectorResponse> {
    const operation = 'updateVector';

    if (!this.config.enabled) {
      console.log(`🔶 Vector service disabled, skipping ${operation}`);
      return { success: true, message: 'Vector service disabled' };
    }

    const request: UpdateVectorRequest = {
      id: kbId,
      input_text: inputText,
      answer: answer
    };

    return this.retryWithExponentialBackoff(
      () => this.makeRequest('PUT', '/vectors/update', request),
      operation,
      { kbId, inputText, answer }
    );
  }

  public async deleteVector(kbId: number): Promise<VectorResponse> {
    const operation = 'deleteVector';

    if (!this.config.enabled) {
      console.log(`🔶 Vector service disabled, skipping ${operation}`);
      return { success: true, message: 'Vector service disabled' };
    }

    const request: DeleteVectorRequest = {
      id: kbId
    };

    return this.retryWithExponentialBackoff(
      () => this.makeRequest('DELETE', '/vectors/delete', request),
      operation,
      { kbId }
    );
  }

  public async searchSimilar(query: string): Promise<SearchResponse> {
    const operation = 'searchSimilar';

    if (!this.config.enabled) {
      console.log(`🔶 Vector service disabled, skipping ${operation}`);
      return {
        success: true,
        match_found: false,
        message: 'Vector service disabled'
      };
    }

    const request: SearchVectorRequest = {
      query: query
    };

    return this.retryWithExponentialBackoff(
      () => this.makeRequest('POST', '/vectors/search', request),
      operation,
      { query }
    );
  }

  public async healthCheck(): Promise<HealthResponse> {
    const operation = 'healthCheck';

    if (!this.config.enabled) {
      return {
        status: 'disabled',
        message: 'Vector service is disabled'
      };
    }

    try {
      return await this.makeRequest('GET', '/health');
    } catch (error) {
      console.error(`🔴 Health check failed:`, error);
      return {
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  public async generateEmbedding(text: string): Promise<{ success: boolean; embedding?: number[]; message?: string }> {
    const operation = 'generateEmbedding';

    if (!this.config.enabled) {
      console.log(`🔶 Vector service disabled, skipping ${operation}`);
      return { success: true, message: 'Vector service disabled' };
    }

    const request = {
      text: text
    };

    return this.retryWithExponentialBackoff(
      () => this.makeRequest('POST', '/vectors/embed', request),
      operation,
      { text }
    );
  }

  private async retryWithExponentialBackoff<T>(
    operation: () => Promise<T>,
    operationName: string,
    operationData?: any
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
      try {
        console.log(`🔄 Vector service ${operationName} attempt ${attempt}/${this.config.retryAttempts}`);
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt === this.config.retryAttempts) {
          console.error(`🔴 Vector service ${operationName} failed after ${this.config.retryAttempts} attempts:`, lastError.message);
          break;
        }

        const delay = this.config.retryDelay * Math.pow(2, attempt - 1);
        console.warn(`⚠️ Vector service ${operationName} attempt ${attempt} failed, retrying in ${delay}ms:`, lastError.message);

        await this.sleep(delay);
      }
    }

    // Handle the final error
    const errorDetails = this.categorizeError(lastError!, operationName);
    await this.handleError(errorDetails, operationData);

    // Return appropriate fallback response
    return this.getFallbackResponse<T>(operationName);
  }

  private async makeRequest<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    data?: any
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      try {
        const url = new URL(path, this.config.baseUrl);
        const isHttps = url.protocol === 'https:';
        const httpModule = isHttps ? https : http;

        const requestData = data ? JSON.stringify(data) : undefined;

        const options: http.RequestOptions = {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method: method,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'VectorServiceClient/1.0',
            ...(requestData && { 'Content-Length': Buffer.byteLength(requestData) })
          },
          timeout: this.config.timeout
        };

        const req = httpModule.request(options, (res) => {
          let responseData = '';

          res.on('data', (chunk) => {
            responseData += chunk;
          });

          res.on('end', () => {
            try {
              const statusCode = res.statusCode || 0;

              if (statusCode >= 200 && statusCode < 300) {
                const parsedResponse = responseData ? JSON.parse(responseData) : {};
                resolve(parsedResponse);
              } else {
                const errorMessage = `HTTP ${statusCode}: ${responseData || 'Unknown error'}`;
                reject(new Error(errorMessage));
              }
            } catch (parseError) {
              reject(new Error(`Failed to parse response: ${parseError}`));
            }
          });
        });

        req.on('error', (error) => {
          reject(error);
        });

        req.on('timeout', () => {
          req.destroy();
          reject(new Error(`Request timeout after ${this.config.timeout}ms`));
        });

        if (requestData) {
          req.write(requestData);
        }

        req.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  private categorizeError(error: Error, operation: string): VectorServiceErrorDetails {
    const message = error.message.toLowerCase();

    if (message.includes('timeout')) {
      return this.errorHandler.createErrorDetails(
        VectorServiceError.TIMEOUT,
        error.message,
        operation
      );
    }

    if (message.includes('econnrefused') || message.includes('enotfound') || message.includes('econnreset')) {
      return this.errorHandler.createErrorDetails(
        VectorServiceError.SERVICE_UNAVAILABLE,
        error.message,
        operation
      );
    }

    if (message.includes('network') || message.includes('socket')) {
      return this.errorHandler.createErrorDetails(
        VectorServiceError.NETWORK_ERROR,
        error.message,
        operation
      );
    }

    if (message.includes('parse') || message.includes('json')) {
      return this.errorHandler.createErrorDetails(
        VectorServiceError.INVALID_RESPONSE,
        error.message,
        operation
      );
    }

    // Default to network error for unknown errors
    return this.errorHandler.createErrorDetails(
      VectorServiceError.NETWORK_ERROR,
      error.message,
      operation,
      undefined,
      error
    );
  }

  private async handleError(errorDetails: VectorServiceErrorDetails, operationData?: any): Promise<void> {
    switch (errorDetails.error) {
      case VectorServiceError.SERVICE_UNAVAILABLE:
        await this.errorHandler.handleServiceUnavailable(errorDetails.operation, operationData);
        break;
      case VectorServiceError.TIMEOUT:
        await this.errorHandler.handleTimeout(errorDetails.operation, operationData);
        break;
      case VectorServiceError.NETWORK_ERROR:
        await this.errorHandler.handleNetworkError(
          errorDetails.originalError || new Error(errorDetails.message),
          errorDetails.operation,
          operationData
        );
        break;
      default:
        this.errorHandler.logVectorServiceError(errorDetails.error, errorDetails);
    }

    // Check for service degradation and handle accordingly
    await this.errorHandler.handleGracefulDegradation();
  }

  private getFallbackResponse<T>(operationName: string): T {
    switch (operationName) {
      case 'addVector':
      case 'updateVector':
      case 'deleteVector':
        return {
          success: false,
          message: 'Vector service unavailable, operation skipped'
        } as T;
      case 'searchSimilar':
        return {
          success: false,
          matchFound: false,
          message: 'Vector service unavailable, no automated response available'
        } as T;
      default:
        return {
          success: false,
          message: 'Vector service unavailable'
        } as T;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }



  public isEnabled(): boolean {
    return this.config.enabled;
  }

  public getConfig(): VectorServiceConfig {
    return { ...this.config };
  }
}