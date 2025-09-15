import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { File, User } from '@prisma/client';
import type { Fields, Files, File as FormidableFile, IncomingForm } from 'formidable';
import mime from 'mime-types';
import sharp from 'sharp';
import { BaseService } from './base-service';

/**
 * ファイルアップロードのドメインインターフェース
 */
interface FileUpload extends FormidableFile {
  filepath: string;
  originalFilename: string;
  newFilename: string;
  size: number;
}

/**
 * ファイルアップロードのレスポンスインターフェース
 */
interface FileUploadResponse {
  success: boolean;
  message: string;
  file?: File;
}

/**
 * ファイルリストレスポンスインターフェース
 */
interface FileListResponse {
  success: boolean;
  data?: File[];
  pagination?: {
    total: number;
    page: number;
    limit: number;
    pages: number;
  };
  message?: string;
  error?: string;
}

/**
 * ファイルレスポンスインターフェース
 */
interface FileResponse {
  success: boolean;
  data?: File;
  message?: string;
  error?: string;
}

/**
 * ファイル削除レスポンスインターフェース
 */
interface FileDeleteResponse {
  success: boolean;
  message: string;
}

/**
 * File service
 * Handles all file management business logic including upload, storage, and thumbnail generation
 */
export class FileService extends BaseService {
  private readonly UPLOAD_DIR = './uploads';
  private readonly THUMBS_DIR = './uploads/thumbnails';
  private readonly MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
  private _directoriesInitialized = false;

  /**
   * Initialize the file service
   * Creates necessary directories and sets up the service
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Call parent initialization first
      await super.initialize();

      // Initialize upload directories
      await this.initializeDirectories();

      this.log('FileService initialized successfully');
    } catch (error) {
      this.handleError(error, 'FileService.initialize');
    }
  }

  /**
   * Initialize upload directories
   */
  private async initializeDirectories(): Promise<void> {
    if (this._directoriesInitialized) {
      return;
    }

    try {
      await Promise.all([
        mkdir(this.UPLOAD_DIR, { recursive: true }),
        mkdir(this.THUMBS_DIR, { recursive: true }),
      ]);
      this._directoriesInitialized = true;
      this.log('Upload directories initialized');
    } catch (error) {
      this.handleError(error, 'FileService.initializeDirectories');
    }
  }

  /**
   * Upload file with thumbnail generation
   */
  async uploadFile(
    form: IncomingForm,
    request: Request,
    userId: number,
    _set: { status: number },
  ): Promise<FileUploadResponse> {
    try {
      // Ensure service is initialized
      if (!this.isInitialized) {
        await this.initialize();
      }

      return new Promise<FileUploadResponse>((resolve, reject) => {
        form.parse(request, async (err: Error | null, _fields: Fields, files: Files) => {
          try {
            if (err) {
              this.log('File upload parsing failed', err);
              return reject(new Error('ファイルのアップロードに失敗しました'));
            }

            const uploadedFile = files.file?.[0] as FileUpload;
            if (!uploadedFile) {
              return reject(new Error('ファイルが見つかりません'));
            }

            // Validate file size
            if (uploadedFile.size > this.MAX_FILE_SIZE) {
              return reject(new Error('ファイルサイズが大きすぎます'));
            }

            // Generate file metadata
            const originalName = uploadedFile.originalFilename || 'unknown';
            const mimeType = mime.lookup(originalName) || 'application/octet-stream';

            // Save file to database
            const fileData = await this.prisma.file.create({
              data: {
                fileName: originalName,
                originalName,
                mimeType,
                filePath: uploadedFile.filepath,
                fileSize: uploadedFile.size,
                userId: userId,
              },
            });

            // Generate thumbnail for images
            if (mimeType.startsWith('image/') && mimeType !== 'image/svg+xml') {
              await this.generateThumbnail(uploadedFile.filepath, fileData.id);
            }

            this.log(`File uploaded successfully: ${originalName}`);
            resolve({
              success: true,
              message: 'ファイルのアップロードが完了しました',
              file: fileData,
            });
          } catch (error) {
            this.log('File processing error', error);
            reject(new Error('ファイル処理中にエラーが発生しました'));
          }
        });
      });
    } catch (error) {
      this.handleError(error, 'FileService.uploadFile');
    }
  }

  /**
   * Generate thumbnail for image files
   */
  private async generateThumbnail(filePath: string, fileId: number): Promise<void> {
    try {
      const thumbPath = join(this.THUMBS_DIR, `${fileId}_thumb.jpg`);
      await sharp(filePath)
        .resize(200, 200, { fit: 'inside' })
        .jpeg({ quality: 80 })
        .toFile(thumbPath);

      await this.prisma.file.update({
        where: { id: fileId },
        data: {
          thumbnailPath: `/thumbnails/${fileId}_thumb.jpg`,
        },
      });

      this.log(`Thumbnail generated for file ID: ${fileId}`);
    } catch (error) {
      this.log(`Failed to generate thumbnail for file ID: ${fileId}`, error);
      // Don't throw - thumbnail generation is optional
    }
  }

  /**
   * Get paginated file list
   */
  async getFileList(page = 1, limit = 20): Promise<FileListResponse> {
    try {
      const skip = (page - 1) * limit;

      const files = await this.prisma.file.findMany({
        skip,
        take: limit,
        orderBy: {
          createdAt: 'desc',
        },
      });

      const total = await this.prisma.file.count();

      return {
        success: true,
        data: files,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      this.handleError(error, 'FileService.getFileList');
    }
  }

  /**
   * Get file by ID
   */
  async getFileById(fileId: number): Promise<FileResponse> {
    try {
      const file = await this.prisma.file.findUnique({
        where: { id: fileId },
      });

      if (!file) {
        return {
          success: false,
          message: 'File not found',
        };
      }

      return {
        success: true,
        data: file,
      };
    } catch (error) {
      this.handleError(error, 'FileService.getFileById');
    }
  }

  /**
   * Get file by filename
   */
  async getFileByName(fileName: string): Promise<File | null> {
    try {
      return await this.prisma.file.findFirst({
        where: { fileName },
      });
    } catch (error) {
      this.handleError(error, 'FileService.getFileByName');
    }
  }

  /**
   * Delete file by ID
   */
  async deleteFile(fileId: number, user: User): Promise<FileDeleteResponse> {
    try {
      // Get file information
      const file = await this.prisma.file.findUnique({
        where: { id: fileId },
      });

      if (!file) {
        return {
          success: false,
          message: 'File not found',
        };
      }

      // Check ownership (only owner or admin can delete)
      if (file.userId !== user.id && user.role !== 'admin') {
        return {
          success: false,
          message: 'Permission denied',
        };
      }

      // Delete from database
      await this.prisma.file.delete({
        where: { id: fileId },
      });

      // Delete physical file
      const actualFilePath = join(this.UPLOAD_DIR, file.fileName);
      await unlink(actualFilePath);

      // Delete thumbnail if exists
      if (file.thumbnailPath) {
        const actualThumbPath = join(this.THUMBS_DIR, `${fileId}_thumb.jpg`);
        await unlink(actualThumbPath);
      }

      this.log(`File deleted successfully: ${file.originalName}`);
      return {
        success: true,
        message: 'File deleted successfully',
      };
    } catch (error) {
      this.handleError(error, 'FileService.deleteFile');
    }
  }

  /**
   * Get upload and thumbnail directory paths
   */
  getDirectoryPaths(): { uploadDir: string; thumbsDir: string } {
    return {
      uploadDir: this.UPLOAD_DIR,
      thumbsDir: this.THUMBS_DIR,
    };
  }
}
