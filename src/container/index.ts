import { Elysia } from 'elysia';
import prisma from '../lib/prisma';
import { AuthService } from '../services/auth-service';
import { CategoryService } from '../services/category-service';
import { FileService } from '../services/file-service';
import { PostService } from '../services/post-service';

/**
 * Dependency Injection Container
 * Provides all services as singleton instances
 */
export const containerPlugin = new Elysia({ name: 'container' }).decorate('services', {
  auth: new AuthService(prisma),
  post: new PostService(prisma),
  category: new CategoryService(prisma),
  file: new FileService(prisma),
});

// Type definition for service container
export interface ServiceContainer {
  auth: AuthService;
  post: PostService;
  category: CategoryService;
  file: FileService;
}

// Extend Elysia context with services
declare module 'elysia' {
  interface Context {
    services: ServiceContainer;
  }
}
