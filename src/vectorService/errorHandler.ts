import { VectorServiceError, VectorServiceErrorDetails } from './types';
import { VectorServiceRecovery, VectorOperation } from './recovery';

export class VectorServiceErrorHandler {
  private static instance: VectorServiceErrorHandler;
  private recovery: VectorServiceRecovery;
  private errorCounts: Map<VectorServiceError, number> = new Map();
  private lastErrorTime: Map<VectorServiceError, number> = new Map();

  public static getInstance(): VectorServiceErrorHandler {
    if (!VectorServiceErrorHandler.instance) {
      VectorServiceErrorHandler.instance = new VectorServiceErrorHandler();
    }
    return VectorServiceErrorHandler.instance;
  }

  private constructor() {
    this.recovery = VectorServiceRecovery.getInstance();
  }

  public async handleServiceUnavailable(operation: string, operationData?: any): Promise<void> {
    this.incrementErrorCount(VectorServiceError.SERVICE_UNAVAILABLE);
    
    console.warn(`🔶 Vector service unavailable for operation: ${operation}. Continuing without vector functionality.`);
    this.logVectorServiceError(VectorServiceError.SERVICE_UNAVAILABLE, { operation });
    
    // Queue operation for retry if it's a data modification operation
    if (operationData && this.isDataModificationOperation(operation)) {
      this.queueOperationForRetry(operation, operationData);
    }
  }

  public async handleTimeout(operation: string, operationData?: any): Promise<void> {
    this.incrementErrorCount(VectorServiceError.TIMEOUT);
    
    console.warn(`⏱️ Vector service timeout for operation: ${operation}. Continuing without vector functionality.`);
    this.logVectorServiceError(VectorServiceError.TIMEOUT, { operation });
    
    // Queue operation for retry if it's a data modification operation
    if (operationData && this.isDataModificationOperation(operation)) {
      this.queueOperationForRetry(operation, operationData);
    }
  }

  public async handleNetworkError(error: Error, operation: string, operationData?: any): Promise<void> {
    this.incrementErrorCount(VectorServiceError.NETWORK_ERROR);
    
    console.error(`🌐 Vector service network error for operation: ${operation}:`, error.message);
    this.logVectorServiceError(VectorServiceError.NETWORK_ERROR, { operation, error });
    
    // Queue operation for retry if it's a data modification operation
    if (operationData && this.isDataModificationOperation(operation)) {
      this.queueOperationForRetry(operation, operationData);
    }
  }

  public logVectorServiceError(error: VectorServiceError, context: any): void {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      error,
      context,
      level: 'ERROR'
    };

    console.error(`🔴 Vector Service Error [${timestamp}]:`, JSON.stringify(logEntry, null, 2));
  }

  public createErrorDetails(
    error: VectorServiceError,
    message: string,
    operation: string,
    statusCode?: number,
    originalError?: Error
  ): VectorServiceErrorDetails {
    return {
      error,
      message,
      operation,
      statusCode,
      originalError
    };
  }

  public isRetryableError(error: VectorServiceError): boolean {
    return [
      VectorServiceError.TIMEOUT,
      VectorServiceError.NETWORK_ERROR,
      VectorServiceError.SERVICE_UNAVAILABLE
    ].includes(error);
  }

  public shouldFallbackToNormalOperation(error: VectorServiceError): boolean {
    // All vector service errors should allow fallback to normal operation
    return true;
  }

  private incrementErrorCount(error: VectorServiceError): void {
    const currentCount = this.errorCounts.get(error) || 0;
    this.errorCounts.set(error, currentCount + 1);
    this.lastErrorTime.set(error, Date.now());
  }

  private isDataModificationOperation(operation: string): boolean {
    return ['addVector', 'updateVector', 'deleteVector'].includes(operation);
  }

  private queueOperationForRetry(operation: string, operationData: any): void {
    const vectorOperation: VectorOperation = {
      id: `${operation}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: this.mapOperationToType(operation),
      data: operationData,
      timestamp: Date.now(),
      retryCount: 0
    };

    this.recovery.queueFailedOperation(vectorOperation);
  }

  private mapOperationToType(operation: string): 'add' | 'update' | 'delete' | 'search' {
    switch (operation) {
      case 'addVector':
        return 'add';
      case 'updateVector':
        return 'update';
      case 'deleteVector':
        return 'delete';
      case 'searchSimilar':
        return 'search';
      default:
        return 'search';
    }
  }

  public getErrorStatistics(): { [key in VectorServiceError]?: { count: number; lastOccurrence: number } } {
    const stats: { [key in VectorServiceError]?: { count: number; lastOccurrence: number } } = {};
    
    for (const [error, count] of this.errorCounts.entries()) {
      stats[error] = {
        count,
        lastOccurrence: this.lastErrorTime.get(error) || 0
      };
    }
    
    return stats;
  }

  public resetErrorStatistics(): void {
    this.errorCounts.clear();
    this.lastErrorTime.clear();
    console.log('🔄 Vector service error statistics reset');
  }

  public isServiceDegraded(): boolean {
    const now = Date.now();
    const degradationThreshold = 5; // 5 errors in the last 5 minutes indicates degradation
    const timeWindow = 5 * 60 * 1000; // 5 minutes

    let recentErrors = 0;
    for (const [error, lastTime] of this.lastErrorTime.entries()) {
      if (now - lastTime < timeWindow) {
        recentErrors += this.errorCounts.get(error) || 0;
      }
    }

    return recentErrors >= degradationThreshold;
  }

  public async handleGracefulDegradation(): Promise<void> {
    if (this.isServiceDegraded()) {
      console.warn('⚠️ Vector service is degraded. Implementing graceful degradation strategies.');
      
      // Log degradation event
      this.logVectorServiceError(VectorServiceError.SERVICE_UNAVAILABLE, {
        operation: 'graceful_degradation',
        message: 'Service degraded, implementing fallback strategies',
        errorStats: this.getErrorStatistics()
      });
      
      // Could implement additional degradation strategies here:
      // - Increase timeout values
      // - Reduce retry attempts
      // - Disable non-critical vector operations
      // - Send alerts to administrators
    }
  }
}