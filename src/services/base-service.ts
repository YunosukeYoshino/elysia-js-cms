import type { PrismaClient } from '@prisma/client';

/**
 * Base service class for all domain services
 * Provides common functionality and error handling patterns
 */
export abstract class BaseService {
  protected prisma: PrismaClient;
  private _initialized: boolean = false;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Initialize the service asynchronously
   * Override this method in subclasses for custom initialization
   */
  async initialize(): Promise<void> {
    if (this._initialized) {
      return;
    }

    try {
      // Test database connection (skip in test environment if already connected)
      if (process.env.NODE_ENV !== 'test') {
        await this.prisma.$connect();
      }
      this._initialized = true;
      this.log('Service initialized successfully');
    } catch (error) {
      this.handleError(error, `${this.constructor.name}.initialize`);
    }
  }

  /**
   * Check if service is initialized
   */
  get isInitialized(): boolean {
    return this._initialized;
  }

  /**
   * Handle errors with consistent logging and rethrowing
   * @param error - The caught error
   * @param context - Context information for debugging
   * @param shouldThrow - Whether to throw the error (default: true)
   * @returns Error object if shouldThrow is false, otherwise never returns
   */
  protected handleError(
    error: unknown,
    context: string,
    shouldThrow: boolean = true,
  ): Error | never {
    // Log error in development/test environments
    if (process.env.NODE_ENV !== 'production') {
      console.error(`[${context}] Service error:`, error);
    }

    // Create error object
    let errorObj: Error;
    if (error instanceof Error) {
      errorObj = error;
    } else {
      const errorMessage = typeof error === 'string' ? error : 'Internal service error';
      errorObj = new Error(errorMessage);
    }

    // Add context to error message for better debugging
    if (errorObj.message && !errorObj.message.includes(context)) {
      errorObj.message = `[${context}] ${errorObj.message}`;
    }

    if (shouldThrow) {
      throw errorObj;
    }

    return errorObj;
  }

  /**
   * Handle recoverable errors that don't need to be thrown
   * @param error - The caught error
   * @param context - Context information for debugging
   * @returns Error object
   */
  protected handleRecoverableError(error: unknown, context: string): Error {
    return this.handleError(error, context, false);
  }

  /**
   * Log information in non-production environments
   * @param message - Log message
   * @param data - Additional data to log
   */
  protected log(message: string, data?: unknown): void {
    if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
      console.log(`[${this.constructor.name}] ${message}`, data || '');
    }
  }
}
