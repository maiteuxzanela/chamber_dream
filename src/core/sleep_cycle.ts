import fs from "fs";
import path from "path";
import os from "os";
import { DreamsDB, MemoryRecord } from "./db";
import { readRecentDialogueSummary } from "./session_reader";
import {
  synthesizeMemories,
  type SynthesisSource,
  type SynthesizedMemory,
} from "./mimo_synthesizer";

// Diretório base padrão (produção). Testes injetam um baseDir isolado via options.
const DEFAULT_DREAMS_DIR = path.join(os.homedir(), ".config/opencode/dreams");

// Eventos triviais de ciclo de vida: repetições não devem reforçar score (DEF-10).
const TRIVIAL_EVENT_TYPES = new Set(["session.idle", "session.deleted", "session.compacted"]);

// Nomes de agente aceitos em escopos `agent:<nome>` — bloqueia Directory Traversal (DEF-03).
const SAFE_AGENT_NAME = /^[a-zA-Z0-9_-]+$/;

/** Opções do ciclo de sono (todas opcionais; padrão = produção). */
export interface SleepCycleOptions {
  /** Diretório base isolado para testes (dreams dir). */
  baseDir?: string;
  /** Caminho do SQLite de sessões lido pelo Light Sleep.
   *  Padrão: `~/.local/share/opencode/opencode.db`. */
  sessionDbPath?: string;
  /** Captura o diálogo recente no lightSleep. Padrão: true. */
  captureDialogue?: boolean;
  /** Janela de horas retroativas do diálogo. Padrão: 24. */
  dialogueHours?: number;
}

export class SleepCycle {
  private db: DreamsDB;
  private lambda: number = 0.05; // Decay rate
  private threshold: number = 0.5;
  private dreamsDir: string;
  private dailyDir: string;
  private collectiveDir: string;
  private personasDir: string;
  /** Arquivo de handoff Light -> REM com o resumo do diálogo recente. */
  private dialogueFile: string;
  private sessionDbPath: string | undefined;
  private captureDialogue: boolean;
  private dialogueHours: number;

  constructor(db: DreamsDB, options?: SleepCycleOptions) {
    this.db = db;
    this.dreamsDir = options?.baseDir ? path.resolve(options.baseDir) : DEFAULT_DREAMS_DIR;
    this.dailyDir = path.join(this.dreamsDir, "daily");
    this.collectiveDir = path.join(this.dreamsDir, "collective");
    this.personasDir = path.join(this.dreamsDir, "personas");
    this.dialogueFile = path.join(this.dreamsDir, "dialogue_pending.txt");
    this.sessionDbPath = options?.sessionDbPath;
    this.captureDialogue = options?.captureDialogue ?? true;
    this.dialogueHours = options?.dialogueHours ?? 24;
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

    // Captura do diálogo real das últimas 24h no opencode.db (somente texto,
    // sem raciocínio) para a destilação cognitiva do REM Sleep. Fail-soft:
    // banco ausente/corrompido -> resumo vazio, o ciclo local não quebra.
    this.captureRecentDialogue();

    console.log(`[Light Sleep] Ingested ${ingested} new facts.`);
  }

  /**
   * Lê o diálogo recente (`session_reader`) e o persiste em
   * `dialogue_pending.txt` como handoff para o REM Sleep — necessário porque
   * o wrapper `bin/dreams-consolidate.sh` roda light/rem em processos separados.
   */
  private captureRecentDialogue() {
    if (!this.captureDialogue) return;
    try {
      const summary = readRecentDialogueSummary({
        dbPath: this.sessionDbPath,
        hours: this.dialogueHours,
        includeReasoning: false, // reasoning domina o volume e infla token
        onError: (error) => console.error("[Light Sleep] session_reader:", error),
      });
      if (summary.trim() === "") {
        console.log("[Light Sleep] Nenhum diálogo recente capturado.");
        return;
      }
      fs.writeFileSync(this.dialogueFile, summary);
      console.log(
        `[Light Sleep] Diálogo recente capturado (${summary.length} chars) para o REM Sleep.`
      );
    } catch (error) {
      // Fail-soft: a captura de diálogo nunca derruba a ingestão de logs.
      console.error("[Light Sleep] Falha ao capturar diálogo recente:", error);
    }
  }

  /**
   * Consome o handoff do Light Sleep; se inexistente (REM isolado), lê o
   * opencode.db diretamente. Devolve `""` quando não há diálogo.
   */
  private loadPendingDialogue(): string {
    try {
      if (fs.existsSync(this.dialogueFile)) {
        const content = fs.readFileSync(this.dialogueFile, "utf-8");
        if (content.trim() !== "") return content;
      }
    } catch (error) {
      console.error("[REM Sleep] Falha ao ler dialogue_pending.txt:", error);
    }
    if (!this.captureDialogue) return "";
    try {
      return readRecentDialogueSummary({
        dbPath: this.sessionDbPath,
        hours: this.dialogueHours,
        includeReasoning: false,
        onError: (error) => console.error("[REM Sleep] session_reader:", error),
      });
    } catch (error) {
      console.error("[REM Sleep] Falha ao ler diálogo direto:", error);
      return "";
    }
  }

  /** Remove o handoff após o consumo (evita re-sintetizar a mesma janela). */
  private clearPendingDialogue() {
    try {
      if (fs.existsSync(this.dialogueFile)) fs.unlinkSync(this.dialogueFile);
    } catch (error) {
      console.error("[REM Sleep] Falha ao limpar dialogue_pending.txt:", error);
    }
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
   * REM Sleep: síntese cognitiva via cascata de IA (`opencode run --pure`),
   * inserção das memórias destiladas no DreamsDB e geração do DREAMS.md.
   *
   * Fluxo:
   *  1. consome o diálogo do Light Sleep (`dialogue_pending.txt`);
   *  2. `synthesizeMemories(dialogue)` → array validado de memórias;
   *  3. `db.insertMemory(scope, fact, category)` para cada memória;
   *  4. escreve DREAMS.md e atualiza as projeções (COLLECTIVE/personas);
   *  5. limpa o handoff apenas se a síntese tiver sucesso.
   *
   * Resiliência e anti-mock: sem IA disponível, o ciclo preserva
   * `dialogue_pending.txt` intacto para o próximo ciclo tentar novamente,
   * sem gravar memórias falsas ou dados inventados.
   */
  public async remSleep() {
    console.log("[REM Sleep] Synthesizing memories...");

    const dialogue = this.loadPendingDialogue();
    let newMemories: SynthesizedMemory[] = [];
    let source: SynthesisSource = "none";
    let synthError: string | null = null;
    let synthesisSucceeded = false;

    if (dialogue.trim() !== "") {
      try {
        const result = await synthesizeMemories(dialogue, {
          onError: (error) => console.error("[REM Sleep] MimoSynthesizer:", error),
        });
        source = result.source;
        synthError = result.error;
        for (const mem of result.memories) {
          this.db.insertMemory(mem.scope, mem.fact, mem.category);
          newMemories.push(mem);
        }
        synthesisSucceeded = true;
        console.log(
          `[REM Sleep] Síntese ${source}: ${newMemories.length} memória(s) inserida(s)` +
            `${result.dropped > 0 ? `, ${result.dropped} descartada(s)` : ""}` +
            `${result.error ? ` — ${result.error}` : ""}.`
        );
      } catch (error) {
        // Síntese adiada por indisponibilidade de IA: preserva dialogue_pending.txt e não grava dados falsos
        synthError = error instanceof Error ? error.message : String(error);
        console.warn(`[REM Sleep] Síntese cognitiva adiada por indisponibilidade de modelo: ${synthError}`);
      }
    } else {
      console.log("[REM Sleep] Sem diálogo recente; usando memórias existentes.");
      synthesisSucceeded = true;
    }

    const allMemories = this.db.getAllMemories();
    if (allMemories.length === 0 && newMemories.length === 0 && !synthError) {
      if (synthesisSucceeded) {
        this.clearPendingDialogue();
      }
      console.log("[REM Sleep] Nenhuma memória para sintetizar.");
      return;
    }

    fs.writeFileSync(
      path.join(this.dreamsDir, "DREAMS.md"),
      this.renderDreamsMarkdown({ source, synthError, newMemories, allMemories })
    );

    // After REM, we update the collective and individual markdown files
    this.updateProjections();

    // Limpa o handoff SOMENTE se a síntese foi bem-sucedida
    if (synthesisSucceeded) {
      this.clearPendingDialogue();
    }
  }

  /** Renderiza o DREAMS.md de forma determinística a partir do resultado. */
  private renderDreamsMarkdown(input: {
    source: SynthesisSource;
    synthError: string | null;
    newMemories: SynthesizedMemory[];
    allMemories: MemoryRecord[];
  }): string {
    const lines: string[] = ["# Daily Dreams Synthesis", ""];
    const statusText = input.synthError
      ? `**adiada** (${input.synthError})`
      : `**${input.source}**`;
    lines.push(
      `> Gerado em ${new Date().toISOString()} — status da síntese: ${statusText}`
    );
    lines.push(
      `> Memórias novas nesta síntese: ${input.newMemories.length} | total no banco: ${input.allMemories.length}`
    );
    lines.push("");

    if (input.newMemories.length > 0) {
      lines.push("## Memórias destiladas nesta síntese", "");
      for (const mem of input.newMemories) {
        lines.push(`- [${mem.category.toUpperCase()}] (${mem.scope}) ${mem.fact}`);
      }
      lines.push("");
    }

    const digest = [...input.allMemories]
      .sort((a, b) => b.score - a.score)
      .slice(0, 15);
    if (digest.length > 0) {
      lines.push("## Top memórias por score", "");
      for (const mem of digest) {
        lines.push(`- [${mem.category.toUpperCase()}] (${mem.scope}) ${mem.fact}`);
      }
      lines.push("");
    }

    return lines.join("\n");
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
    // 1. Collective memory (top 20 items mais relevantes por score)
    const collective = this.db.getMemoriesByScope("collective", 20);
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
      const pMemories = this.db.getMemoriesByScope(`agent:${agent}`, 20);
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
