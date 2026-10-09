import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { DreamsDB } from "../src/core/db";
import { SleepCycle } from "../src/core/sleep_cycle";
import { dream_learn } from "../src/tools";
import fs from "fs";
import path from "path";

// DEF-01: diretório base 100% isolado em /tmp — os testes NUNCA tocam em
// ~/.config/opencode/dreams (memória/DB de produção).
const TEST_BASE_DIR = path.join("/tmp", `opencode_dreams_test_${Date.now()}`);
const DB_PATH = path.join(TEST_BASE_DIR, "test_dreams.db");
const DAILY_DIR = path.join(TEST_BASE_DIR, "daily");
const COLLECTIVE_DIR = path.join(TEST_BASE_DIR, "collective");
const PERSONAS_DIR = path.join(TEST_BASE_DIR, "personas");

describe("OpenCode Dreams Plugin", () => {
  let db: DreamsDB;
  let cycle: SleepCycle;

  beforeAll(() => {
    fs.mkdirSync(TEST_BASE_DIR, { recursive: true });
    db = new DreamsDB(DB_PATH);
    cycle = new SleepCycle(db, { baseDir: TEST_BASE_DIR });
  });

  afterAll(() => {
    db.close();
    fs.rmSync(TEST_BASE_DIR, { recursive: true, force: true });
  });

  test("Should insert memories and use SQLite FTS5 for search", () => {
    db.insertMemory("collective", "Maiteux gosta de usar o Laya RLCD para inferência local estruturada", "learning");
    db.insertMemory("agent:cris", "Cris deve focar em telas web responsivas", "preference");
    
    // Lexical search
    const results = db.recall("Laya RLCD");
    expect(results.length).toBe(1);
    expect(results[0].fact).toContain("Maiteux gosta de usar o Laya RLCD");
    
    const resultsCris = db.recall("telas", "agent:cris");
    expect(resultsCris.length).toBe(1);
    expect(resultsCris[0].fact).toContain("telas web");
  });

  test("DEF-02: Temporal decay should reduce score and archive old memories", async () => {
    // Insert an old memory explicitly
    db.insertMemory("collective", "Fato antigo que será esquecido", "learning");
    const all = db.getAllMemories();
    const oldMemory = all.find(m => m.fact === "Fato antigo que será esquecido");
    
    // Force last_reinforced (e created_at) para 30 dias atrás: deepSleep mede o
    // delta_t a partir de last_reinforced com fallback em created_at.
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 30);
    (db as any).db.run(
      "UPDATE memories SET created_at = ?, last_reinforced = ? WHERE id = ?",
      [oldDate.toISOString(), oldDate.toISOString(), oldMemory?.id]
    );
    
    await cycle.deepSleep(); // Apply decay
    
    const remaining = db.getAllMemories();
    const stillExists = remaining.some(m => m.fact === "Fato antigo que será esquecido");
    expect(stillExists).toBe(false); // Below threshold and deleted

    // Garantia matemática: memória reforçada hoje (delta_t ~ 0) NÃO é arquivada
    // apenas por ser "antiga" em created_at.
    db.insertMemory("collective", "Fato reforçado hoje não pode ser arquivado", "learning");
    const fresh = db.getAllMemories().find(m => m.fact === "Fato reforçado hoje não pode ser arquivado");
    (db as any).db.run(
      "UPDATE memories SET created_at = ?, last_reinforced = ? WHERE id = ?",
      [oldDate.toISOString(), new Date().toISOString(), fresh?.id]
    );
    await cycle.deepSleep();
    const survived = db.getAllMemories().some(m => m.fact === "Fato reforçado hoje não pode ser arquivado");
    expect(survived).toBe(true);
  });

  test("Memory isolation for personas", async () => {
    db.insertMemory("agent:kael", "Kael prefere não usar Ollama localmente se puder evitar", "preference");
    cycle.updateProjections();

    const collectiveContent = fs.readFileSync(path.join(COLLECTIVE_DIR, "COLLECTIVE_MEMORY.md"), "utf-8");
    const kaelContent = fs.readFileSync(path.join(PERSONAS_DIR, "kael.md"), "utf-8");
    
    expect(collectiveContent).not.toContain("Kael prefere não usar Ollama");
    expect(kaelContent).toContain("Kael prefere não usar Ollama");
  });

  test("Token count for injections should be small (<= 500 chars limit as rough proxy for now)", async () => {
    const collectiveContent = fs.readFileSync(path.join(COLLECTIVE_DIR, "COLLECTIVE_MEMORY.md"), "utf-8");
    // basic check length
    expect(collectiveContent.length).toBeLessThan(1000); // 1000 chars is roughly < 500 tokens
  });

  test("DEF-06: Light Sleep aplica fallback category='learning' para session.idle sem categoria", async () => {
    // Injeção de dados de teste reais no diretório temporário isolado
    const logPath = path.join(DAILY_DIR, "log_def06.jsonl");
    const fact = "Fato de teste sem categoria explícita vindo de session.idle";
    fs.writeFileSync(logPath, JSON.stringify({ type: "session.idle", scope: "collective", fact }) + "\n");

    await cycle.lightSleep();

    // Asserções reais: o fato foi inserido no banco COM categoria "learning"
    const mem = db.getAllMemories().find(m => m.fact === fact);
    expect(mem).toBeDefined();
    expect(mem!.category).toBe("learning");
    expect(mem!.scope).toBe("collective");
    // O log diário foi ingerido e arquivado
    expect(fs.existsSync(logPath)).toBe(false);
    expect(fs.existsSync(logPath + ".processed")).toBe(true);
  });

  test("DEF-10: Light Sleep não reforça score de eventos triviais repetidos (session.idle)", async () => {
    const fact = "Sessão finalizada no diretório /tmp/def10_repeticao";
    fs.writeFileSync(
      path.join(DAILY_DIR, "log_def10_first.jsonl"),
      JSON.stringify({ type: "session.idle", scope: "collective", fact }) + "\n"
    );
    await cycle.lightSleep();

    const first = db.getAllMemories().find(m => m.fact === fact);
    expect(first).toBeDefined();
    expect(first!.confirmations).toBe(1);
    expect(first!.score).toBe(1.0);

    // Repetição exata do mesmo evento trivial — não pode inflar score/confirmations
    fs.writeFileSync(
      path.join(DAILY_DIR, "log_def10_repeat.jsonl"),
      JSON.stringify({ type: "session.idle", scope: "collective", fact }) + "\n"
    );
    await cycle.lightSleep();

    const repeated = db.getAllMemories().find(m => m.fact === fact);
    expect(repeated!.confirmations).toBe(1);
    expect(repeated!.score).toBe(1.0);
  });

  test("DEF-10: reforço de fatos repetidos é limitado por teto (sem inflação infinita)", () => {
    const fact = "Sessão finalizada no diretório /tmp/def10_teto";
    for (let i = 0; i < 20; i++) {
      db.insertMemory("collective", fact, "learning");
    }
    const mem = db.getAllMemories().find(m => m.fact === fact);
    expect(mem).toBeDefined();
    expect(mem!.confirmations).toBe(DreamsDB.MAX_CONFIRMATIONS);
    expect(mem!.confirmations).toBeLessThanOrEqual(10);
    expect(mem!.score).toBeLessThanOrEqual(DreamsDB.MAX_SCORE);
    expect(mem!.score).toBe(5);
  });

  test("Light Sleep should expunge old daily files (.processed/.jsonl) older than 3 days", async () => {
    // Create a fake .processed file with mtime older than 3 days
    const oldFilePath = path.join(DAILY_DIR, "log_2023-01-01.jsonl.processed");
    fs.writeFileSync(oldFilePath, JSON.stringify({fake: "data"}));
    // Set mtime to 10 days ago
    const tenDaysAgo = new Date();
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
    fs.utimesSync(oldFilePath, tenDaysAgo, tenDaysAgo);
    
    // A recent .jsonl file (fresh) must NOT be deleted by expiry.
    const recentJsonlPath = path.join(DAILY_DIR, "log_recent.jsonl");
    fs.writeFileSync(recentJsonlPath, JSON.stringify({recent: true, fact: "test"}));
    
    // Run lightSleep which will trigger expireOldDailyFiles
    await cycle.lightSleep();
    
    // The old file should have been deleted (mtime 10 days ago > 3 days)
    const oldExists = fs.existsSync(oldFilePath);
    expect(oldExists).toBe(false); // expired and deleted
    
    // The recent .jsonl was processed (renamed to .processed) and must survive.
    const recentProcessed = recentJsonlPath + ".processed";
    const recentProcessedExists = fs.existsSync(recentProcessed);
    expect(recentProcessedExists).toBe(true); // renamed but not deleted
  });

  test("DEF-03: dream_learn valida o scope e rejeita Directory Traversal", () => {
    // Escopos inválidos falham rápido (fail-fast), sem gravar nada
    expect(() => dream_learn({ scope: "../../etc/passwd", fact: "hostil", category: "learning" }, { dailyDir: DAILY_DIR })).toThrow();
    expect(() => dream_learn({ scope: "agent:../escape", fact: "hostil", category: "learning" }, { dailyDir: DAILY_DIR })).toThrow();
    expect(() => dream_learn({ scope: "agent:", fact: "hostil", category: "learning" }, { dailyDir: DAILY_DIR })).toThrow();
    expect(() => dream_learn({ scope: "outro:scope", fact: "hostil", category: "learning" }, { dailyDir: DAILY_DIR })).toThrow();

    // Escopo válido é aceito e gravado no diretório injetado (isolado em /tmp)
    const message = dream_learn({ scope: "collective", fact: "Fato válido para validação de scope", category: "learning" }, { dailyDir: DAILY_DIR });
    expect(message).toContain("collective");

    const written = fs.readdirSync(DAILY_DIR).filter(f => f.endsWith(".jsonl"));
    expect(written.length).toBeGreaterThan(0);
    const content = written.map(f => fs.readFileSync(path.join(DAILY_DIR, f), "utf-8")).join("\n");
    expect(content).toContain("Fato válido para validação de scope");
    // Nada foi gravado fora do diretório temporário
    expect(fs.existsSync(path.join(TEST_BASE_DIR, "log_def03_escape.jsonl"))).toBe(false);
  });

  test("DEF-03: updateProjections bloqueia Directory Traversal no nome do agente", () => {
    db.insertMemory("agent:../../escape", "Fato hostil de traversal", "learning");
    db.insertMemory("agent:..", "Fato hostil de traversal dois", "learning");

    cycle.updateProjections();

    // Nenhum arquivo foi criado fora de PERSONAS_DIR
    expect(fs.existsSync(path.join(TEST_BASE_DIR, "escape.md"))).toBe(false);
    expect(fs.existsSync(path.join("/tmp", "escape.md"))).toBe(false);
    // Todos os arquivos gerados em PERSONAS_DIR têm nome seguro
    const personas = fs.readdirSync(PERSONAS_DIR);
    expect(personas.length).toBeGreaterThan(0);
    expect(personas.every(f => /^[a-zA-Z0-9_-]+\.md$/.test(f))).toBe(true);
  });
});

// E2E do entrypoint do plugin com HOME isolado em /tmp (processo separado,
// porque os caminhos de produção são derivados de os.homedir() no boot).
describe("src/index.ts E2E (HOME isolado em /tmp)", () => {
  test("DEF-05/DEF-09: log diário calculado na escrita e db.close() no dispose", () => {
    const tmpHome = path.join("/tmp", `opencode_dreams_index_${Date.now()}`);
    fs.mkdirSync(tmpHome, { recursive: true });
    try {
      const proc = Bun.spawnSync(
        [process.execPath, path.join(import.meta.dir, "fixtures", "index_e2e.ts")],
        {
          cwd: path.resolve(import.meta.dir, ".."),
          env: { ...process.env, HOME: tmpHome },
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const stdout = new TextDecoder().decode(proc.stdout);
      const line = stdout.split("\n").find(l => l.startsWith("E2E_RESULT:"));
      expect(line).toBeDefined();
      expect(proc.exitCode).toBe(0);

      const result = JSON.parse(line!.slice("E2E_RESULT:".length));
      const today = new Date().toISOString().split("T")[0];

      // DEF-05: log gravado no arquivo do dia corrente, sob o HOME isolado
      expect(String(result.dailyDir).startsWith(tmpHome)).toBe(true);
      expect(result.todayLogExists).toBe(true);
      expect(result.todayLogName).toBe(`log_${today}.jsonl`);
      expect(String(result.todayLogContent)).toContain("Sessão finalizada no diretório /tmp/e2e_dreams_project");

      // DEF-09: dispose fecha a conexão SQLite
      expect(result.dispose?.status).toBe("disposed");
      expect(result.dbClosedAfterDispose).toBe(true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
