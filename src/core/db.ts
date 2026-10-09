import { Database } from "bun:sqlite";
import path from "path";
import os from "os";
import fs from "fs";

export interface MemoryRecord {
  id?: number;
  scope: string; // 'collective' or 'agent:<name>'
  fact: string;
  category: "learning" | "decision" | "pitfall" | "preference";
  score: number;
  decay_weight: number;
  recall_count: number;
  confirmations: number;
  last_reinforced: string;
  created_at: string;
}

export class DreamsDB {
  // DEF-10: limites de reforço — eventos triviais repetitivos (ex.: session.idle)
  // não podem inflar score/confirmations indefinidamente.
  static readonly MAX_CONFIRMATIONS = 10;
  static readonly MAX_SCORE = 5.0;

  private db: Database;

  constructor(dbPath?: string) {
    const finalPath = dbPath || path.join(os.homedir(), ".config/opencode/dreams/dreams.db");
    const dir = path.dirname(finalPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(finalPath);
    this.init();
  }

  private init() {
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        fact TEXT NOT NULL,
        category TEXT NOT NULL,
        score REAL DEFAULT 1.0,
        decay_weight REAL DEFAULT 1.0,
        recall_count INTEGER DEFAULT 0,
        confirmations INTEGER DEFAULT 1,
        last_reinforced TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        fact,
        category,
        content='memories',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, fact, category) VALUES (new.id, new.fact, new.category);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, fact, category) VALUES('delete', old.id, old.fact, old.category);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, fact, category) VALUES('delete', old.id, old.fact, old.category);
        INSERT INTO memories_fts(rowid, fact, category) VALUES (new.id, new.fact, new.category);
      END;
    `);
  }

  public insertMemory(
    scope: string,
    fact: string,
    category: "learning" | "decision" | "pitfall" | "preference",
    score: number = 1.0,
    decay_weight: number = 1.0,
    options: { reinforce?: boolean } = {}
  ): number {
    const now = new Date().toISOString();
    
    // Check if duplicate fact exists for the scope
    const existing = this.db.query<MemoryRecord, [string, string]>(
      "SELECT * FROM memories WHERE scope = ? AND fact = ?"
    ).get(scope, fact);

    if (existing && existing.id) {
      // DEF-10: reforço opcional e SEMPRE limitado. `reinforce: false`
      // (eventos triviais de ciclo de vida) mantém o registro intacto.
      if (options.reinforce === false) {
        return existing.id;
      }
      const confirmations = Math.min(existing.confirmations + 1, DreamsDB.MAX_CONFIRMATIONS);
      const nextScore = Math.min(existing.score + 0.5, DreamsDB.MAX_SCORE);
      this.db.run(
        "UPDATE memories SET score = ?, confirmations = ?, last_reinforced = ? WHERE id = ?",
        [nextScore, confirmations, now, existing.id]
      );
      return existing.id;
    }

    const query = this.db.query(
      `INSERT INTO memories (scope, fact, category, score, decay_weight, recall_count, confirmations, last_reinforced, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)`
    );
    const result = query.run(scope, fact, category, score, decay_weight, now, now);
    return Number(result.lastInsertRowid);
  }

  public recall(queryText: string, scope?: string, category?: string, limit: number = 5): MemoryRecord[] {
    let sql = `
      SELECT m.* FROM memories m
      JOIN memories_fts f ON m.id = f.rowid
      WHERE memories_fts MATCH ?
    `;
    const params: any[] = [queryText];

    if (scope) {
      sql += " AND m.scope = ?";
      params.push(scope);
    }
    if (category) {
      sql += " AND m.category = ?";
      params.push(category);
    }

    sql += " ORDER BY rank, m.score DESC LIMIT ?";
    params.push(limit);

    try {
      const records = this.db.query<MemoryRecord, any[]>(sql).all(...params);
      
      // Increment recall_count and update last_reinforced
      const now = new Date().toISOString();
      for (const rec of records) {
        if (rec.id) {
          this.db.run(
            "UPDATE memories SET recall_count = recall_count + 1, last_reinforced = ? WHERE id = ?",
            [now, rec.id]
          );
        }
      }
      return records;
    } catch (e) {
      // Fallback to simple like query if FTS query syntax is invalid
      let fallbackSql = "SELECT * FROM memories WHERE fact LIKE ?";
      const fallbackParams: any[] = [`%${queryText}%`];
      if (scope) {
        fallbackSql += " AND scope = ?";
        fallbackParams.push(scope);
      }
      if (category) {
        fallbackSql += " AND category = ?";
        fallbackParams.push(category);
      }
      fallbackSql += " ORDER BY score DESC LIMIT ?";
      fallbackParams.push(limit);
      return this.db.query<MemoryRecord, any[]>(fallbackSql).all(...fallbackParams);
    }
  }

  public getMemoriesByScope(scope: string, limit: number = 5): MemoryRecord[] {
    return this.db.query<MemoryRecord, [string, number]>(
      "SELECT * FROM memories WHERE scope = ? ORDER BY score DESC, last_reinforced DESC LIMIT ?"
    ).all(scope, limit);
  }

  public getAllMemories(): MemoryRecord[] {
    return this.db.query<MemoryRecord, []>("SELECT * FROM memories").all();
  }

  public updateMemoryScore(id: number, score: number) {
    this.db.run("UPDATE memories SET score = ? WHERE id = ?", [score, id]);
  }

  public deleteMemory(id: number) {
    this.db.run("DELETE FROM memories WHERE id = ?", [id]);
  }

  public close() {
    this.db.close();
  }
}
