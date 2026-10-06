-- 既存の投稿・公開フラグを保ち、予約日時とタグを追加する。
ALTER TABLE "Post" ADD COLUMN "scheduledAt" DATETIME;
CREATE TABLE "Tag" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "name" TEXT NOT NULL
);
CREATE TABLE "TagOnPost" (
  "postId" INTEGER NOT NULL,
  "tagId" INTEGER NOT NULL,
  PRIMARY KEY ("postId", "tagId"),
  CONSTRAINT "TagOnPost_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TagOnPost_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Tag_name_key" ON "Tag"("name");
CREATE INDEX "TagOnPost_tagId_postId_idx" ON "TagOnPost"("tagId", "postId");
CREATE INDEX "CategoryOnPost_categoryId_postId_idx" ON "CategoryOnPost"("categoryId", "postId");
CREATE INDEX "Post_published_createdAt_id_idx" ON "Post"("published", "createdAt", "id");
CREATE INDEX "Post_scheduledAt_idx" ON "Post"("scheduledAt");
CREATE INDEX "Post_authorId_createdAt_id_idx" ON "Post"("authorId", "createdAt", "id");
