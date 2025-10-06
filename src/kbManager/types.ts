import { KnowledgeBase } from '../dbManager/types';

export interface KBManager {
  addEntry(category: string, question: string, context: string, answer: string): Promise<number>;
  updateEntry(id: number, category: string, question: string, context: string, answer: string): Promise<boolean>;
  deleteEntry(id: number): Promise<boolean>;
  getAllEntries(): Promise<KnowledgeBase[]>;
  searchEntries(query: string): Promise<KnowledgeBase[]>;
}

export { KnowledgeBase };