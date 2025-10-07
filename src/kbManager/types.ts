import { KnowledgeBase } from '../dbManager/types';
import { AutoResponseResult } from './vectorIntegration';

export interface KBManager {
  addEntry(category: string, question: string, context: string, answer: string): Promise<number>;
  updateEntry(id: number, category: string, question: string, context: string, answer: string): Promise<boolean>;
  deleteEntry(id: number): Promise<boolean>;
  getAllEntries(): Promise<KnowledgeBase[]>;
  searchEntries(query: string): Promise<KnowledgeBase[]>;
  getEntryById(id: number): Promise<KnowledgeBase | null>;
  getEntriesByCategory(category: string): Promise<KnowledgeBase[]>;
  getCategories(): Promise<string[]>;
  getEntryCount(): Promise<number>;
  
  searchSimilarContent(query: string): Promise<AutoResponseResult | null>;
  
  // New methods with auto-context generation and duplicate detection
  addEntryWithAutoContext(category: string, question: string, answer: string): Promise<number>;
  updateEntryWithAutoContext(id: number, category: string, question: string, answer: string): Promise<boolean>;
  findSimilarEntry(question: string, excludeId?: number): Promise<{
    hasSimilar: boolean;
    similarEntry?: KnowledgeBase;
    similarityScore?: number;
  }>;
}

export { KnowledgeBase, AutoResponseResult };