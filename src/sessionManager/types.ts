import { Session, TicketStatus } from '../dbManager/types';

export interface SessionManager {
  createTicket(customerChatId: number, customerUsername: string): Promise<number>;
  getOpenTicket(customerChatId: number): Promise<Session | null>;
  assignManager(ticketId: number, managerChatId: number, managerUsername: string): Promise<boolean>;
  updateTicketStatus(ticketId: number, status: TicketStatus): Promise<void>;
  getTicketsByManager(managerChatId: number): Promise<Session[]>;
  closeExpiredTickets(): Promise<number>;
}

export { Session, TicketStatus };