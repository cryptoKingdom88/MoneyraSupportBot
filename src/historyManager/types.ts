import { MessageHistory, MessageSide } from '../dbManager/types';

export interface HistoryManager {
  addMessage(ticketId: number, side: MessageSide, username: string, chatId: number, message: string): Promise<number>;
  getTicketHistory(ticketId: number): Promise<MessageHistory[]>;
  getLastMessage(ticketId: number, side: MessageSide): Promise<MessageHistory | null>;
  updateMessageTime(messageId: number): Promise<void>;
}

export { MessageHistory, MessageSide };