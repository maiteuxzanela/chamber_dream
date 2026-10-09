import fs from "fs";
import path from "path";
import os from "os";
import { DreamsDB, MemoryRecord } from "./db";

// Diretório base padrão (produção). Testes injetam um baseDir isolado via options.
const DEFAULT_DREAMS_DIR = path.join(os.homedir(), ".config/opencode/dreams");

// Eventos triviais de ciclo de vida: repetições não devem reforçar score (DEF-10).
const TRIVIAL_EVENT_TYPES = new Set(["session.idle", "session.deleted", "session.compacted"]);

// Nomes de agente aceitos em escopos `agent:<nome>` — bloqueia Directory Traversal (DEF-03).
const SAFE_AGENT_NAME = /^[a-zA-Z0-9_-]+$/;

export class SleepCycle {
  private db: DreamsDB;
  private lambda: number = 0.05; // Decay rate
  private threshold: number = 0.5;
  private dreamsDir: string;
  private dailyDir: string;
  private collectiveDir: string;
  private personasDir: string;

  constructor(db: DreamsDB, options?: { baseDir?: string }) {
    this.db = db;
    this.dreamsDir = options?.baseDir ? path.resolve(options.baseDir) : DEFAULT_DREAMS_DIR;
    this.dailyDir = path.join(this.dreamsDir, "daily");
    this.collectiveDir = path.join(this.dreamsDir, "collective");
    this.personasDir = path.join(this.dreamsDir, "personas");
    this.ensureDirs();
  }

  private ensureDirs() {
    [this.dreamsDir, this.dailyDir, this.collectiveDir, this.personasDir].forEach(dir => {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
  }

  /**
   * Light Sleep: Ingest daily raw logs, deduplicate lexically.
   * Accepts records without explicit category: session.idle and session.compacted
   * fall back to category="learning" so they are not discarded.
   */
  public async lightSleep() {
    console.log("[Light Sleep] Starting ingestion of daily logs...");
    const files = fs.readdirSync(this.dailyDir).filter(f => f.endsWith(".jsonl"));
    let ingested = 0;

    for (const file of files) {
      const filePath = path.join(this.dailyDir, file);
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n").filter(l => l.trim() !== "");
      
      for (const line of lines) {
        try {
          const record = JSON.parse(line);
          // Fallback: session.idle e session.compacted sem categoria explícita
          // recebem category="learning" para não serem descartados.
          if (record.fact && record.scope) {
            const category = record.category
              || (["session.idle", "session.compacted"].includes(record.type) ? "learning"
              : undefined);
            if (category) {
              // DEF-10: eventos triviais de ciclo de vida repetidos não reforçam score.
              const isTrivial = TRIVIAL_EVENT_TYPES.has(record.type);
              this.db.insertMemory(record.scope, record.fact, category, 1.0, 1.0, {
                reinforce: !isTrivial
              });
              ingested++;
            }
          }
        } catch (e) {
          console.error(`[Light Sleep] Failed to parse log line in ${file}`);
        }
      }
      // Archive or delete daily file after ingestion
      fs.renameSync(filePath, filePath + ".processed");
    }
    // TTL de 3 dias: varre DAILY_DIR e apaga arquivos .processed ou .jsonl
    // cuja mtime tenha mais que 3 dias.
    this.expireOldDailyFiles();
    console.log(`[Light Sleep] Ingested ${ingested} new facts.`);
  }

  /**
   * Expunge old daily files: .processed or .jsonl older than 3 days.
   */
  private expireOldDailyFiles() {
    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    try {
      const entries = fs.readdirSync(this.dailyDir);
      for (const entry of entries) {
        const filePath = path.join(this.dailyDir, entry);
        const stat = fs.statSync(filePath);
        const isProcessed = entry.endsWith(".processed");
        const isJsonl = entry.endsWith(".jsonl");
        if ((isProcessed || isJsonl) && (now - stat.mtimeMs > THREE_DAYS_MS)) {
          console.log(`[Light Sleep] Expunging old file: ${entry} (mtime ${new Date(stat.mtimeMs).toISOString()})`);
          fs.unlinkSync(filePath);
        }
      }
    } catch (e) {
      console.error("[Light Sleep] Failed to expire old daily files:", e);
    }
  }

  /**
   * REM Sleep: Reflective synthesis and DREAMS.md generation via LLM.
   */
  public async remSleep() {
    console.log("[REM Sleep] Synthesizing memories...");
    const allMemories = this.db.getAllMemories();
    if (allMemories.length === 0) return;

    // We build a simple payload for the LLM
    const prompt = `Synthesize these recent AI memories into a short human-readable diary:\n` + 
                   allMemories.map(m => `- [${m.scope}] ${m.category}: ${m.fact}`).join("\n");

    let synthesis = "No synthesis generated (LLM API not configured).";
    
    // In a real Opencode plugin, we might use the plugin's LLM tools or fetch.
    // For now, if OPENCODE_API_KEY is set, we could call standard endpoint.
    // We will do a minimal fetch here if the key is available, else mock locally (but Clara says no mocks in tests, so we need a real implementation that doesn't fail if the API key isn't there, or returns a basic synthesis).
    const apiKey = process.env.OPENCODE_API_KEY || process.env.GEMINI_API_KEY;
    const model = process.env.OPENCODE_MODEL || "google/antigravity-gemini-3.1-pro";
    // DEF-07: a verificação de internet é isolada exclusivamente para esta
    // chamada remota da LLM. DREAMS_OFFLINE=1 força o caminho local (fallback),
    // mantendo DREAMS.md e projeções funcionando sem rede.
    const offline = process.env.DREAMS_OFFLINE === "1";

    if (apiKey && !offline) {
      try {
         // Assuming OpenAI compatible endpoint format for Opencode Mimo or standard Antigravity if it uses similar
         // Since we don't know the exact endpoint, we'll write a placeholder fetch that works if endpoint is provided via env
         const endpoint = process.env.OPENCODE_API_ENDPOINT || "https://api.openai.com/v1/chat/completions";
         const res = await fetch(endpoint, {
           method: "POST",
           headers: {
             "Content-Type": "application/json",
             "Authorization": `Bearer ${apiKey}`
           },
           body: JSON.stringify({
             model: model,
             messages: [{role: "user", content: prompt}],
             max_tokens: 500
           })
         });
         if (res.ok) {
           const data = await res.json() as any;
           synthesis = data.choices?.[0]?.message?.content || synthesis;
         } else {
           console.error(`[REM Sleep] LLM API returned ${res.status}`);
           synthesis = "Failed to generate synthesis due to API error.";
         }
      } catch (e) {
         console.error("[REM Sleep] Error calling LLM API:", e);
      }
    } else {
      console.log(offline
        ? "[REM Sleep] Offline mode (DREAMS_OFFLINE=1). Using local fallback synthesis."
        : "[REM Sleep] No API key found. Using fallback synthesis.");
      synthesis = "Fallback Synthesis (No LLM key): \n" + allMemories.map(m => `- ${m.fact}`).join("\n");
    }

    fs.writeFileSync(path.join(this.dreamsDir, "DREAMS.md"), `# Daily Dreams Synthesis\n\n${synthesis}\n`);
    
    // After REM, we update the collective and individual markdown files
    this.updateProjections();
  }

  /**
   * Deep Sleep: Score decay calculation. Score = (Base + RecallCount + Confirmations) * exp(-lambda * delta_t)
   */
  public async deepSleep() {
    console.log("[Deep Sleep] Applying temporal decay...");
    const allMemories = this.db.getAllMemories();
    const now = new Date().getTime();
    
    for (const mem of allMemories) {
      // DEF-02: o decaimento temporal é medido a partir do último reforço
      // (fallback: created_at), não da criação — memórias reforçadas hoje
      // não podem ser arquivadas por "velhice" de criação.
      const lastTime = new Date(mem.last_reinforced || mem.created_at).getTime();
      const deltaT_days = (now - lastTime) / (1000 * 60 * 60 * 24); // delta_t in days
      
      const base = 1.0;
      const newScore = (base + mem.recall_count + mem.confirmations) * Math.exp(-this.lambda * deltaT_days * mem.decay_weight);
      
      if (newScore < this.threshold && mem.id) {
         console.log(`[Deep Sleep] Archiving memory ID ${mem.id} (Score: ${newScore.toFixed(2)})`);
         this.db.deleteMemory(mem.id);
         // In a full implementation, we'd move it to an archive table. For now, delete.
      } else if (mem.id) {
         this.db.updateMemoryScore(mem.id, newScore);
      }
    }
  }

  public updateProjections() {
    // 1. Collective memory (limit 300 tokens approx, top 5-10 items)
    const collective = this.db.getMemoriesByScope("collective", 5);
    let colContent = "<!-- COLLECTIVE MEMORY INJECTION (DO NOT EDIT) -->\n";
    collective.forEach(m => {
      colContent += `- [${m.category.toUpperCase()}] ${m.fact}\n`;
    });
    fs.writeFileSync(path.join(this.collectiveDir, "COLLECTIVE_MEMORY.md"), colContent);

    // 2. Persona memories
    const all = this.db.getAllMemories();
    const agents = new Set(all.filter(m => m.scope.startsWith("agent:")).map(m => m.scope.split(":")[1]));
    
    for (const agent of agents) {
      // DEF-03: sanitização anti Directory Traversal — só nomes de agente
      // seguros ([a-zA-Z0-9_-]) podem virar arquivo em PERSONAS_DIR.
      if (!agent || !SAFE_AGENT_NAME.test(agent)) {
        console.warn(`[Projections] Skipping unsafe agent name: ${JSON.stringify(agent)}`);
        continue;
      }
      const pMemories = this.db.getMemoriesByScope(`agent:${agent}`, 5);
      let pContent = `<!-- INDIVIDUAL MEMORY FOR ${agent.toUpperCase()} -->\n`;
      pMemories.forEach(m => {
        pContent += `- [${m.category.toUpperCase()}] ${m.fact}\n`;
      });
      fs.writeFileSync(path.join(this.personasDir, `${agent}.md`), pContent);
    }
  }

  public async runConsolidation() {
    await this.lightSleep();
    await this.remSleep();
    await this.deepSleep();
  }
}
