-- 既存のユーザー・投稿は所有権を推測せず、NULLのまま維持する。
ALTER TABLE "User" ADD COLUMN "demoSeedKey" TEXT;
ALTER TABLE "Post" ADD COLUMN "demoSeedKey" TEXT;

CREATE UNIQUE INDEX "User_demoSeedKey_key" ON "User"("demoSeedKey");
CREATE UNIQUE INDEX "Post_demoSeedKey_key" ON "Post"("demoSeedKey");
