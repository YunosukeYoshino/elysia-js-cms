import type { PrismaClient } from '@prisma/client';

/**
 * Base service class for all domain services
 * Provides common functionality and error handling patterns
 */
export abstract class BaseService {
  protected prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Handle errors with consistent logging and rethrowing
   * @param error - The caught error
   * @param context - Context information for debugging
   */
  protected handleError(error: unknown, context: string): never {
    // Log error in development/test environments
    if (process.env.NODE_ENV !== 'production') {
      console.error(`[${context}] Service error:`, error);
    }

    // Re-throw the error to be handled by the global error handler
    if (error instanceof Error) {
      throw error;
    }

    // Create a new error if the thrown value is not an Error
    const errorMessage = typeof error === 'string' ? error : 'Internal service error';
    throw new Error(errorMessage);
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
