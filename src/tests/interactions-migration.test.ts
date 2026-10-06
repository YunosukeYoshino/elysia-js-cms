import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const initialSql: string = readFileSync(
  new URL('../../prisma/migrations/20250313140408_init/migration.sql', import.meta.url),
  'utf8',
);
const interactionSql: string = readFileSync(
  new URL(
    '../../prisma/migrations/20261006183000_comments_interactions/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

function fixture(): Database {
  const db: Database = new Database(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(initialSql);
  db.exec(interactionSql);
  db.exec(`INSERT INTO User (id,email,password,updatedAt) VALUES (1,'a@example.com','fixture',CURRENT_TIMESTAMP),(2,'b@example.com','fixture',CURRENT_TIMESTAMP);
    INSERT INTO Post (id,title,content,published,authorId,updatedAt) VALUES (1,'one','text',1,1,CURRENT_TIMESTAMP),(2,'two','text',1,1,CURRENT_TIMESTAMP);
    INSERT INTO Comment (id,content,authorId,postId,updatedAt) VALUES (1,'root',1,1,CURRENT_TIMESTAMP);`);
  return db;
}

describe('interaction migration database invariants', () => {
  it('applies additively without changing existing rows', () => {
    const db = fixture();
    try {
      expect(db.query('SELECT title FROM Post ORDER BY id').all()).toEqual([
        { title: 'one' },
        { title: 'two' },
      ]);
      expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(
        db
          .query(
            "SELECT count(*) AS count FROM sqlite_master WHERE type='index' AND name LIKE 'Reaction_%'",
          )
          .get(),
      ).toEqual({ count: 4 });
    } finally {
      db.close();
    }
  });

  it('requires exactly one reaction target and enforces uniqueness with nullable targets', () => {
    const db = fixture();
    try {
      expect(() => db.exec("INSERT INTO Reaction(type,userId) VALUES ('like',1)")).toThrow();
      expect(() =>
        db.exec("INSERT INTO Reaction(type,userId,postId,commentId) VALUES ('like',1,1,1)"),
      ).toThrow();
      expect(() =>
        db.exec("INSERT INTO Reaction(type,userId,postId) VALUES ('invalid',1,1)"),
      ).toThrow();
      db.exec("INSERT INTO Reaction(type,userId,postId) VALUES ('like',1,1)");
      expect(() =>
        db.exec("INSERT INTO Reaction(type,userId,postId) VALUES ('like',1,1)"),
      ).toThrow();
      db.exec("INSERT INTO Reaction(type,userId,commentId) VALUES ('like',1,1)");
      expect(() =>
        db.exec("INSERT INTO Reaction(type,userId,commentId) VALUES ('like',1,1)"),
      ).toThrow();
      expect(db.query('SELECT count(*) AS count FROM Reaction').get()).toEqual({ count: 2 });
    } finally {
      db.close();
    }
  });

  it('rejects self-follow and duplicate bookmark/view/follow records', () => {
    const db = fixture();
    try {
      expect(() => db.exec('INSERT INTO Follow(followerId,followingId) VALUES (1,1)')).toThrow();
      for (const sql of [
        'INSERT INTO Follow(followerId,followingId) VALUES (1,2)',
        'INSERT INTO Bookmark(userId,postId) VALUES (1,1)',
        "INSERT INTO PostView(userId,postId,day) VALUES (1,1,'2026-10-06')",
      ]) {
        db.exec(sql);
        expect(() => db.exec(sql)).toThrow();
      }
    } finally {
      db.close();
    }
  });

  it('enforces bounded immutable comment ancestry and moderation states', () => {
    const db = fixture();
    try {
      for (const values of [
        "'child',1,2,1,1", // 別の投稿
        "'child',1,1,1,2", // 階層不一致
        "'child',1,1,NULL,1", // ルート不一致
        "'child',1,1,1,6", // 深すぎる返信
      ])
        expect(() =>
          db.exec(
            `INSERT INTO Comment(content,authorId,postId,parentId,depth,updatedAt) VALUES (${values},CURRENT_TIMESTAMP)`,
          ),
        ).toThrow();
      db.exec(
        "INSERT INTO Comment(id,content,authorId,postId,parentId,depth,updatedAt) VALUES (2,'reply',2,1,1,1,CURRENT_TIMESTAMP)",
      );
      expect(() => db.exec('UPDATE Comment SET parentId=2,depth=2 WHERE id=1')).toThrow();
      expect(() => db.exec("UPDATE Comment SET status='invalid' WHERE id=1")).toThrow();
      expect(() => db.exec("UPDATE Comment SET content='   ' WHERE id=1")).toThrow();
      db.exec("UPDATE Comment SET content='',deletedAt=CURRENT_TIMESTAMP WHERE id=1");
      expect(db.query('SELECT content FROM Comment WHERE id=2').get()).toEqual({
        content: 'reply',
      });
    } finally {
      db.close();
    }
  });

  it('cascades post deletion through interactions and leaves no foreign-key violations', () => {
    const db = fixture();
    try {
      db.exec(`INSERT INTO Reaction(type,userId,commentId) VALUES ('like',2,1);
        INSERT INTO Bookmark(userId,postId) VALUES (2,1);
        INSERT INTO PostView(userId,postId,day) VALUES (2,1,'2026-10-06');
        INSERT INTO Notification(eventKey,type,content,recipientId,senderId,postId,commentId) VALUES ('test','comment','new',1,2,1,1);
        DELETE FROM Post WHERE id=1;`);
      for (const table of ['Comment', 'Reaction', 'Bookmark', 'PostView', 'Notification']) {
        expect(db.query(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
      expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
