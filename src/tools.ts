import { DreamsDB } from "./core/db";
import fs from "fs";
import path from "path";
import os from "os";

const DREAMS_DIR = path.join(os.homedir(), ".config/opencode/dreams");
const DAILY_DIR = path.join(DREAMS_DIR, "daily");

// DEF-03: escopo válido é 'collective' ou 'agent:<nome>' com nome seguro.
// Bloqueia Directory Traversal e escopos malformados.
const SCOPE_PATTERN = /^(collective|agent:[a-zA-Z0-9_-]+)$/;

/**
 * We don't interact with the DB directly in `dream_learn` during the active session 
 * to avoid blocking locks. Instead, we write to a daily JSONL for the Light Sleep ingestion.
 * But actually, using SQLite WAL mode is very fast and concurrent. 
 * The prompt said: "Light Sleep: Ingestão de logs/fatos diários brutos (dreams/daily/*.jsonl)"
 * So dream_learn SHOULD append to JSONL.
 *
 * O diretório é criado de forma lazy (sem efeito colateral na importação) e pode ser
 * injetado via `options.dailyDir` para testes isolados em /tmp.
 */
export function dream_learn(
  args: { scope: string, fact: string, category: "learning" | "decision" | "pitfall" | "preference" },
  options: { dailyDir?: string } = {}
) {
  if (!SCOPE_PATTERN.test(args.scope)) {
    throw new Error(
      `Invalid scope '${args.scope}'. Expected 'collective' or 'agent:<nome>' (allowed chars: [a-zA-Z0-9_-]).`
    );
  }

  const dailyDir = options.dailyDir ?? DAILY_DIR;
  if (!fs.existsSync(dailyDir)) {
    fs.mkdirSync(dailyDir, { recursive: true });
  }

  const dateStr = new Date().toISOString().split("T")[0];
  const file = path.join(dailyDir, `log_${dateStr}.jsonl`);
  
  const record = {
    scope: args.scope,
    fact: args.fact,
    category: args.category,
    timestamp: new Date().toISOString()
  };

  fs.appendFileSync(file, JSON.stringify(record) + "\n");
  return `Memory logged to daily stream for scope '${args.scope}'. Will be consolidated tonight.`;
}

/**
 * `dream_recall` queries the SQLite FTS5 database immediately.
 */
export function dream_recall(args: { query: string, scope?: string, category?: string }, db: DreamsDB) {
  const results = db.recall(args.query, args.scope, args.category, 5);
  if (results.length === 0) return "No relevant memories found.";
  
  return results.map(r => `[Score: ${r.score.toFixed(2)}] [${r.scope}] ${r.fact}`).join("\n");
}
