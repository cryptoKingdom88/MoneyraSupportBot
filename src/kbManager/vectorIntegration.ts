import { VectorServiceClient } from '../vectorService/vectorServiceClient';
import { VectorServiceConfig, VectorServiceError, VectorServiceErrorDetails } from '../vectorService/types';
import { config } from '../config/config';

export interface AutoResponseResult {
  kbId: number;
  answer: string;
  similarityScore: number;
  confidence: 'high' | 'medium' | 'low';
}

export interface VectorIntegration {
  syncVectorOnAdd(kbId: number, question: string, context: string, answer: string): Promise<void>;
  syncVectorOnUpdate(kbId: number, question: string, context: string, answer: string): Promise<void>;
  syncVectorOnDelete(kbId: number): Promise<void>;
  searchSimilarContent(query: string): Promise<AutoResponseResult | null>;
  generateEmbedding(question: string, answer: string): Promise<number[] | null>;
  isVectorServiceEnabled(): boolean;
}

export class VectorIntegrationImpl implements VectorIntegration {
  private vectorClient: VectorServiceClient;
  private vectorConfig: VectorServiceConfig;

  constructor(vectorClient: VectorServiceClient) {
    this.vectorClient = vectorClient;
    this.vectorConfig = config.getVectorServiceConfig();
  }

  public isVectorServiceEnabled(): boolean {
    return this.vectorConfig.enabled;
  }

  public async syncVectorOnAdd(kbId: number, question: string, context: string, answer: string): Promise<void> {
    if (!this.isVectorServiceEnabled()) {
      console.log('Vector service disabled, skipping vector sync for add operation');
      return;
    }

    try {
      // Check if vector service is healthy before attempting operation
      const healthCheck = await this.vectorClient.healthCheck();
      if (healthCheck.status !== 'healthy') {
        console.warn(`Vector service unhealthy, skipping sync for KB entry ${kbId}`);
        this.logVectorOperation('add', kbId, false, 'Service unhealthy');
        return;
      }

      const inputText = this.combineQuestionAndContext(question, context);
      const response = await this.vectorClient.addVector(kbId, inputText, answer);

      if (!response.success) {
        console.warn(`Vector sync failed for KB entry ${kbId}: ${response.message}`);
        this.logVectorOperation('add', kbId, false, response.message);
      } else {
        console.log(`Vector sync successful for KB entry ${kbId}`);
        this.logVectorOperation('add', kbId, true);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Vector sync error for KB entry ${kbId}:`, errorMessage);
      this.logVectorOperation('add', kbId, false, errorMessage);

      // Don't throw error - allow KB operation to complete even if vector sync fails
      // This ensures backward compatibility and graceful degradation
    }
  }

  public async syncVectorOnUpdate(kbId: number, question: string, context: string, answer: string): Promise<void> {
    if (!this.isVectorServiceEnabled()) {
      console.log('Vector service disabled, skipping vector sync for update operation');
      return;
    }

    try {
      // Check if vector service is healthy before attempting operation
      const healthCheck = await this.vectorClient.healthCheck();
      if (healthCheck.status !== 'healthy') {
        console.warn(`Vector service unhealthy, skipping update for KB entry ${kbId}`);
        this.logVectorOperation('update', kbId, false, 'Service unhealthy');
        return;
      }

      const inputText = this.combineQuestionAndContext(question, context);
      const response = await this.vectorClient.updateVector(kbId, inputText, answer);

      if (!response.success) {
        console.warn(`Vector update failed for KB entry ${kbId}: ${response.message}`);
        this.logVectorOperation('update', kbId, false, response.message);
      } else {
        console.log(`Vector update successful for KB entry ${kbId}`);
        this.logVectorOperation('update', kbId, true);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Vector update error for KB entry ${kbId}:`, errorMessage);
      this.logVectorOperation('update', kbId, false, errorMessage);

      // Don't throw error - allow KB operation to complete even if vector sync fails
      // This ensures backward compatibility and graceful degradation
    }
  }

  public async syncVectorOnDelete(kbId: number): Promise<void> {
    if (!this.isVectorServiceEnabled()) {
      console.log('Vector service disabled, skipping vector sync for delete operation');
      return;
    }

    try {
      // Check if vector service is healthy before attempting operation
      const healthCheck = await this.vectorClient.healthCheck();
      if (healthCheck.status !== 'healthy') {
        console.warn(`Vector service unhealthy, skipping delete for KB entry ${kbId}`);
        this.logVectorOperation('delete', kbId, false, 'Service unhealthy');
        return;
      }

      const response = await this.vectorClient.deleteVector(kbId);

      if (!response.success) {
        console.warn(`Vector delete failed for KB entry ${kbId}: ${response.message}`);
        this.logVectorOperation('delete', kbId, false, response.message);
      } else {
        console.log(`Vector delete successful for KB entry ${kbId}`);
        this.logVectorOperation('delete', kbId, true);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Vector delete error for KB entry ${kbId}:`, errorMessage);
      this.logVectorOperation('delete', kbId, false, errorMessage);

      // Don't throw error - allow KB operation to complete even if vector sync fails
      // This ensures backward compatibility and graceful degradation
    }
  }

  public async searchSimilarContent(query: string): Promise<AutoResponseResult | null> {
    if (!this.isVectorServiceEnabled()) {
      console.log('Vector service disabled, skipping similarity search');
      return null;
    }

    try {
      // Check if vector service is healthy before attempting search
      const healthCheck = await this.vectorClient.healthCheck();
      if (healthCheck.status !== 'healthy') {
        console.warn('Vector service unhealthy, skipping similarity search');
        this.logVectorOperation('search', null, false, 'Service unhealthy');
        return null;
      }

      const response = await this.vectorClient.searchSimilar(query);

      if (!response.success) {
        console.warn(`Vector search failed: ${response.message}`);
        this.logVectorOperation('search', null, false, response.message);
        return null;
      }

      if (!response.match_found || !response.kb_id || !response.answer || response.similarity_score === undefined) {
        console.log('No high-similarity match found for query');
        this.logVectorOperation('search', null, true, 'No match found');
        return null;
      }

      const confidence = this.calculateConfidence(response.similarity_score);

      // Only return results above the configured threshold
      if (response.similarity_score < this.vectorConfig.similarityThreshold) {
        console.log(`Similarity score ${response.similarity_score} below threshold ${this.vectorConfig.similarityThreshold}`);
        this.logVectorOperation('search', response.kb_id, true, 'Below threshold');
        return null;
      }

      console.log(`Found similar content: KB ID ${response.kb_id}, similarity: ${response.similarity_score}`);
      this.logVectorOperation('search', response.kb_id, true, `Match found with score ${response.similarity_score}`);

      return {
        kbId: response.kb_id,
        answer: response.answer,
        similarityScore: response.similarity_score,
        confidence
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Vector search error:', errorMessage);
      this.logVectorOperation('search', null, false, errorMessage);

      // Return null for graceful degradation - the system will fall back to normal manager notification
      return null;
    }
  }

  public async generateEmbedding(question: string, answer: string): Promise<number[] | null> {
    if (!this.isVectorServiceEnabled()) {
      console.log('Vector service disabled, skipping embedding generation');
      return null;
    }

    try {
      // Check if vector service is healthy before attempting embedding generation
      const healthCheck = await this.vectorClient.healthCheck();
      if (healthCheck.status !== 'healthy') {
        console.warn('Vector service unhealthy, skipping embedding generation');
        return null;
      }

      // Combine question and answer for embedding
      const combinedText = this.combineQuestionAndAnswer(question, answer);

      // Generate embedding via vector service
      const response = await this.vectorClient.generateEmbedding(combinedText);

      if (!response.success || !response.embedding) {
        console.warn(`Embedding generation failed: ${response.message}`);
        return null;
      }

      console.log(`Generated embedding with ${response.embedding.length} dimensions`);
      return response.embedding;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Embedding generation error:', errorMessage);
      return null;
    }
  }

  private combineQuestionAndContext(question: string, context: string): string {
    // Combine question and context for better embedding generation
    if (context && context.trim()) {
      return `${question} ${context}`;
    }
    return question;
  }

  private combineQuestionAndAnswer(question: string, answer: string): string {
    // Combine question and answer for embedding generation
    if (answer && answer.trim()) {
      return `${question} ${answer}`;
    }
    return question;
  }

  private calculateConfidence(similarityScore: number): 'high' | 'medium' | 'low' {
    if (similarityScore >= 0.9) {
      return 'high';
    } else if (similarityScore >= 0.75) {
      return 'medium';
    } else {
      return 'low';
    }
  }



  private logVectorOperation(operation: string, kbId: number | null, success: boolean, message?: string): void {
    const logEntry = {
      timestamp: new Date().toISOString(),
      operation,
      kbId,
      success,
      message: message || (success ? 'Operation completed successfully' : 'Operation failed')
    };

    // Log to console for now - could be extended to write to database or file
    console.log('Vector operation log:', JSON.stringify(logEntry));
  }
}