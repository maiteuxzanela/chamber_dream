import { tool, type Plugin } from "@opencode-ai/plugin";
import { DreamsDB } from "./core/db";
import { dream_learn, dream_recall } from "./tools";
import fs from "fs";
import path from "path";
import os from "os";

const db = new DreamsDB();

const dailyDir = path.join(os.homedir(), ".config/opencode/dreams/daily");

// DEF-05: sem constantes estáticas `dateStr`/`logFile` — o path é derivado da
// data no momento de cada escrita, para sessões longas que atravessam a virada
// da data não congelarem o log no arquivo do dia anterior.
function getDailyLogPath(): string {
  if (!fs.existsSync(dailyDir)) {
    fs.mkdirSync(dailyDir, { recursive: true });
  }
  const dateStr = new Date().toISOString().split("T")[0];
  return path.join(dailyDir, `log_${dateStr}.jsonl`);
}

// Helper to write event log entries
function logEvent(entry: { type: string; scope?: string; fact: string; directory?: string; timestamp?: string }) {
  const record = {
    type: entry.type,
    scope: entry.scope,
    fact: entry.fact,
    directory: entry.directory,
    timestamp: entry.timestamp || new Date().toISOString()
  };
  fs.appendFileSync(getDailyLogPath(), JSON.stringify(record) + "\n");
}

export const serverPlugin: Plugin = async (input) => {
  return {
    tool: {
      dream_learn: tool({
        description: "Learn a new fact, rule, or preference. Saved to daily stream for nightly consolidation.",
        args: {
          scope: tool.schema.string().describe("'collective' or 'agent:<nome>'"),
          fact: tool.schema.string().describe("The fact to learn"),
          category: tool.schema.enum(["learning", "decision", "pitfall", "preference"]).describe("Category of memory"),
        },
        async execute(args) {
          return dream_learn(args as { scope: string; fact: string; category: "learning" | "decision" | "pitfall" | "preference" });
        },
      }),

      dream_recall: tool({
        description: "Recall memories using full-text search.",
        args: {
          query: tool.schema.string().describe("Search query"),
          scope: tool.schema.string().optional().describe("Scope filter"),
          category: tool.schema.string().optional().describe("Category filter"),
        },
        async execute(args) {
          return dream_recall(args, db);
        },
      }),
    },

    event: async ({ event }) => {
      // Ingestão passiva de eventos de sessão (apenas idle e compacted —
// session.updated e message.updated foram removidos para evitar log spam
// de centenas de eventos por minuto durante respostas do LLM).
      if (event.type === "session.idle") {
        const obs = {
          type: event.type,
          scope: "collective",
          fact: `Sessão finalizada no diretório ${input.directory}`,
          directory: input.directory,
          category: "learning",
          timestamp: new Date().toISOString()
        };
        fs.appendFileSync(getDailyLogPath(), JSON.stringify(obs) + "\n");
      } else if (event.type === "session.deleted") {
        const obs = {
          type: event.type,
          scope: "collective",
          fact: `Sessão deletada no diretório ${input.directory}`,
          directory: input.directory,
          category: "learning",
          timestamp: new Date().toISOString()
        };
        fs.appendFileSync(getDailyLogPath(), JSON.stringify(obs) + "\n");
      } else if (event.type === "session.compacted") {
        const obs = {
          type: "session.compacted",
          scope: "collective",
          fact: `Sessão compactada no diretório ${input.directory}`,
          directory: input.directory,
          category: "learning",
          timestamp: new Date().toISOString()
        };
        fs.appendFileSync(getDailyLogPath(), JSON.stringify(obs) + "\n");
      }
    },

    dispose: async () => {
      // DEF-09: libera a conexão SQLite (WAL) no unload do plugin.
      try {
        db.close();
      } catch (e) {
        console.error("[Dreams] Failed to close DB on dispose:", e);
      }
      return { status: "disposed", message: "Plugin disposed successfully" };
    }
  };
};

export const id = "opencode-plugin-dreams";

export default {
  id,
  server: serverPlugin,
};

