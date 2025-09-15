import { Elysia } from 'elysia';
import prisma from '../lib/prisma';
import { AuthService } from '../services/auth-service';
import { CategoryService } from '../services/category-service';
import { FileService } from '../services/file-service';
import { PostService } from '../services/post-service';

/**
 * Dependency Injection Container
 * Provides all services as singleton instances with async initialization
 */
class ServiceContainerImpl {
  private _auth: AuthService | null = null;
  private _post: PostService | null = null;
  private _category: CategoryService | null = null;
  private _file: FileService | null = null;
  private _initialized: boolean = false;

  get isInitialized(): boolean {
    return this._initialized;
  }

  async initialize(): Promise<void> {
    if (this._initialized) {
      return;
    }

    try {
      // Create service instances
      this._auth = new AuthService(prisma);
      this._post = new PostService(prisma);
      this._category = new CategoryService(prisma);
      this._file = new FileService(prisma);

      // Initialize services that need async setup
      await Promise.all([
        this._auth.initialize(),
        this._post.initialize(),
        this._category.initialize(),
        this._file.initialize(),
      ]);

      this._initialized = true;
      console.log('All services initialized successfully');
    } catch (error) {
      console.error('Failed to initialize services:', error);
      throw error;
    }
  }

  get auth(): AuthService {
    if (!this._auth) {
      throw new Error('Services not initialized. Call initialize() first.');
    }
    return this._auth;
  }

  get post(): PostService {
    if (!this._post) {
      throw new Error('Services not initialized. Call initialize() first.');
    }
    return this._post;
  }

  get category(): CategoryService {
    if (!this._category) {
      throw new Error('Services not initialized. Call initialize() first.');
    }
    return this._category;
  }

  get file(): FileService {
    if (!this._file) {
      throw new Error('Services not initialized. Call initialize() first.');
    }
    return this._file;
  }
}

const serviceContainer = new ServiceContainerImpl();

export const containerPlugin = new Elysia({ name: 'container' })
  .decorate('services', serviceContainer)
  .onStart(async () => {
    // Initialize services when the server starts
    await serviceContainer.initialize();
  })
  .onRequest(async () => {
    // Ensure services are initialized before handling requests
    if (!serviceContainer.isInitialized) {
      await serviceContainer.initialize();
    }
  });

// Type definition for service container
export interface ServiceContainer {
  auth: AuthService;
  post: PostService;
  category: CategoryService;
  file: FileService;
}
