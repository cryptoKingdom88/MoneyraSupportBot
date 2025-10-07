import { VectorServiceClient } from './vectorServiceClient';
import { VectorServiceConfig, VectorServiceError } from './types';

export interface VectorOperation {
  id: string;
  type: 'add' | 'update' | 'delete' | 'search';
  data: any;
  timestamp: number;
  retryCount: number;
}

export class VectorServiceRecovery {
  private static instance: VectorServiceRecovery;
  private failedOperations: Map<string, VectorOperation> = new Map();
  private recoveryInterval?: NodeJS.Timeout;
  private isRecoveryRunning = false;

  public static getInstance(): VectorServiceRecovery {
    if (!VectorServiceRecovery.instance) {
      VectorServiceRecovery.instance = new VectorServiceRecovery();
    }
    return VectorServiceRecovery.instance;
  }

  public startRecoveryProcess(intervalMs: number = 60000): void {
    if (this.recoveryInterval) {
      clearInterval(this.recoveryInterval);
    }

    this.recoveryInterval = setInterval(async () => {
      if (!this.isRecoveryRunning && this.failedOperations.size > 0) {
        await this.processQueuedOperations();
      }
    }, intervalMs);

    console.log(`🔄 Vector service recovery process started (interval: ${intervalMs}ms)`);
  }

  public stopRecoveryProcess(): void {
    if (this.recoveryInterval) {
      clearInterval(this.recoveryInterval);
      this.recoveryInterval = undefined;
    }
    console.log('🛑 Vector service recovery process stopped');
  }

  public queueFailedOperation(operation: VectorOperation): void {
    const maxQueueSize = 1000; // Prevent memory issues
    
    if (this.failedOperations.size >= maxQueueSize) {
      // Remove oldest operation
      const oldestKey = this.failedOperations.keys().next().value;
      if (oldestKey) {
        this.failedOperations.delete(oldestKey);
        console.warn(`⚠️ Vector service queue full, removed oldest operation: ${oldestKey}`);
      }
    }

    this.failedOperations.set(operation.id, operation);
    console.log(`📝 Queued failed vector operation: ${operation.type} (${operation.id})`);
  }

  public async processQueuedOperations(): Promise<void> {
    if (this.isRecoveryRunning || this.failedOperations.size === 0) {
      return;
    }

    this.isRecoveryRunning = true;
    console.log(`🔄 Processing ${this.failedOperations.size} queued vector operations`);

    const operations = Array.from(this.failedOperations.values());
    const maxRetries = 3;
    const processedOperations: string[] = [];

    for (const operation of operations) {
      try {
        if (operation.retryCount >= maxRetries) {
          console.warn(`⚠️ Dropping operation ${operation.id} after ${maxRetries} retries`);
          processedOperations.push(operation.id);
          continue;
        }

        // Check if operation is too old (24 hours)
        const ageMs = Date.now() - operation.timestamp;
        if (ageMs > 24 * 60 * 60 * 1000) {
          console.warn(`⚠️ Dropping old operation ${operation.id} (age: ${Math.round(ageMs / 1000 / 60)} minutes)`);
          processedOperations.push(operation.id);
          continue;
        }

        // Attempt to process the operation
        const success = await this.retryOperation(operation);
        if (success) {
          console.log(`✅ Successfully processed queued operation: ${operation.type} (${operation.id})`);
          processedOperations.push(operation.id);
        } else {
          // Increment retry count
          operation.retryCount++;
          this.failedOperations.set(operation.id, operation);
        }

      } catch (error) {
        console.error(`🔴 Error processing queued operation ${operation.id}:`, error);
        operation.retryCount++;
        this.failedOperations.set(operation.id, operation);
      }
    }

    // Remove processed operations
    processedOperations.forEach(id => this.failedOperations.delete(id));

    console.log(`✅ Recovery process completed. Remaining queued operations: ${this.failedOperations.size}`);
    this.isRecoveryRunning = false;
  }

  private async retryOperation(operation: VectorOperation): Promise<boolean> {
    // This would need a VectorServiceClient instance
    // For now, we'll just simulate the retry logic
    console.log(`🔄 Retrying operation: ${operation.type} (${operation.id}), attempt ${operation.retryCount + 1}`);
    
    // In a real implementation, you would:
    // 1. Get a VectorServiceClient instance
    // 2. Call the appropriate method based on operation.type
    // 3. Return true if successful, false if failed
    
    return false; // Placeholder - would be implemented when integrated with actual client
  }

  public async validateServiceHealth(client: VectorServiceClient): Promise<boolean> {
    try {
      const healthResponse = await client.healthCheck();
      const isHealthy = healthResponse.status === 'healthy';
      
      if (isHealthy) {
        console.log('✅ Vector service health check passed');
      } else {
        console.warn(`⚠️ Vector service health check failed: ${healthResponse.message}`);
      }
      
      return isHealthy;
    } catch (error) {
      console.error('🔴 Vector service health check error:', error);
      return false;
    }
  }

  public getQueuedOperationsCount(): number {
    return this.failedOperations.size;
  }

  public clearQueue(): void {
    const count = this.failedOperations.size;
    this.failedOperations.clear();
    console.log(`🗑️ Cleared ${count} queued vector operations`);
  }

  public getQueuedOperations(): VectorOperation[] {
    return Array.from(this.failedOperations.values());
  }
}