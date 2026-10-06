-- 公開キャッシュのDB版を、元の変更と同じトランザクションで更新する。
CREATE TABLE "CacheRevision" ("id" TEXT NOT NULL PRIMARY KEY, "version" BIGINT NOT NULL DEFAULT 0);
INSERT INTO "CacheRevision" ("id", "version") VALUES ('content', 0);
CREATE TRIGGER "cache_content_Post_insert" AFTER INSERT ON "Post" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_Post_update" AFTER UPDATE ON "Post" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_Post_delete" AFTER DELETE ON "Post" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_Category_insert" AFTER INSERT ON "Category" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_Category_update" AFTER UPDATE ON "Category" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_Category_delete" AFTER DELETE ON "Category" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_CategoryOnPost_insert" AFTER INSERT ON "CategoryOnPost" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_CategoryOnPost_update" AFTER UPDATE ON "CategoryOnPost" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_CategoryOnPost_delete" AFTER DELETE ON "CategoryOnPost" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_Tag_insert" AFTER INSERT ON "Tag" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_Tag_update" AFTER UPDATE ON "Tag" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_Tag_delete" AFTER DELETE ON "Tag" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_TagOnPost_insert" AFTER INSERT ON "TagOnPost" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_TagOnPost_update" AFTER UPDATE ON "TagOnPost" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_TagOnPost_delete" AFTER DELETE ON "TagOnPost" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_Comment_insert" AFTER INSERT ON "Comment" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_Comment_update" AFTER UPDATE ON "Comment" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_Comment_delete" AFTER DELETE ON "Comment" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_Reaction_insert" AFTER INSERT ON "Reaction" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_Reaction_update" AFTER UPDATE ON "Reaction" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_Reaction_delete" AFTER DELETE ON "Reaction" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_Bookmark_insert" AFTER INSERT ON "Bookmark" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_Bookmark_update" AFTER UPDATE ON "Bookmark" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_Bookmark_delete" AFTER DELETE ON "Bookmark" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_Follow_insert" AFTER INSERT ON "Follow" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_Follow_update" AFTER UPDATE ON "Follow" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_Follow_delete" AFTER DELETE ON "Follow" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_PostView_insert" AFTER INSERT ON "PostView" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_PostView_update" AFTER UPDATE ON "PostView" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_PostView_delete" AFTER DELETE ON "PostView" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_Notification_insert" AFTER INSERT ON "Notification" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_Notification_update" AFTER UPDATE ON "Notification" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_Notification_delete" AFTER DELETE ON "Notification" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_User_insert" AFTER INSERT ON "User" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_User_update" AFTER UPDATE OF name, email, role ON "User" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
CREATE TRIGGER "cache_content_User_delete" AFTER DELETE ON "User" BEGIN
  UPDATE "CacheRevision" SET "version" = "version" + 1 WHERE "id" = 'content';
END;
