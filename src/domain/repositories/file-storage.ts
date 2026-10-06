/** DB と組み合わせるストレージ操作の契約。 */
export interface FileStorage {
  write(name: string, file: File): Promise<string>;
  thumbnail(name: string): Promise<string>;
  read(name: string, thumbnail: boolean): Promise<Blob>;
  remove(name: string, thumbnail: boolean): Promise<void>;
  stageDelete(name: string, thumbnail: boolean): Promise<StagedFileDeletion>;
}

/** 削除前に退避し、DB の結果に合わせて確定または復元する。 */
export interface StagedFileDeletion {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}
