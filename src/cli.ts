import { Database } from "bun:sqlite";
import { DreamsDB } from "./core/db";
import { SleepCycle } from "./core/sleep_cycle";
import fs from "fs";
import path from "path";
import os from "os";

// DEF-11: sem caminhos absolutos hardcoded — deriva do homedir do usuário.
const DB_PATH = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  // `consolidate` executa o ciclo completo; `light`/`rem`/`deep` permitem que o
  // wrapper bin/dreams-consolidate.sh rode as rotinas locais sempre e isole a
  // checagem de internet exclusivamente para a LLM remota do REM Sleep (DEF-07).
  if (cmd === "consolidate" || cmd === "light" || cmd === "rem" || cmd === "deep") {
    console.log(`Starting Dreams ${cmd}...`);
    const db = new DreamsDB();
    const cycle = new SleepCycle(db);
    
    try {
      if (cmd === "light") {
        await cycle.lightSleep();
      } else if (cmd === "rem") {
        await cycle.remSleep();
      } else if (cmd === "deep") {
        await cycle.deepSleep();
      } else {
        await cycle.runConsolidation();
      }
      console.log("Consolidation complete.");
    } catch (e) {
      console.error("Error during consolidation:", e);
      process.exit(1);
    } finally {
      db.close();
    }
  } else if (cmd === "backfill") {
    const limit = Number(args[1]) || 10;
    console.log(`Starting backfill (limit: ${limit})...`);
    
    // Open SQLite in readonly mode
    let sqliteDb: Database;
    try {
      sqliteDb = new Database(DB_PATH, { readonly: true });
    } catch (e) {
      console.error(`Error opening SQLite DB at ${DB_PATH}:`, e);
      process.exit(1);
    }
    
    // Ensure daily dir exists
    const dailyDir = path.join(os.homedir(), ".config/opencode/dreams/daily");
    if (!fs.existsSync(dailyDir)) {
      fs.mkdirSync(dailyDir, { recursive: true });
    }
    const dateStr = new Date().toISOString().split("T")[0];
    const logFile = path.join(dailyDir, `log_${dateStr}.jsonl`);
    
    // Read last sessions and messages from SQLite and write to daily log
    try {
      // Read events from the event table (session.compacted, session.updated, message.updated)
      const events = sqliteDb.query<
        { id: string; aggregate_id: string; type: string; data: string; created: number }
      >("SELECT id, aggregate_id, type, data, created FROM event WHERE type LIKE ? ORDER BY created DESC LIMIT ?")
        .all("%message.updated%", limit);
      
      let entries = 0;
      
      // Process events and write to daily log
      for (const ev of events) {
        let fact = "";
        let directory = "/opencode-chambers-harness";
        let scope = "collective";
        
        try {
          const data = JSON.parse(ev.data);
          
          // Extract based on event type
          if (ev.type.includes("session.updated")) {
            const info = data.info || {};
            directory = info.directory || "/opencode-chambers-harness";
            fact = `Sessão atualizada: ${info.title || info.slug || ev.aggregate_id}`;
            scope = "collective";
          } else if (ev.type.includes("message.updated")) {
            const d = data.data || {};
            fact = (d.text || "").substring(0, 200) || "Mensagem atualizada";
            scope = "collective";
          } else if (ev.type.includes("session.compacted")) {
            fact = `Sessão compactada: ${ev.aggregate_id}`;
            scope = "collective";
          } else {
            fact = ev.type || "Evento desconhecido";
            scope = "collective";
          }
        } catch (e) {
          // If data can't be parsed, use basic info
          fact = ev.type || "Evento desconhecido";
          scope = "collective";
        }
        
        const record = {
          type: "event_backfill",
          scope: scope,
          category: "learning",
          fact: fact.substring(0, 200),
          directory: directory,
          timestamp: ev.created > 0 ? new Date(ev.created).toISOString() : new Date().toISOString()
        };
        
        fs.appendFileSync(logFile, JSON.stringify(record) + "\n");
        entries++;
        
        if (entries >= limit) break;
      }
      
      // If no events found, try sessions table
      if (entries === 0) {
        console.log("No events found, trying sessions table...");
        const sessions = sqliteDb.query<
          { id: string; directory: string; title: string; time_created: number }
        >("SELECT id, directory, title, time_created FROM session ORDER BY time_created DESC LIMIT ?").all(limit);
        
        for (const s of sessions) {
          const record = {
            type: "session_backfill",
            scope: "collective",
            category: "learning",
            fact: `Sessão no diretório ${s.directory}: ${s.title || "sem título"}`,
            directory: s.directory || "/opencode-chambers-harness",
            timestamp: new Date(s.time_created).toISOString()
          };
          fs.appendFileSync(logFile, JSON.stringify(record) + "\n");
          entries++;
          if (entries >= limit) break;
        }
      }
      
      // If still no entries, try generic approach
      if (entries === 0) {
        console.log("No sessions/events found, trying generic tables...");
        const tableNames = sqliteDb.query("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
        
        for (const table of tableNames) {
          try {
            // Check if table has relevant columns
            const cols = sqliteDb.query(`PRAGMA table_info(${table})`).all().map((c: any) => c.name);
            if (cols.includes("directory") || cols.includes("scope") || cols.includes("fact")) {
              const rows = sqliteDb.query(`SELECT * FROM ${table} ORDER BY rowid DESC LIMIT ?`).all(limit);
              for (const row of rows) {
                const rowObj: any = row;
                const fact = rowObj.fact || rowObj.content || rowObj.value || JSON.stringify(rowObj).substring(0, 200);
                const scope = rowObj.scope || "collective";
                const dir = rowObj.directory || rowObj.dir || "/opencode-chambers-harness";
                const timestamp = rowObj.created_at || rowObj.time_created || new Date().toISOString();
                
                const record = {
                  type: "session_backfill",
                  scope: scope,
                  category: "learning",
                  fact: String(fact).substring(0, 200),
                  directory: dir,
                  timestamp: String(timestamp)
                };
                fs.appendFileSync(logFile, JSON.stringify(record) + "\n");
                entries++;
                if (entries >= limit) break;
              }
            }
          } catch (e) {
            // Skip tables that can't be queried
          }
          if (entries >= limit) break;
        }
      }
      
      sqliteDb.close();
      console.log(`Backfill complete. ${entries} entries written to ${logFile}`);
    } catch (e) {
      sqliteDb.close();
      console.error("Error during backfill:", e);
      process.exit(1);
    }
  } else {
    console.log("Usage: bun run src/cli.ts [consolidate|light|rem|deep|backfill --limit N]");
  }
}

main();
