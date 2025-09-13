import type { IncomingMessage } from 'node:http';

/**
 * Elysiaのリクエストオブジェクトをformidableで処理可能な形式に拡張
 */
declare module 'formidable' {
  interface IncomingForm {
    parse(
      req: Request | IncomingMessage,
      callback?: (
        err: Error | null,
        fields: import('formidable').Fields,
        files: import('formidable').Files,
      ) => void,
    ): void;
  }
}
