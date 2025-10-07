import TelegramBot from 'node-telegram-bot-api';
import { config } from './config/config';
import { DatabaseManager } from './dbManager/database';
import { SessionManager } from './sessionManager/sessionManager';
import { HistoryManager } from './historyManager/historyManager';
import { KBManager } from './kbManager/kbManager';
import { TicketStatus, MessageSide, Session } from './dbManager/types';
import { VectorServiceClient } from './vectorService/vectorServiceClient';
import { VectorIntegrationImpl, AutoResponseResult } from './kbManager/vectorIntegration';

// User roles enum
enum UserRole {
  SUPER_ADMIN = 'super_admin',
  MANAGER = 'manager',
  CUSTOMER = 'customer'
}

class CustomerSupportBot {
  private bot: TelegramBot;
  private dbManager: DatabaseManager;
  private sessionManager!: SessionManager;
  private historyManager!: HistoryManager;
  private kbManager!: KBManager;
  private vectorClient!: VectorServiceClient;
  private vectorIntegration!: VectorIntegrationImpl;
  private managers: Set<number> = new Set(); // Cache of manager chat IDs
  private ticketClosureInterval?: NodeJS.Timeout;
  private managerReminderInterval?: NodeJS.Timeout;

  constructor() {
    const botConfig = config.getBotConfig();
    const dbConfig = config.getDatabaseConfig();
    
    // Initialize bot
    this.bot = new TelegramBot(botConfig.botToken, { polling: true });
    
    // Initialize database and managers
    this.dbManager = new DatabaseManager(dbConfig);
  }

  public async initialize(): Promise<void> {
    try {
      console.log('Initializing Customer Support Bot...');
      console.log(`Bot Token: ${config.getBotConfig().botToken ? 'Loaded' : 'Missing'}`);
      console.log(`Super Admin: ${config.getBotConfig().superAdminUsername || 'Not configured'}`);
      
      // Initialize database with retry mechanism
      let retryCount = 0;
      const maxRetries = 3;
      
      while (retryCount < maxRetries) {
        try {
          await this.dbManager.initialize();
          console.log('Database initialized successfully');
          break;
        } catch (dbError) {
          retryCount++;
          console.error(`Database initialization attempt ${retryCount} failed:`, dbError);
          
          if (retryCount >= maxRetries) {
            throw new Error(`Failed to initialize database after ${maxRetries} attempts: ${dbError}`);
          }
          
          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
        }
      }
      
      const db = this.dbManager.getConnection();
      
      // Initialize managers with proper dependency order
      console.log('Initializing manager modules...');
      this.sessionManager = new SessionManager(db);
      this.historyManager = new HistoryManager(db);
      
      // Initialize vector service integration first
      const vectorConfig = config.getVectorServiceConfig();
      this.vectorClient = new VectorServiceClient(vectorConfig);
      this.vectorIntegration = new VectorIntegrationImpl(this.vectorClient);
      
      // Initialize KBManager with vector integration
      this.kbManager = new KBManager(db, this.vectorClient);
      console.log(`Vector service integration initialized (enabled: ${vectorConfig.enabled})`);
      
      console.log('Manager modules initialized');
      
      // Load existing managers into cache
      await this.loadManagers();
      
      // Set up message handlers
      this.setupMessageHandlers();
      
      // Set up error handlers
      this.setupErrorHandlers();
      
      // Start scheduled tasks
      this.startScheduledTasks();
      
      console.log('✅ Customer Support Bot initialized successfully');
      console.log(`📊 System ready - Managers: ${this.managers.size}, Database: Connected`);
      
    } catch (error) {
      console.error('❌ Failed to initialize bot:', error);
      
      // Cleanup on initialization failure
      try {
        await this.shutdown();
      } catch (cleanupError) {
        console.error('Error during cleanup after initialization failure:', cleanupError);
      }
      
      throw error;
    }
  }

  private async loadManagers(): Promise<void> {
    try {
      const db = this.dbManager.getConnection();
      const stmt = db.prepare('SELECT chat_id, username FROM managers WHERE is_active = 1');
      const managers = stmt.all() as { chat_id: number; username: string }[];
      
      this.managers.clear();
      managers.forEach(manager => this.managers.add(manager.chat_id));
      
      console.log(`📋 Loaded ${managers.length} active managers: ${managers.map(m => `@${m.username}`).join(', ')}`);
    } catch (error) {
      console.error('❌ Error loading managers:', error);
      // Don't throw here - the bot can still function without pre-loaded managers
    }
  }  
private setupMessageHandlers(): void {
    // Handle all messages
    this.bot.on('message', async (msg) => {
      try {
        await this.handleMessage(msg);
      } catch (error) {
        console.error('Error handling message:', error);
        await this.sendErrorMessage(msg.chat.id, 'An error occurred while processing your message.');
      }
    });

    // Handle callback queries (inline keyboard responses)
    this.bot.on('callback_query', async (query) => {
      try {
        await this.handleCallback(query);
      } catch (error) {
        console.error('Error handling callback query:', error);
        if (query.message) {
          await this.sendErrorMessage(query.message.chat.id, 'An error occurred while processing your request.');
        }
      }
    });
  }

  private setupErrorHandlers(): void {
    this.bot.on('polling_error', (error) => {
      console.error('🔴 Telegram polling error:', error);
      
      // Implement exponential backoff for polling errors
      if ((error as any).code === 'EFATAL') {
        console.error('Fatal polling error - bot will attempt to restart polling');
        setTimeout(() => {
          try {
            this.bot.startPolling();
          } catch (restartError) {
            console.error('Failed to restart polling:', restartError);
          }
        }, 5000);
      }
    });

    this.bot.on('error', (error) => {
      console.error('🔴 Bot error:', error);
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      console.error('🔴 Uncaught Exception:', error);
      // Don't exit immediately - try graceful shutdown
      this.shutdown().finally(() => {
        process.exit(1);
      });
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('🔴 Unhandled Rejection at:', promise, 'reason:', reason);
      // Log but don't exit for unhandled rejections
    });

    // Handle process termination
    process.on('SIGINT', async () => {
      console.log('🛑 Received SIGINT, shutting down gracefully...');
      await this.shutdown();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('🛑 Received SIGTERM, shutting down gracefully...');
      await this.shutdown();
      process.exit(0);
    });

    console.log('🛡️ Error handlers configured');
  }

  private async handleMessage(msg: TelegramBot.Message): Promise<void> {
    if (!msg.text || !msg.from) {
      console.log('⚠️ Received message without text or sender info, ignoring');
      return;
    }

    const chatId = msg.chat.id;
    const username = msg.from.username || '';
    const text = msg.text;

    console.log(`📨 Message from @${username} (${chatId}): ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`);

    try {
      // Handle utility commands available to all users
      if (text === '/view_chat_id') {
        await this.handleViewChatIdCommand(msg);
        return;
      }

      // Input validation
      if (text.length > 4000) {
        await this.sendErrorMessage(chatId, 'Message too long. Please keep messages under 4000 characters.');
        return;
      }

      // Determine user role
      const userRole = await this.getUserRole(chatId, username);
      console.log(`👤 User role determined: ${userRole} for @${username}`);
      
      // Route message based on user role
      switch (userRole) {
        case UserRole.SUPER_ADMIN:
          await this.handleSuperAdminMessage(msg);
          break;
        case UserRole.MANAGER:
          await this.handleManagerMessage(msg);
          break;
        case UserRole.CUSTOMER:
          await this.handleCustomerMessage(msg);
          break;
        default:
          console.error(`🔴 Unknown user role: ${userRole}`);
          await this.sendErrorMessage(chatId, 'Unable to determine your access level. Please contact support.');
      }
    } catch (error) {
      console.error(`🔴 Error handling message from @${username} (${chatId}):`, error);
      await this.sendErrorMessage(chatId, 'An error occurred while processing your message. Please try again.');
    }
  }

  private async handleViewChatIdCommand(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const username = msg.from?.username || '';
    
    try {
      console.log(`🆔 User @${username} requested chat ID`);
      
      const response = `Your Chat ID: ${chatId}`;
      await this.sendMessageWithRetry(chatId, response);
      
      console.log(`✅ Sent chat ID ${chatId} to @${username}`);
    } catch (error) {
      console.error(`🔴 Error handling view_chat_id command for @${username}:`, error);
      await this.sendErrorMessage(chatId, 'Error retrieving chat ID. Please try again.');
    }
  }

  private async extractTicketIdFromReply(replyMessage: TelegramBot.Message): Promise<number | null> {
    try {
      console.log(`🔍 Extracting ticket ID from reply message...`);
      
      if (!replyMessage.text) {
        console.log(`❌ Reply message has no text content`);
        return null;
      }

      console.log(`📝 Reply message text: "${replyMessage.text}"`);

      // Look for ticket number patterns in the replied message
      // Pattern 1: "New Ticket #123456" or "Ticket #123456" (flexible digit count)
      const ticketPattern1 = replyMessage.text.match(/Ticket #(\d+)/);
      if (ticketPattern1) {
        const ticketId = parseInt(ticketPattern1[1]);
        console.log(`✅ Pattern 1 matched: Ticket #${ticketId}`);
        // Verify this ticket exists in the database
        const ticket = await this.sessionManager.getTicketById(ticketId);
        if (ticket) {
          console.log(`✅ Verified ticket #${ticketId} exists in database`);
          return ticketId;
        } else {
          console.log(`❌ Ticket #${ticketId} not found in database`);
        }
      }

      // Pattern 2: "#123456" at the beginning of a line (flexible digit count)
      const ticketPattern2 = replyMessage.text.match(/^#(\d+)/m);
      if (ticketPattern2) {
        const ticketId = parseInt(ticketPattern2[1]);
        console.log(`✅ Pattern 2 matched: #${ticketId} at line start`);
        // Verify this ticket exists in the database
        const ticket = await this.sessionManager.getTicketById(ticketId);
        if (ticket) {
          console.log(`✅ Verified ticket #${ticketId} exists in database`);
          return ticketId;
        } else {
          console.log(`❌ Ticket #${ticketId} not found in database`);
        }
      }

      // Pattern 3: Look for any number that could be a ticket ID (as fallback)
      const ticketPattern3 = replyMessage.text.match(/(\d+)/);
      if (ticketPattern3) {
        const potentialTicketId = parseInt(ticketPattern3[1]);
        console.log(`🔍 Pattern 3 found potential ticket ID: ${potentialTicketId}, verifying in database...`);
        
        // Verify this ticket exists in the database
        const ticket = await this.sessionManager.getTicketById(potentialTicketId);
        if (ticket) {
          console.log(`✅ Verified ticket #${potentialTicketId} exists in database`);
          return potentialTicketId;
        } else {
          console.log(`❌ Ticket #${potentialTicketId} not found in database`);
        }
      }

      console.log(`❌ No valid ticket ID patterns found in reply message`);
      return null;
    } catch (error) {
      console.error('🔴 Error extracting ticket ID from reply:', error);
      return null;
    }
  }

  private async getUserRole(chatId: number, username: string): Promise<UserRole> {
    const botConfig = config.getBotConfig();
    
    // Check if super admin
    if (username === botConfig.superAdminUsername) {
      return UserRole.SUPER_ADMIN;
    }
    
    // Check if manager
    if (this.managers.has(chatId)) {
      return UserRole.MANAGER;
    }
    
    // Default to customer
    return UserRole.CUSTOMER;
  }  
  private async handleSuperAdminMessage(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const text = msg.text!;

    if (text === '/start') {
      await this.showSuperAdminMenu(chatId);
      return;
    }

    // Handle ADD_MANAGER command
    if (text.startsWith('ADD_MANAGER ')) {
      await this.processAddManager(chatId, text);
      return;
    }

    // Handle ADD_KB command
    if (text.startsWith('ADD_KB\n')) {
      await this.processAddKB(chatId, text);
      return;
    }

    // Handle EDIT_KB command
    if (text.startsWith('EDIT_KB ')) {
      await this.processEditKB(chatId, text);
      return;
    }

    // Handle CHECK_SIMILAR command
    if (text.startsWith('CHECK_SIMILAR ')) {
      await this.processCheckSimilar(chatId, text);
      return;
    }

    await this.bot.sendMessage(chatId, 'Please use the menu options or /start to see available commands.');
  }

  private async processAddManager(chatId: number, text: string): Promise<void> {
    try {
      console.log(`👨‍💼 Super admin adding manager: ${text}`);
      
      // Parse: ADD_MANAGER @username chat_id
      const parts = text.trim().split(/\s+/);
      if (parts.length !== 3) {
        await this.sendMessageWithRetry(chatId, '❌ Invalid format. Use: ADD_MANAGER @username chat_id');
        return;
      }

      const username = parts[1].replace('@', '').trim();
      const managerChatIdStr = parts[2].trim();

      // Input validation
      if (!username || username.length < 3) {
        await this.sendMessageWithRetry(chatId, '❌ Username must be at least 3 characters long.');
        return;
      }

      if (username.length > 32) {
        await this.sendMessageWithRetry(chatId, '❌ Username too long (max 32 characters).');
        return;
      }

      const managerChatId = parseInt(managerChatIdStr);
      if (isNaN(managerChatId) || managerChatId <= 0) {
        await this.sendMessageWithRetry(chatId, '❌ Invalid chat ID. Please provide a valid positive number.');
        return;
      }

      // Check if manager already exists
      const db = this.dbManager.getConnection();
      const existingManager = db.prepare('SELECT * FROM managers WHERE chat_id = ? OR username = ?').get(managerChatId, username) as any;
      
      if (existingManager) {
        if (existingManager.is_active) {
          await this.sendMessageWithRetry(chatId, `⚠️ Manager @${username} (${managerChatId}) already exists and is active.`);
          return;
        } else {
          // Reactivate existing manager
          db.prepare('UPDATE managers SET is_active = 1, username = ?, update_time = CURRENT_TIMESTAMP WHERE chat_id = ?').run(username, managerChatId);
          this.managers.add(managerChatId);
          await this.sendMessageWithRetry(chatId, `✅ Manager @${username} reactivated successfully!`);
          console.log(`✅ Reactivated manager @${username} (${managerChatId})`);
          await this.showManagersMenu(chatId);
          return;
        }
      }

      // Add new manager to database
      try {
        const stmt = db.prepare('INSERT INTO managers (chat_id, username, is_active) VALUES (?, ?, 1)');
        stmt.run(managerChatId, username);
        
        // Add to cache
        this.managers.add(managerChatId);

        await this.sendMessageWithRetry(chatId, `✅ Manager @${username} added successfully!`);
        console.log(`✅ Added new manager @${username} (${managerChatId})`);
        await this.showManagersMenu(chatId);
        
      } catch (dbError: any) {
        console.error(`🔴 Database error adding manager @${username}:`, dbError);
        
        if (dbError.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          await this.sendErrorMessage(chatId, 'Manager with this chat ID or username already exists.');
        } else {
          await this.sendErrorMessage(chatId, 'Database error adding manager. Please try again.');
        }
      }

    } catch (error) {
      console.error('🔴 Error in processAddManager:', error);
      await this.sendErrorMessage(chatId, 'Error adding manager. Please try again.');
    }
  }

  private async processAddKB(chatId: number, text: string): Promise<void> {
    try {
      // Parse KB entry format (Context is now auto-generated)
      const lines = text.split('\n');
      let category = '', question = '', answer = '';

      for (const line of lines) {
        if (line.startsWith('Category: ')) {
          category = line.replace('Category: ', '').trim();
        } else if (line.startsWith('Question: ')) {
          question = line.replace('Question: ', '').trim();
        } else if (line.startsWith('Answer: ')) {
          answer = line.replace('Answer: ', '').trim();
        }
        // Context is no longer parsed from user input - it will be auto-generated
      }

      if (!category || !question || !answer) {
        await this.bot.sendMessage(chatId, '❌ Missing required fields. Please provide Category, Question, and Answer.\n\n📝 Format:\nCategory: category name\nQuestion: question content\nAnswer: answer content');
        return;
      }

      // Use the new auto-context method with duplicate detection
      const entryId = await this.kbManager.addEntryWithAutoContext(category, question, answer);
      await this.bot.sendMessage(chatId, `✅ KB entry #${entryId} added successfully!\n🤖 Context was automatically generated.`);
      await this.showKBMenu(chatId);

    } catch (error) {
      console.error('Error adding KB entry:', error);
      
      // Check if it's a duplicate entry error
      if (error instanceof Error && error.message.includes('Similar KB entry already exists')) {
        await this.bot.sendMessage(chatId, `❌ ${error.message}\n\nPlease modify your question to make it more specific or check existing entries.`);
      } else {
        await this.sendErrorMessage(chatId, 'Error adding KB entry. Please try again.');
      }
    }
  }

  private async processCheckSimilar(chatId: number, text: string): Promise<void> {
    try {
      const question = text.replace('CHECK_SIMILAR ', '').trim();
      
      if (!question) {
        await this.bot.sendMessage(chatId, '❌ Please provide a question to check.\n\nUsage: CHECK_SIMILAR [your question]');
        return;
      }

      await this.bot.sendMessage(chatId, '🔍 Checking for similar entries...');

      const similarCheck = await this.kbManager.findSimilarEntry(question);
      
      if (similarCheck.hasSimilar && similarCheck.similarEntry) {
        const entry = similarCheck.similarEntry;
        const score = similarCheck.similarityScore || 0;
        
        await this.bot.sendMessage(chatId, 
          `⚠️ **Similar KB Entry Found**\n\n` +
          `**Similarity Score:** ${(score * 100).toFixed(1)}%\n\n` +
          `**Existing Entry #${entry.id}:**\n` +
          `Category: ${entry.category}\n` +
          `Question: ${entry.question}\n` +
          `Answer: ${entry.answer}\n\n` +
          `💡 Consider modifying your question to be more specific or updating the existing entry instead.`,
          { parse_mode: 'Markdown' }
        );
      } else {
        await this.bot.sendMessage(chatId, 
          `✅ **No Similar Entries Found**\n\n` +
          `Your question: "${question}"\n\n` +
          `You can proceed to add this as a new KB entry.`,
          { parse_mode: 'Markdown' }
        );
      }

    } catch (error) {
      console.error('Error checking similar entries:', error);
      await this.sendErrorMessage(chatId, 'Error checking for similar entries. Please try again.');
    }
  }

  private async processEditKB(chatId: number, text: string): Promise<void> {
    try {
      // Parse: EDIT_KB id\nCategory: ...\nQuestion: ...\nAnswer: ... (Context is auto-generated)
      const lines = text.split('\n');
      const firstLine = lines[0].split(' ');
      
      if (firstLine.length !== 2) {
        await this.bot.sendMessage(chatId, '❌ Invalid format. Usage: EDIT_KB id');
        return;
      }

      const kbId = parseInt(firstLine[1]);
      if (isNaN(kbId)) {
        await this.bot.sendMessage(chatId, '❌ Invalid KB ID.');
        return;
      }

      let category = '', question = '', answer = '';

      for (const line of lines.slice(1)) {
        if (line.startsWith('Category: ')) {
          category = line.replace('Category: ', '').trim();
        } else if (line.startsWith('Question: ')) {
          question = line.replace('Question: ', '').trim();
        } else if (line.startsWith('Answer: ')) {
          answer = line.replace('Answer: ', '').trim();
        }
        // Context is no longer parsed from user input - it will be auto-generated
      }

      if (!category || !question || !answer) {
        await this.bot.sendMessage(chatId, '❌ Missing required fields. Please provide Category, Question, and Answer.\n\n📝 Format:\nCategory: category name\nQuestion: question content\nAnswer: answer content');
        return;
      }

      // Use the new auto-context method with duplicate detection
      const updated = await this.kbManager.updateEntryWithAutoContext(kbId, category, question, answer);
      
      if (updated) {
        await this.bot.sendMessage(chatId, `✅ KB entry #${kbId} updated successfully!\n🤖 Context was automatically updated.`);
        await this.showKBMenu(chatId);
      } else {
        await this.bot.sendMessage(chatId, '❌ KB entry not found.');
      }

    } catch (error) {
      console.error('Error editing KB entry:', error);
      
      // Check if it's a duplicate entry error
      if (error instanceof Error && error.message.includes('Similar KB entry already exists')) {
        await this.bot.sendMessage(chatId, `❌ ${error.message}\n\nPlease modify your question to make it more specific or check existing entries.`);
      } else {
        await this.sendErrorMessage(chatId, 'Error editing KB entry. Please try again.');
      }
    }
  }

  private async handleManagerMessage(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const text = msg.text!;
    const username = msg.from!.username || '';

    console.log(`👨‍💼 Manager message from @${username}: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
    console.log(`📋 Has reply_to_message: ${msg.reply_to_message ? 'Yes' : 'No'}`);

    if (text === '/start') {
      await this.bot.sendMessage(chatId, 
        'Welcome to Customer Support! You will receive notifications when customers need help.\n\n' +
        '🎯 **How to respond to tickets:**\n' +
        '• **Reply Method (Recommended):** Right-click on a ticket notification and select "Reply", then type your response\n' +
        '• **Manual Method:** Type #XXXXXX followed by your response message\n\n' +
        'Example: #123456 Thank you for contacting us. How can I help you?'
      );
      return;
    }

    // Check if this is a reply to a ticket notification
    if (msg.reply_to_message) {
      console.log(`🔍 Manager @${username} sent a reply message. Checking for ticket ID...`);
      console.log(`📋 Reply to message ID: ${msg.reply_to_message.message_id}`);
      console.log(`📋 Reply to message text: "${msg.reply_to_message.text?.substring(0, 200) || 'No text'}"`);
      
      const ticketId = await this.extractTicketIdFromReply(msg.reply_to_message);
      if (ticketId) {
        console.log(`✅ Found ticket ID #${ticketId} from reply. Processing response...`);
        await this.handleManagerResponse(chatId, username, ticketId, text);
        return;
      } else {
        console.log(`❌ Could not extract ticket ID from reply message`);
        // Fall through to show help message
      }
    }

    // Check if this is a ticket response (format: #XXXXXX message)
    const ticketMatch = text.match(/^#(\d+)\s+([\s\S]+)$/);
    if (ticketMatch) {
      const ticketId = parseInt(ticketMatch[1]);
      const response = ticketMatch[2];
      
      console.log(`📨 Manager @${username} responding to ticket #${ticketId} via manual format`);
      await this.handleManagerResponse(chatId, username, ticketId, response);
    } else {
      console.log(`❌ No valid ticket format found. Showing help message.`);
      await this.bot.sendMessage(chatId, 
        '🎯 **How to respond to tickets:**\n\n' +
        '**Method 1 (Recommended):** Reply to ticket notifications\n' +
        '• Right-click on any ticket notification\n' +
        '• Select "Reply"\n' +
        '• Type your response message\n\n' +
        '**Method 2:** Manual format\n' +
        '• Type: #XXXXXX Your response message\n' +
        '• Example: #123456 Thank you for contacting us. How can I help you?\n\n' +
        '🔍 **Debug Info:**\n' +
        `• Your message: "${text}"\n` +
        `• Has reply: ${msg.reply_to_message ? 'Yes' : 'No'}\n` +
        `• Reply text: "${msg.reply_to_message?.text?.substring(0, 50) || 'N/A'}"`
      );
    }
  }

  private async handleCustomerMessage(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const text = msg.text!;
    const username = msg.from!.username || `user_${chatId}`;

    if (text === '/start') {
      await this.bot.sendMessage(chatId, 
        'Welcome to Customer Support! Send us a message and our team will help you shortly.'
      );
      return;
    }

    // Process customer message and create/update ticket
    await this.processCustomerMessage(chatId, username, text);
  }

  private async processCustomerMessage(chatId: number, username: string, message: string): Promise<void> {
    const startTime = Date.now();
    
    try {
      console.log(`🎫 Processing customer message from @${username} (${chatId})`);
      
      // Input validation
      if (!message.trim()) {
        await this.sendErrorMessage(chatId, 'Please send a non-empty message.');
        return;
      }

      // Check for existing open ticket with retry mechanism
      let ticket: any = null;
      let retryCount = 0;
      const maxRetries = 3;

      while (retryCount < maxRetries) {
        try {
          ticket = await this.sessionManager.getOpenTicket(chatId);
          break;
        } catch (dbError) {
          retryCount++;
          console.error(`🔴 Database error getting ticket (attempt ${retryCount}):`, dbError);
          
          if (retryCount >= maxRetries) {
            throw new Error(`Failed to retrieve ticket after ${maxRetries} attempts: ${dbError}`);
          }
          
          await new Promise(resolve => setTimeout(resolve, 100 * retryCount));
        }
      }

      let ticketId: number;
      let isNewTicket = false;

      if (!ticket) {
        // Create new ticket with error handling
        try {
          ticketId = await this.sessionManager.createTicket(chatId, username);
          isNewTicket = true;
          console.log(`✅ Created new ticket #${ticketId} for @${username}`);
        } catch (createError) {
          console.error(`🔴 Failed to create ticket for @${username}:`, createError);
          throw new Error(`Failed to create support ticket: ${createError}`);
        }
      } else {
        ticketId = ticket.id;
        console.log(`📝 Using existing ticket #${ticketId} for @${username}`);
      }

      // Add message to history with validation
      let messageId: number;
      try {
        messageId = await this.historyManager.addMessage(
          ticketId, 
          MessageSide.FROM, 
          username, 
          chatId, 
          message.trim()
        );
        console.log(`💾 Message saved with ID ${messageId} for ticket #${ticketId}`);
      } catch (historyError) {
        console.error(`🔴 Failed to save message history for ticket #${ticketId}:`, historyError);
        throw new Error(`Failed to save message: ${historyError}`);
      }

      // Update ticket status and last message ID with transaction-like behavior
      try {
        await this.sessionManager.updateTicketStatus(ticketId, TicketStatus.WAITING_REPLY);
        await this.sessionManager.updateLastMessageId(ticketId, messageId);
        console.log(`🔄 Updated ticket #${ticketId} status to WAITING_REPLY`);
      } catch (updateError) {
        console.error(`🔴 Failed to update ticket #${ticketId} status:`, updateError);
        // Don't throw here - the message was saved, just status update failed
      }

      // Check for automated response before notifying managers (only if no manager assigned)
      const automatedResponse = await this.checkForAutomatedResponse(message, ticketId);
      
      if (automatedResponse) {
        // Send automated response to customer
        await this.sendAutomatedResponse(chatId, ticketId, automatedResponse);
        console.log(`🤖 Automated response sent for ticket #${ticketId}`);
      } else {
        // Send confirmation to customer with retry
        try {
          await this.sendMessageWithRetry(chatId, 
            `Thank you for your message! Your ticket #${ticketId.toString().padStart(6, '0')} has been ${isNewTicket ? 'created' : 'updated'}. Our team will respond shortly.`
          );
        } catch (confirmError) {
          console.error(`🔴 Failed to send confirmation to customer ${chatId}:`, confirmError);
          // Don't throw - the ticket was created successfully
        }

        // Notify managers only if no automated response was sent
        try {
          await this.notifyManagers(ticketId, username, message, isNewTicket);
        } catch (notifyError) {
          console.error(`🔴 Failed to notify managers for ticket #${ticketId}:`, notifyError);
          // Don't throw - the ticket was created successfully
        }
      }

      const processingTime = Date.now() - startTime;
      console.log(`✅ Customer message processed successfully in ${processingTime}ms`);

    } catch (error) {
      const processingTime = Date.now() - startTime;
      console.error(`🔴 Error processing customer message from @${username} after ${processingTime}ms:`, error);
      
      // Send appropriate error message based on error type
      let errorMessage = 'Sorry, there was an error processing your message. Please try again.';
      
      if (error instanceof Error) {
        if (error.message.includes('database')) {
          errorMessage = 'We are experiencing technical difficulties. Please try again in a few moments.';
        } else if (error.message.includes('network') || error.message.includes('timeout')) {
          errorMessage = 'Connection issue detected. Please try sending your message again.';
        }
      }
      
      await this.sendErrorMessage(chatId, errorMessage);
    }
  }

  private async checkForAutomatedResponse(message: string, ticketId?: number): Promise<AutoResponseResult | null> {
    try {
      console.log(`🔍 Checking for automated response for message: "${message.substring(0, 100)}${message.length > 100 ? '...' : ''}"`);
      
      // Check if vector service is enabled
      if (!this.vectorIntegration.isVectorServiceEnabled()) {
        console.log(`🔶 Vector service disabled, skipping automated response check`);
        return null;
      }
      
      // If ticketId is provided, check if ticket already has a manager assigned
      if (ticketId) {
        try {
          const ticket = await this.sessionManager.getTicketById(ticketId);
          if (ticket && ticket.operator_chat_id) {
            console.log(`👨‍💼 Ticket #${ticketId} already has manager assigned (@${ticket.operator_username}), skipping automated response`);
            return null;
          }
        } catch (error) {
          console.warn(`⚠️ Could not check ticket assignment status for #${ticketId}:`, error);
          // Continue with automated response check
        }
      }
      
      // Use vector integration to search for similar content
      const result = await this.vectorIntegration.searchSimilarContent(message);
      
      if (result) {
        // Additional threshold validation (the vector integration already checks this, but double-check for safety)
        const vectorConfig = config.getVectorServiceConfig();
        if (result.similarityScore < vectorConfig.similarityThreshold) {
          console.log(`📊 Similarity score ${result.similarityScore} below configured threshold ${vectorConfig.similarityThreshold}`);
          await this.logAutomatedResponseAttempt(message, false, `Similarity score ${result.similarityScore} below threshold ${vectorConfig.similarityThreshold}`);
          return null;
        }
        
        console.log(`✅ Found automated response: KB ID ${result.kbId}, confidence: ${result.confidence}, similarity: ${result.similarityScore.toFixed(3)}`);
        await this.logAutomatedResponseAttempt(message, true, `Match found: KB ${result.kbId}, score ${result.similarityScore.toFixed(3)}, confidence ${result.confidence}`);
        return result;
      } else {
        console.log(`❌ No suitable automated response found (no high-similarity matches)`);
        await this.logAutomatedResponseAttempt(message, false, 'No high-similarity matches found');
        return null;
      }
    } catch (error) {
      console.error(`🔴 Error checking for automated response:`, error);
      // Return null for graceful degradation - system will fall back to manager notification
      return null;
    }
  }

  private async sendAutomatedResponse(chatId: number, ticketId: number, autoResponse: AutoResponseResult): Promise<void> {
    try {
      const ticketNumber = ticketId.toString().padStart(6, '0');
      const confidenceEmoji = autoResponse.confidence === 'high' ? '🎯' : 
                             autoResponse.confidence === 'medium' ? '🎲' : '💡';
      
      // Prepare the automated response message with confidence details
      const confidenceText = this.getConfidenceText(autoResponse.confidence, autoResponse.similarityScore);
      const responseMessage = `🤖 Automated Response for Ticket #${ticketNumber}:\n\n${autoResponse.answer}\n\n${confidenceEmoji} ${confidenceText}\n\nIf this doesn't fully answer your question, our team will follow up with you shortly.`;
      
      // Send the automated response to the customer
      await this.sendMessageWithRetry(chatId, responseMessage);
      
      // Update ticket status to REPLIED and keep assigned manager as NULL (as per requirement 2.3)
      await this.sessionManager.updateTicketStatus(ticketId, TicketStatus.REPLIED);
      
      // Add the automated response to message history with metadata
      const responseMessageId = await this.historyManager.addMessage(
        ticketId,
        MessageSide.TO,
        'AutoBot',
        0, // Use 0 as chat_id for automated responses
        `[AUTOMATED] ${autoResponse.answer} [KB:${autoResponse.kbId}, Score:${autoResponse.similarityScore.toFixed(3)}, Confidence:${autoResponse.confidence}]`
      );
      
      // Update last reply ID to track the automated response
      await this.sessionManager.updateLastReplyId(ticketId, responseMessageId);
      
      // Log the automated response for tracking
      this.logAutomatedResponse(ticketId, autoResponse, true);
      
      console.log(`✅ Automated response sent successfully for ticket #${ticketId} (KB:${autoResponse.kbId}, Score:${autoResponse.similarityScore.toFixed(3)})`);
    } catch (error) {
      console.error(`🔴 Error sending automated response for ticket #${ticketId}:`, error);
      
      // Log the failed attempt
      this.logAutomatedResponse(ticketId, autoResponse, false, error instanceof Error ? error.message : 'Unknown error');
      
      // Don't throw - let the system fall back to normal manager notification
      throw error;
    }
  }

  private getConfidenceText(confidence: 'high' | 'medium' | 'low', similarityScore: number): string {
    const scorePercent = Math.round(similarityScore * 100);
    
    switch (confidence) {
      case 'high':
        return `High confidence match (${scorePercent}% similarity)`;
      case 'medium':
        return `Medium confidence match (${scorePercent}% similarity)`;
      case 'low':
        return `Low confidence match (${scorePercent}% similarity)`;
      default:
        return `Match found (${scorePercent}% similarity)`;
    }
  }

  private logAutomatedResponse(ticketId: number, autoResponse: AutoResponseResult, success: boolean, errorMessage?: string): void {
    const logEntry = {
      timestamp: new Date().toISOString(),
      ticketId,
      kbId: autoResponse.kbId,
      similarityScore: autoResponse.similarityScore,
      confidence: autoResponse.confidence,
      success,
      errorMessage: errorMessage || (success ? 'Response sent successfully' : 'Failed to send response'),
      responseType: 'automated'
    };
    
    // Log to console with structured format
    console.log('🤖 Automated Response Log:', JSON.stringify(logEntry));
    
    // Store in database for audit trail and metrics
    this.storeAutomatedResponseLog(logEntry);
  }

  private async storeAutomatedResponseLog(logEntry: any): Promise<void> {
    try {
      const db = this.dbManager.getConnection();
      
      // Create automated_responses table if it doesn't exist
      db.exec(`
        CREATE TABLE IF NOT EXISTS automated_responses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ticket_id INTEGER NOT NULL,
          kb_id INTEGER,
          similarity_score REAL,
          confidence TEXT,
          success BOOLEAN NOT NULL,
          error_message TEXT,
          response_time_ms INTEGER,
          create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (ticket_id) REFERENCES sessions(id),
          FOREIGN KEY (kb_id) REFERENCES knowledge_base(id)
        )
      `);
      
      // Insert the log entry
      const stmt = db.prepare(`
        INSERT INTO automated_responses 
        (ticket_id, kb_id, similarity_score, confidence, success, error_message, create_time)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      
      stmt.run(
        logEntry.ticketId,
        logEntry.kbId,
        logEntry.similarityScore,
        logEntry.confidence,
        logEntry.success ? 1 : 0,
        logEntry.errorMessage,
        logEntry.timestamp
      );
      
      console.log(`📊 Automated response log stored in database for ticket #${logEntry.ticketId}`);
    } catch (error) {
      console.error('🔴 Error storing automated response log:', error);
      // Don't throw - logging failure shouldn't break the main flow
    }
  }

  private async logAutomatedResponseAttempt(message: string, found: boolean, reason?: string): Promise<void> {
    const logEntry = {
      timestamp: new Date().toISOString(),
      messagePreview: message.substring(0, 100),
      attemptResult: found ? 'match_found' : 'no_match',
      reason: reason || (found ? 'Suitable match found' : 'No suitable match found'),
      responseType: 'attempt'
    };
    
    console.log('🔍 Automated Response Attempt Log:', JSON.stringify(logEntry));
    
    // Store attempt metrics for analysis
    try {
      const db = this.dbManager.getConnection();
      
      // Create automated_response_attempts table if it doesn't exist
      db.exec(`
        CREATE TABLE IF NOT EXISTS automated_response_attempts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_preview TEXT,
          attempt_result TEXT NOT NULL,
          reason TEXT,
          create_time DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      const stmt = db.prepare(`
        INSERT INTO automated_response_attempts 
        (message_preview, attempt_result, reason, create_time)
        VALUES (?, ?, ?, ?)
      `);
      
      stmt.run(
        logEntry.messagePreview,
        logEntry.attemptResult,
        logEntry.reason,
        logEntry.timestamp
      );
    } catch (error) {
      console.error('🔴 Error storing automated response attempt log:', error);
    }
  }

  private async getAutomatedResponseMetrics(): Promise<any> {
    try {
      const db = this.dbManager.getConnection();
      
      // Get success rate
      const successRate = db.prepare(`
        SELECT 
          COUNT(*) as total_attempts,
          SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful_responses,
          ROUND(
            (SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*)), 2
          ) as success_rate_percent
        FROM automated_responses
        WHERE create_time >= datetime('now', '-30 days')
      `).get() as any;
      
      // Get confidence distribution
      const confidenceDistribution = db.prepare(`
        SELECT 
          confidence,
          COUNT(*) as count,
          ROUND((COUNT(*) * 100.0 / (SELECT COUNT(*) FROM automated_responses WHERE create_time >= datetime('now', '-30 days'))), 2) as percentage
        FROM automated_responses 
        WHERE create_time >= datetime('now', '-30 days') AND success = 1
        GROUP BY confidence
        ORDER BY count DESC
      `).all() as any[];
      
      // Get average similarity scores by confidence
      const avgSimilarityByConfidence = db.prepare(`
        SELECT 
          confidence,
          ROUND(AVG(similarity_score), 3) as avg_similarity_score,
          COUNT(*) as count
        FROM automated_responses 
        WHERE create_time >= datetime('now', '-30 days') AND success = 1
        GROUP BY confidence
      `).all() as any[];
      
      // Get attempt vs success ratio
      const attemptMetrics = db.prepare(`
        SELECT 
          (SELECT COUNT(*) FROM automated_response_attempts WHERE create_time >= datetime('now', '-30 days')) as total_attempts,
          (SELECT COUNT(*) FROM automated_responses WHERE create_time >= datetime('now', '-30 days') AND success = 1) as successful_responses
      `).get() as any;
      
      return {
        period: 'Last 30 days',
        successRate,
        confidenceDistribution,
        avgSimilarityByConfidence,
        attemptMetrics,
        generatedAt: new Date().toISOString()
      };
    } catch (error) {
      console.error('🔴 Error generating automated response metrics:', error);
      return null;
    }
  }

  private async notifyManagers(ticketId: number, username: string, message: string, isNewTicket: boolean): Promise<void> {
    const ticketNumber = ticketId.toString().padStart(6, '0');
    const truncatedMessage = message.length > 200 ? message.substring(0, 200) + '...' : message;
    
    const notification = isNewTicket 
      ? `🎫 New Ticket #${ticketNumber} was opened. Please handle it.\n👤 UserName: @${username}\n💬 Message: ${truncatedMessage}`
      : `🔄 Ticket #${ticketNumber} was updated. Please handle it.\n👤 UserName: @${username}\n💬 Message: ${truncatedMessage}`;

    console.log(`📢 Notifying managers about ticket #${ticketId} (${isNewTicket ? 'new' : 'update'})`);

    if (isNewTicket) {
      // Notify all managers for new tickets
      const managerIds = Array.from(this.managers);
      console.log(`📤 Sending notifications to ${managerIds.length} managers`);
      
      let successCount = 0;
      let failureCount = 0;
      
      const notificationPromises = managerIds.map(async (managerChatId) => {
        try {
          await this.sendMessageWithRetry(managerChatId, notification);
          successCount++;
          console.log(`✅ Notified manager ${managerChatId} about ticket #${ticketId}`);
        } catch (error: any) {
          failureCount++;
          console.error(`🔴 Failed to notify manager ${managerChatId} about ticket #${ticketId}:`, error);
          
          // Handle specific errors
          if (error.message.includes('blocked')) {
            console.log(`🚫 Removing blocked manager ${managerChatId} from active list`);
            this.managers.delete(managerChatId);
            
            // Update database to mark manager as inactive
            try {
              const db = this.dbManager.getConnection();
              db.prepare('UPDATE managers SET is_active = 0 WHERE chat_id = ?').run(managerChatId);
            } catch (dbError) {
              console.error(`🔴 Failed to update manager ${managerChatId} status in database:`, dbError);
            }
          }
        }
      });
      
      await Promise.allSettled(notificationPromises);
      console.log(`📊 Manager notifications completed: ${successCount} success, ${failureCount} failed`);
      
    } else {
      // Notify only assigned manager for existing tickets
      try {
        const ticket = await this.sessionManager.getTicketById(ticketId);
        if (ticket && ticket.operator_chat_id) {
          console.log(`📤 Sending update notification to assigned manager @${ticket.operator_username}`);
          
          try {
            await this.sendMessageWithRetry(ticket.operator_chat_id, notification);
            console.log(`✅ Notified assigned manager ${ticket.operator_chat_id} about ticket #${ticketId} update`);
          } catch (error: any) {
            console.error(`🔴 Failed to notify assigned manager ${ticket.operator_chat_id}:`, error);
            
            if (error.message.includes('blocked')) {
              console.log(`🚫 Assigned manager ${ticket.operator_chat_id} has blocked the bot`);
              // Could implement reassignment logic here
            }
          }
        } else {
          console.log(`⚠️ No assigned manager found for ticket #${ticketId}, notifying all managers`);
          // Fallback: notify all managers if no assigned manager
          await this.notifyManagers(ticketId, username, message, true);
        }
      } catch (error) {
        console.error(`🔴 Error retrieving ticket info for notifications:`, error);
        // Fallback: notify all managers
        console.log(`🔄 Falling back to notifying all managers for ticket #${ticketId}`);
        await this.notifyManagers(ticketId, username, message, true);
      }
    }
  }

  private async handleManagerResponse(chatId: number, username: string, ticketId: number, response: string): Promise<void> {
    const startTime = Date.now();
    
    try {
      console.log(`👨‍💼 Manager @${username} responding to ticket #${ticketId}`);
      
      // Input validation
      if (!response.trim()) {
        await this.sendErrorMessage(chatId, 'Please provide a non-empty response.');
        return;
      }

      if (response.length > 4000) {
        await this.sendErrorMessage(chatId, 'Response too long. Please keep responses under 4000 characters.');
        return;
      }

      // Get ticket information with error handling
      let ticket: any;
      try {
        ticket = await this.sessionManager.getTicketById(ticketId);
      } catch (dbError) {
        console.error(`🔴 Database error retrieving ticket #${ticketId}:`, dbError);
        await this.sendErrorMessage(chatId, 'Database error. Please try again.');
        return;
      }

      if (!ticket) {
        console.log(`⚠️ Ticket #${ticketId} not found for manager @${username}`);
        await this.sendMessageWithRetry(chatId, `❌ Ticket #${ticketId.toString().padStart(6, '0')} not found.`);
        return;
      }

      // Check if ticket is closed
      if (ticket.status === TicketStatus.CLOSED) {
        console.log(`⚠️ Manager @${username} tried to respond to closed ticket #${ticketId}`);
        await this.sendMessageWithRetry(chatId, 
          `❌ Ticket #${ticketId.toString().padStart(6, '0')} is already closed.`
        );
        return;
      }

      // Check if ticket is already assigned to another manager
      if (ticket.operator_chat_id && ticket.operator_chat_id !== chatId) {
        console.log(`⚠️ Ticket #${ticketId} already assigned to another manager (${ticket.operator_username})`);
        await this.sendMessageWithRetry(chatId, 
          `❌ Ticket #${ticketId.toString().padStart(6, '0')} is already being handled by @${ticket.operator_username}.`
        );
        return;
      }

      // Assign manager if not already assigned
      if (!ticket.operator_chat_id) {
        try {
          const assigned = await this.sessionManager.assignManager(ticketId, chatId, username);
          if (!assigned) {
            console.log(`⚠️ Failed to assign ticket #${ticketId} to @${username} - race condition`);
            await this.sendMessageWithRetry(chatId, 
              `❌ Ticket #${ticketId.toString().padStart(6, '0')} is already being handled by another manager.`
            );
            return;
          }
          console.log(`✅ Assigned ticket #${ticketId} to manager @${username}`);
        } catch (assignError) {
          console.error(`🔴 Error assigning ticket #${ticketId} to @${username}:`, assignError);
          await this.sendErrorMessage(chatId, 'Error assigning ticket. Please try again.');
          return;
        }
      }

      // Add response to message history
      let messageId: number;
      try {
        messageId = await this.historyManager.addMessage(
          ticketId,
          MessageSide.TO,
          username,
          chatId,
          response.trim()
        );
        console.log(`💾 Manager response saved with ID ${messageId} for ticket #${ticketId}`);
      } catch (historyError) {
        console.error(`🔴 Failed to save manager response for ticket #${ticketId}:`, historyError);
        await this.sendErrorMessage(chatId, 'Error saving your response. Please try again.');
        return;
      }

      // Update ticket status and last reply ID
      try {
        await this.sessionManager.updateTicketStatus(ticketId, TicketStatus.REPLIED);
        await this.sessionManager.updateLastReplyId(ticketId, messageId);
        console.log(`🔄 Updated ticket #${ticketId} status to REPLIED`);
      } catch (updateError) {
        console.error(`🔴 Failed to update ticket #${ticketId} status:`, updateError);
        // Continue - the response was saved
      }

      // Send response to customer with retry
      try {
        await this.sendMessageWithRetry(ticket.customer_chat_id, 
          `💬 Support Response for Ticket #${ticketId.toString().padStart(6, '0')}:\n\n${response}`
        );
        console.log(`📤 Response sent to customer ${ticket.customer_chat_id} for ticket #${ticketId}`);
      } catch (customerError) {
        console.error(`🔴 Failed to send response to customer ${ticket.customer_chat_id}:`, customerError);
        
        // Inform manager about delivery failure
        await this.sendErrorMessage(chatId, 
          `⚠️ Your response was saved but could not be delivered to the customer. They may have blocked the bot.`
        );
        return;
      }

      // Confirm to manager
      try {
        await this.sendMessageWithRetry(chatId, 
          `✅ Your response has been sent to the customer for ticket #${ticketId.toString().padStart(6, '0')}.`
        );
      } catch (confirmError) {
        console.error(`🔴 Failed to send confirmation to manager ${chatId}:`, confirmError);
        // Don't throw - the main operation succeeded
      }

      const processingTime = Date.now() - startTime;
      console.log(`✅ Manager response processed successfully in ${processingTime}ms`);

    } catch (error) {
      const processingTime = Date.now() - startTime;
      console.error(`🔴 Error handling manager response from @${username} after ${processingTime}ms:`, error);
      
      let errorMessage = 'Sorry, there was an error processing your response. Please try again.';
      
      if (error instanceof Error) {
        if (error.message.includes('database')) {
          errorMessage = 'Database error occurred. Please try again in a few moments.';
        } else if (error.message.includes('blocked')) {
          errorMessage = 'The customer has blocked the bot. Your response was saved but not delivered.';
        }
      }
      
      await this.sendErrorMessage(chatId, errorMessage);
    }
  }

  private async handleCallback(query: TelegramBot.CallbackQuery): Promise<void> {
    if (!query.data || !query.message) return;

    const chatId = query.message.chat.id;
    const data = query.data;

    // Verify user is super admin
    const username = query.from.username || '';
    const userRole = await this.getUserRole(chatId, username);
    
    if (userRole !== UserRole.SUPER_ADMIN) {
      await this.bot.answerCallbackQuery(query.id, { text: 'Access denied!' });
      return;
    }

    try {
      switch (data) {
        case 'admin_managers':
          await this.showManagersMenu(chatId);
          break;
        case 'admin_kb':
          await this.showKBMenu(chatId);
          break;
        case 'admin_stats':
          await this.showStats(chatId);
          break;
        case 'auto_stats':
          await this.showDetailedAutoStats(chatId);
          break;
        case 'managers_add':
          await this.promptAddManager(chatId);
          break;
        case 'managers_list':
          await this.showManagersList(chatId);
          break;
        case 'managers_remove':
          await this.showRemoveManagersList(chatId);
          break;
        case 'kb_add':
          await this.promptAddKB(chatId);
          break;
        case 'kb_list':
          await this.showKBList(chatId);
          break;
        case 'kb_edit':
          await this.showEditKBList(chatId);
          break;
        case 'kb_delete':
          await this.showDeleteKBList(chatId);
          break;
        case 'back_main':
          await this.showSuperAdminMenu(chatId);
          break;
        default:
          if (data.startsWith('remove_manager_')) {
            const managerId = parseInt(data.replace('remove_manager_', ''));
            await this.removeManager(chatId, managerId);
          } else if (data.startsWith('delete_kb_')) {
            const kbId = parseInt(data.replace('delete_kb_', ''));
            await this.deleteKBEntry(chatId, kbId);
          } else if (data.startsWith('edit_kb_')) {
            const kbId = parseInt(data.replace('edit_kb_', ''));
            await this.promptEditKB(chatId, kbId);
          }
          break;
      }

      await this.bot.answerCallbackQuery(query.id);
    } catch (error) {
      console.error('Error handling callback:', error);
      await this.bot.answerCallbackQuery(query.id, { text: 'An error occurred!' });
    }
  }

  private async showSuperAdminMenu(chatId: number): Promise<void> {
    const message = 'Welcome Super Admin! Use the menu below to manage the support system:';
    
    const keyboard = {
      inline_keyboard: [
        [
          { text: '👥 Manage Managers', callback_data: 'admin_managers' },
          { text: '📚 Manage KB', callback_data: 'admin_kb' }
        ],
        [
          { text: '📊 View Stats', callback_data: 'admin_stats' }
        ]
      ]
    };

    await this.bot.sendMessage(chatId, message, { reply_markup: keyboard });
  }

  private async showManagersMenu(chatId: number): Promise<void> {
    const message = '👥 Manager Management:';
    
    const keyboard = {
      inline_keyboard: [
        [
          { text: '➕ Add Manager', callback_data: 'managers_add' },
          { text: '📋 List Managers', callback_data: 'managers_list' }
        ],
        [
          { text: '🗑️ Remove Manager', callback_data: 'managers_remove' }
        ],
        [
          { text: '⬅️ Back to Main Menu', callback_data: 'back_main' }
        ]
      ]
    };

    await this.bot.sendMessage(chatId, message, { reply_markup: keyboard });
  }

  private async showKBMenu(chatId: number): Promise<void> {
    const message = '📚 Knowledge Base Management:';
    
    const keyboard = {
      inline_keyboard: [
        [
          { text: '➕ Add Entry', callback_data: 'kb_add' },
          { text: '📋 List Entries', callback_data: 'kb_list' }
        ],
        [
          { text: '✏️ Edit Entry', callback_data: 'kb_edit' },
          { text: '🗑️ Delete Entry', callback_data: 'kb_delete' }
        ],
        [
          { text: '⬅️ Back to Main Menu', callback_data: 'back_main' }
        ]
      ]
    };

    await this.bot.sendMessage(chatId, message, { reply_markup: keyboard });
  }

  private async showStats(chatId: number): Promise<void> {
    try {
      const db = this.dbManager.getConnection();
      
      // Get basic statistics
      const totalTickets = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
      const openTickets = db.prepare('SELECT COUNT(*) as count FROM sessions WHERE status IN (0, 1, 2)').get() as { count: number };
      const closedTickets = db.prepare('SELECT COUNT(*) as count FROM sessions WHERE status = 3').get() as { count: number };
      const totalManagers = db.prepare('SELECT COUNT(*) as count FROM managers WHERE is_active = 1').get() as { count: number };
      const totalKBEntries = await this.kbManager.getEntryCount();

      // Get automated response statistics
      let automatedStats = '';
      try {
        const autoResponseCount = db.prepare('SELECT COUNT(*) as count FROM automated_responses WHERE success = 1 AND create_time >= datetime("now", "-30 days")').get() as { count: number } | undefined;
        const totalAttempts = db.prepare('SELECT COUNT(*) as count FROM automated_response_attempts WHERE create_time >= datetime("now", "-30 days")').get() as { count: number } | undefined;
        
        if (autoResponseCount && totalAttempts) {
          const successRate = totalAttempts.count > 0 ? Math.round((autoResponseCount.count / totalAttempts.count) * 100) : 0;
          automatedStats = `\n\n🤖 Automated Responses (30 days):
📈 Successful: ${autoResponseCount.count}
🎯 Attempts: ${totalAttempts.count}
📊 Success Rate: ${successRate}%`;
        } else {
          automatedStats = '\n\n🤖 Automated Responses: No data available';
        }
      } catch (autoError) {
        console.warn('Could not retrieve automated response stats:', autoError);
        automatedStats = '\n\n🤖 Automated Responses: Stats unavailable';
      }

      const message = `📊 System Statistics:

🎫 Total Tickets: ${totalTickets.count}
🟢 Open Tickets: ${openTickets.count}
🔴 Closed Tickets: ${closedTickets.count}
👥 Active Managers: ${totalManagers.count}
📚 KB Entries: ${totalKBEntries}${automatedStats}`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: '🤖 Detailed Auto Stats', callback_data: 'auto_stats' },
            { text: '⬅️ Back to Main Menu', callback_data: 'back_main' }
          ]
        ]
      };

      await this.bot.sendMessage(chatId, message, { reply_markup: keyboard });
    } catch (error) {
      console.error('Error showing stats:', error);
      await this.sendErrorMessage(chatId, 'Error retrieving statistics.');
    }
  }

  private async showDetailedAutoStats(chatId: number): Promise<void> {
    try {
      const metrics = await this.getAutomatedResponseMetrics();
      
      if (!metrics) {
        await this.bot.sendMessage(chatId, '❌ Unable to retrieve automated response metrics.');
        return;
      }

      let message = `🤖 Detailed Automated Response Statistics (${metrics.period}):\n\n`;
      
      // Success rate
      message += `📈 **Success Rate:**\n`;
      message += `• Total Attempts: ${metrics.successRate.total_attempts || 0}\n`;
      message += `• Successful Responses: ${metrics.successRate.successful_responses || 0}\n`;
      message += `• Success Rate: ${metrics.successRate.success_rate_percent || 0}%\n\n`;
      
      // Confidence distribution
      if (metrics.confidenceDistribution.length > 0) {
        message += `🎯 **Confidence Distribution:**\n`;
        metrics.confidenceDistribution.forEach((conf: any) => {
          const emoji = conf.confidence === 'high' ? '🟢' : conf.confidence === 'medium' ? '🟡' : '🔴';
          message += `${emoji} ${conf.confidence}: ${conf.count} (${conf.percentage}%)\n`;
        });
        message += '\n';
      }
      
      // Average similarity scores
      if (metrics.avgSimilarityByConfidence.length > 0) {
        message += `📊 **Average Similarity Scores:**\n`;
        metrics.avgSimilarityByConfidence.forEach((avg: any) => {
          message += `• ${avg.confidence}: ${avg.avg_similarity_score} (${avg.count} responses)\n`;
        });
        message += '\n';
      }
      
      // Attempt metrics
      message += `🔍 **Attempt Analysis:**\n`;
      message += `• Search Attempts: ${metrics.attemptMetrics.total_attempts || 0}\n`;
      message += `• Successful Matches: ${metrics.attemptMetrics.successful_responses || 0}\n`;
      const matchRate = metrics.attemptMetrics.total_attempts > 0 ? 
        Math.round((metrics.attemptMetrics.successful_responses / metrics.attemptMetrics.total_attempts) * 100) : 0;
      message += `• Match Rate: ${matchRate}%\n`;

      const keyboard = {
        inline_keyboard: [
          [{ text: '⬅️ Back to Stats', callback_data: 'admin_stats' }]
        ]
      };

      await this.bot.sendMessage(chatId, message, { reply_markup: keyboard });
    } catch (error) {
      console.error('Error showing detailed auto stats:', error);
      await this.sendErrorMessage(chatId, 'Error retrieving detailed automated response statistics.');
    }
  }

  private async promptAddManager(chatId: number): Promise<void> {
    await this.bot.sendMessage(chatId, 
      'To add a new manager, please send their information in this format:\n\n' +
      'ADD_MANAGER @username chat_id\n\n' +
      'Example: ADD_MANAGER @john_doe 123456789\n\n' +
      'Note: The manager must start a conversation with the bot first to get their chat_id.'
    );
  }

  private async showManagersList(chatId: number): Promise<void> {
    try {
      const db = this.dbManager.getConnection();
      const managers = db.prepare('SELECT * FROM managers WHERE is_active = 1 ORDER BY username').all() as any[];

      if (managers.length === 0) {
        await this.bot.sendMessage(chatId, 'No active managers found.');
        return;
      }

      let message = '👥 Active Managers:\n\n';
      managers.forEach((manager, index) => {
        message += `${index + 1}. @${manager.username} (ID: ${manager.chat_id})\n`;
      });

      const keyboard = {
        inline_keyboard: [
          [{ text: '⬅️ Back to Managers Menu', callback_data: 'admin_managers' }]
        ]
      };

      await this.bot.sendMessage(chatId, message, { reply_markup: keyboard });
    } catch (error) {
      console.error('Error showing managers list:', error);
      await this.sendErrorMessage(chatId, 'Error retrieving managers list.');
    }
  }

  private async showRemoveManagersList(chatId: number): Promise<void> {
    try {
      const db = this.dbManager.getConnection();
      const managers = db.prepare('SELECT * FROM managers WHERE is_active = 1 ORDER BY username').all() as any[];

      if (managers.length === 0) {
        await this.bot.sendMessage(chatId, 'No active managers found.');
        return;
      }

      const keyboard = {
        inline_keyboard: managers.map(manager => [
          { text: `🗑️ Remove @${manager.username}`, callback_data: `remove_manager_${manager.id}` }
        ]).concat([[{ text: '⬅️ Back to Managers Menu', callback_data: 'admin_managers' }]])
      };

      await this.bot.sendMessage(chatId, 'Select a manager to remove:', { reply_markup: keyboard });
    } catch (error) {
      console.error('Error showing remove managers list:', error);
      await this.sendErrorMessage(chatId, 'Error retrieving managers list.');
    }
  }

  private async removeManager(chatId: number, managerId: number): Promise<void> {
    try {
      const db = this.dbManager.getConnection();
      const stmt = db.prepare('UPDATE managers SET is_active = 0, update_time = CURRENT_TIMESTAMP WHERE id = ?');
      const result = stmt.run(managerId);

      if (result.changes > 0) {
        // Remove from cache
        const manager = db.prepare('SELECT chat_id FROM managers WHERE id = ?').get(managerId) as { chat_id: number } | undefined;
        if (manager) {
          this.managers.delete(manager.chat_id);
        }

        await this.bot.sendMessage(chatId, '✅ Manager removed successfully!');
        await this.showManagersMenu(chatId);
      } else {
        await this.bot.sendMessage(chatId, '❌ Manager not found or already inactive.');
      }
    } catch (error) {
      console.error('Error removing manager:', error);
      await this.sendErrorMessage(chatId, 'Error removing manager.');
    }
  }

  private async promptAddKB(chatId: number): Promise<void> {
    await this.bot.sendMessage(chatId, 
      '📝 To add a new KB entry, please send the information in this format:\n\n' +
      'ADD_KB\n' +
      'Category: [category]\n' +
      'Question: [question]\n' +
      'Answer: [answer]\n\n' +
      '💡 Example:\n' +
      'ADD_KB\n' +
      'Category: Account\n' +
      'Question: How to reset password?\n' +
      'Answer: Go to login page and click "Forgot Password"\n\n' +
      '🔍 To check for similar entries first, use:\n' +
      'CHECK_SIMILAR [your question]\n\n' +
      '🤖 Note: Context will be automatically generated based on the question.\n' +
      '⚠️ The system will automatically prevent duplicate entries.'
    );
  }

  private async showKBList(chatId: number): Promise<void> {
    try {
      const entries = await this.kbManager.getAllEntries();

      if (entries.length === 0) {
        await this.bot.sendMessage(chatId, 'No KB entries found.');
        return;
      }

      let message = '📚 Knowledge Base Entries:\n\n';
      entries.forEach((entry, index) => {
        message += `${index + 1}. [${entry.category}] ${entry.question}\n`;
        if (message.length > 3500) { // Telegram message limit
          message += '... (truncated)';
          return;
        }
      });

      const keyboard = {
        inline_keyboard: [
          [{ text: '⬅️ Back to KB Menu', callback_data: 'admin_kb' }]
        ]
      };

      await this.bot.sendMessage(chatId, message, { reply_markup: keyboard });
    } catch (error) {
      console.error('Error showing KB list:', error);
      await this.sendErrorMessage(chatId, 'Error retrieving KB entries.');
    }
  }

  private async showEditKBList(chatId: number): Promise<void> {
    try {
      const entries = await this.kbManager.getAllEntries();

      if (entries.length === 0) {
        await this.bot.sendMessage(chatId, 'No KB entries found.');
        return;
      }

      const keyboard = {
        inline_keyboard: entries.slice(0, 10).map(entry => [
          { text: `✏️ [${entry.category}] ${entry.question.substring(0, 30)}...`, callback_data: `edit_kb_${entry.id}` }
        ]).concat([[{ text: '⬅️ Back to KB Menu', callback_data: 'admin_kb' }]])
      };

      await this.bot.sendMessage(chatId, 'Select a KB entry to edit (showing first 10):', { reply_markup: keyboard });
    } catch (error) {
      console.error('Error showing edit KB list:', error);
      await this.sendErrorMessage(chatId, 'Error retrieving KB entries.');
    }
  }

  private async showDeleteKBList(chatId: number): Promise<void> {
    try {
      const entries = await this.kbManager.getAllEntries();

      if (entries.length === 0) {
        await this.bot.sendMessage(chatId, 'No KB entries found.');
        return;
      }

      const keyboard = {
        inline_keyboard: entries.slice(0, 10).map(entry => [
          { text: `🗑️ [${entry.category}] ${entry.question.substring(0, 30)}...`, callback_data: `delete_kb_${entry.id}` }
        ]).concat([[{ text: '⬅️ Back to KB Menu', callback_data: 'admin_kb' }]])
      };

      await this.bot.sendMessage(chatId, 'Select a KB entry to delete (showing first 10):', { reply_markup: keyboard });
    } catch (error) {
      console.error('Error showing delete KB list:', error);
      await this.sendErrorMessage(chatId, 'Error retrieving KB entries.');
    }
  }

  private async deleteKBEntry(chatId: number, kbId: number): Promise<void> {
    try {
      const deleted = await this.kbManager.deleteEntry(kbId);

      if (deleted) {
        await this.bot.sendMessage(chatId, '✅ KB entry deleted successfully!');
        await this.showKBMenu(chatId);
      } else {
        await this.bot.sendMessage(chatId, '❌ KB entry not found.');
      }
    } catch (error) {
      console.error('Error deleting KB entry:', error);
      await this.sendErrorMessage(chatId, 'Error deleting KB entry.');
    }
  }

  private async promptEditKB(chatId: number, kbId: number): Promise<void> {
    try {
      const entry = await this.kbManager.getEntryById(kbId);
      if (!entry) {
        await this.bot.sendMessage(chatId, '❌ KB entry not found.');
        return;
      }

      // Show current content and provide pre-filled template for editing
      const preFilledTemplate = 
        `EDIT_KB ${kbId}\n` +
        `Category: ${entry.category}\n` +
        `Question: ${entry.question}\n` +
        `Answer: ${entry.answer}`;

      await this.bot.sendMessage(chatId, 
        `📝 **Editing KB Entry #${kbId}**\n\n` +
        `**Current Content:**\n` +
        `Category: ${entry.category}\n` +
        `Question: ${entry.question}\n` +
        `Context: ${entry.context || 'Auto-generated'}\n` +
        `Answer: ${entry.answer}\n\n` +
        `**How to Edit:**\n` +
        `Copy the template below, modify only the parts you want to change, then send it:\n\n` +
        `\`\`\`\n${preFilledTemplate}\n\`\`\`\n\n` +
        `🤖 **Note:** Context will be automatically updated based on the question.\n` +
        `💡 **Tip:** Copy this text and modify only the fields you need to update.`,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.error('Error showing KB entry for edit:', error);
      await this.sendErrorMessage(chatId, 'Error retrieving KB entry.');
    }
  }

  private async sendErrorMessage(chatId: number, message: string): Promise<void> {
    try {
      await this.sendMessageWithRetry(chatId, `⚠️ ${message}`);
    } catch (error) {
      console.error(`🔴 Failed to send error message to ${chatId}:`, error);
    }
  }

  private async sendMessageWithRetry(chatId: number, message: string, maxRetries: number = 3): Promise<void> {
    let retryCount = 0;
    
    while (retryCount < maxRetries) {
      try {
        await this.bot.sendMessage(chatId, message);
        return;
      } catch (error: any) {
        retryCount++;
        console.error(`🔴 Telegram API error (attempt ${retryCount}/${maxRetries}) for chat ${chatId}:`, error);
        
        // Handle specific Telegram API errors
        if (error.code === 'ETELEGRAM') {
          const telegramError = error.response?.body;
          
          if (telegramError?.error_code === 403) {
            console.error(`🚫 Bot blocked by user ${chatId}, removing from managers if applicable`);
            this.managers.delete(chatId);
            throw new Error(`User ${chatId} has blocked the bot`);
          }
          
          if (telegramError?.error_code === 429) {
            const retryAfter = telegramError.parameters?.retry_after || (retryCount * 2);
            console.log(`⏳ Rate limited, waiting ${retryAfter} seconds before retry`);
            await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
            continue;
          }
          
          if (telegramError?.error_code === 400) {
            console.error(`❌ Bad request for chat ${chatId}: ${telegramError.description}`);
            throw new Error(`Invalid request: ${telegramError.description}`);
          }
        }
        
        if (retryCount >= maxRetries) {
          throw error;
        }
        
        // Exponential backoff
        const delay = Math.min(1000 * Math.pow(2, retryCount - 1), 10000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  private startScheduledTasks(): void {
    console.log('⏰ Starting scheduled tasks...');
    
    // Start automatic ticket closure task - runs every 30 minuites
    this.ticketClosureInterval = setInterval(async () => {
      try {
        await this.closeExpiredTickets();
      } catch (error) {
        console.error('🔴 Error in ticket closure task:', error);
      }
    }, 60 * 1000 * 30); // 30 minutes

    // Start manager reminder task - runs every 5 minutes
    this.managerReminderInterval = setInterval(async () => {
      try {
        await this.sendManagerReminders();
      } catch (error) {
        console.error('🔴 Error in manager reminder task:', error);
      }
    }, 60 * 1000 * 5); // 5 minute

    console.log('✅ Scheduled tasks started successfully');
    console.log('   - Ticket closure check: every 30 seconds');
    console.log('   - Manager reminders: every 60 seconds');
  }

  private async closeExpiredTickets(): Promise<void> {
    try {
      console.log('🔍 Checking for expired tickets...');
      const closedCount = await this.sessionManager.closeExpiredTickets();
      
      if (closedCount > 0) {
        console.log(`🔒 Automatically closed ${closedCount} expired tickets`);
        
        // Log closure events for each closed ticket with error handling
        try {
          const db = this.dbManager.getConnection();
          const recentlyClosed = db.prepare(`
            SELECT id, customer_chat_id, customer_username 
            FROM sessions 
            WHERE status = ? AND datetime(update_time) > datetime('now', '-1 minute')
          `).all(TicketStatus.CLOSED) as Session[];

          console.log(`📤 Notifying ${recentlyClosed.length} customers about ticket closures`);

          // Notify customers about automatic closure with parallel processing
          const notificationPromises = recentlyClosed.map(async (ticket) => {
            try {
              await this.sendMessageWithRetry(
                ticket.customer_chat_id,
                `🔒 Your support ticket #${ticket.id.toString().padStart(6, '0')} has been automatically closed due to inactivity. If you need further assistance, please send a new message.`
              );
              console.log(`✅ Notified customer ${ticket.customer_chat_id} about ticket #${ticket.id} closure`);
            } catch (error: any) {
              console.error(`🔴 Failed to notify customer ${ticket.customer_chat_id} about ticket #${ticket.id} closure:`, error);
              
              if (error.message.includes('blocked')) {
                console.log(`🚫 Customer ${ticket.customer_chat_id} has blocked the bot`);
              }
            }
          });

          await Promise.allSettled(notificationPromises);
          console.log(`📊 Closure notifications completed for ${recentlyClosed.length} tickets`);
          
        } catch (dbError) {
          console.error('🔴 Database error retrieving recently closed tickets:', dbError);
        }
      } else {
        console.log('✅ No expired tickets found');
      }
    } catch (error) {
      console.error('🔴 Error in closeExpiredTickets task:', error);
      
      // Log additional context for debugging
      if (error instanceof Error) {
        console.error('Error details:', {
          name: error.name,
          message: error.message,
          stack: error.stack?.split('\n').slice(0, 5).join('\n') // First 5 lines of stack
        });
      }
    }
  }

  private async sendManagerReminders(): Promise<void> {
    try {
      console.log('🔔 Checking for tickets needing manager reminders...');
      
      const db = this.dbManager.getConnection();
      
      // Find tickets that need manager reminders with error handling
      let ticketsNeedingReminders: (Session & { last_customer_message_time: string })[] = [];
      
      try {
        ticketsNeedingReminders = db.prepare(`
          SELECT s.*, mh.message_time as last_customer_message_time
          FROM sessions s
          JOIN message_history mh ON s.last_message_id = mh.id
          WHERE s.status = ? 
          AND s.operator_chat_id IS NOT NULL
          AND datetime(mh.message_time, '+1 minute') <= datetime('now')
          AND (s.last_reply_id IS NULL OR s.last_reply_id < s.last_message_id)
        `).all(TicketStatus.WAITING_REPLY) as (Session & { last_customer_message_time: string })[];
      } catch (dbError) {
        console.error('🔴 Database error retrieving tickets for reminders:', dbError);
        return;
      }

      if (ticketsNeedingReminders.length === 0) {
        console.log('✅ No tickets need manager reminders');
        return;
      }

      console.log(`📋 Found ${ticketsNeedingReminders.length} tickets needing reminders`);
      let remindersSent = 0;
      let remindersSkipped = 0;
      let remindersFailed = 0;

      for (const ticket of ticketsNeedingReminders) {
        try {
          // Simple rate limiting: check if we sent a reminder for this ticket recently
          const timeSinceLastUpdate = new Date().getTime() - new Date(ticket.update_time).getTime();
          const fiveMinutesInMs = 5 * 60 * 1000;
          
          // Skip if we've updated this ticket recently (likely sent a reminder)
          if (timeSinceLastUpdate < fiveMinutesInMs) {
            remindersSkipped++;
            console.log(`⏭️ Skipping reminder for ticket #${ticket.id} (recent update)`);
            continue;
          }

          // Get the last customer message for context with error handling
          let lastMessage: any = null;
          try {
            lastMessage = await this.historyManager.getLastMessage(ticket.id, MessageSide.FROM);
          } catch (historyError) {
            console.error(`🔴 Error getting last message for ticket #${ticket.id}:`, historyError);
            continue;
          }
          
          if (lastMessage && ticket.operator_chat_id) {
            const truncatedMessage = lastMessage.message.length > 150 
              ? lastMessage.message.substring(0, 150) + '...' 
              : lastMessage.message;
              
            const reminderText = `🔔 REMINDER: Ticket #${ticket.id.toString().padStart(6, '0')} needs your attention!\n\n👤 Customer: @${ticket.customer_username}\n⏰ Waiting since: ${new Date(ticket.last_customer_message_time).toLocaleString()}\n💬 Last message: ${truncatedMessage}`;
            
            try {
              await this.sendMessageWithRetry(ticket.operator_chat_id, reminderText);
              remindersSent++;
              
              // Update the session's update_time to track that we sent a reminder
              try {
                db.prepare('UPDATE sessions SET update_time = CURRENT_TIMESTAMP WHERE id = ?').run(ticket.id);
              } catch (updateError) {
                console.error(`🔴 Failed to update reminder timestamp for ticket #${ticket.id}:`, updateError);
              }
              
              console.log(`✅ Sent reminder to manager @${ticket.operator_username} for ticket #${ticket.id}`);
              
            } catch (reminderError: any) {
              remindersFailed++;
              console.error(`🔴 Failed to send reminder for ticket #${ticket.id}:`, reminderError);
              
              if (reminderError.message.includes('blocked')) {
                console.log(`🚫 Manager ${ticket.operator_chat_id} has blocked the bot, removing from active list`);
                this.managers.delete(ticket.operator_chat_id);
                
                try {
                  db.prepare('UPDATE managers SET is_active = 0 WHERE chat_id = ?').run(ticket.operator_chat_id);
                } catch (dbUpdateError) {
                  console.error(`🔴 Failed to update blocked manager status:`, dbUpdateError);
                }
              }
            }
          } else {
            console.log(`⚠️ Missing data for reminder - ticket #${ticket.id}: lastMessage=${!!lastMessage}, operator=${ticket.operator_chat_id}`);
          }
        } catch (error) {
          remindersFailed++;
          console.error(`🔴 Error processing reminder for ticket #${ticket.id}:`, error);
        }
      }
      
      console.log(`📊 Manager reminders completed: ${remindersSent} sent, ${remindersSkipped} skipped, ${remindersFailed} failed`);
      
    } catch (error) {
      console.error('🔴 Error in sendManagerReminders task:', error);
      
      // Log additional context for debugging
      if (error instanceof Error) {
        console.error('Error details:', {
          name: error.name,
          message: error.message,
          stack: error.stack?.split('\n').slice(0, 5).join('\n')
        });
      }
    }
  }

  private stopScheduledTasks(): void {
    if (this.ticketClosureInterval) {
      clearInterval(this.ticketClosureInterval);
      this.ticketClosureInterval = undefined;
    }
    
    if (this.managerReminderInterval) {
      clearInterval(this.managerReminderInterval);
      this.managerReminderInterval = undefined;
    }
    
    console.log('Scheduled tasks stopped');
  }

  public async shutdown(): Promise<void> {
    try {
      console.log('🛑 Shutting down bot...');
      
      // Stop scheduled tasks first
      this.stopScheduledTasks();
      
      // Stop polling with timeout
      try {
        await Promise.race([
          this.bot.stopPolling(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Polling stop timeout')), 5000))
        ]);
        console.log('✅ Telegram polling stopped');
      } catch (error) {
        console.error('⚠️ Error stopping polling:', error);
      }
      
      // Close database connection
      try {
        this.dbManager.close();
        console.log('✅ Database connection closed');
      } catch (error) {
        console.error('⚠️ Error closing database:', error);
      }
      
      console.log('✅ Bot shutdown complete');
    } catch (error) {
      console.error('🔴 Error during shutdown:', error);
    }
  }
}

// Main execution
async function main() {
  try {
    console.log('🚀 Starting Customer Support Bot...');
    console.log(`📅 Started at: ${new Date().toISOString()}`);
    
    const bot = new CustomerSupportBot();
    await bot.initialize();
    
    console.log('🎉 Customer Support Bot is running and ready to serve!');
    console.log('📞 Waiting for customer messages and admin commands...');
    
  } catch (error) {
    console.error('💥 Failed to start bot:', error);
    
    // Log additional context for debugging
    if (error instanceof Error) {
      console.error('Error details:', {
        name: error.name,
        message: error.message,
        stack: error.stack
      });
    }
    
    process.exit(1);
  }
}

// Start the bot
if (require.main === module) {
  main();
}

export { CustomerSupportBot };