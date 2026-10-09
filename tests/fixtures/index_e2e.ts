// Fixture E2E (sem mocks): executa o plugin real de src/index.ts com HOME
// apontando para um diretório temporário isolado, provando em runtime:
//   - DEF-05: o path do log diário é derivado da data no momento da escrita
//     (sem constantes estáticas dateStr/logFile congeladas na importação);
//   - DEF-09: dispose() chama db.close() — a conexão SQLite fica inutilizável.
import { serverPlugin } from "../../src/index";
import fs from "fs";
import path from "path";
import os from "os";

const directory = "/tmp/e2e_dreams_project";

const plugin: any = await (serverPlugin as any)({ directory });

const result: Record<string, unknown> = {};

// DEF-05: evento de sessão gravado no arquivo do dia corrente
await plugin.event({ event: { type: "session.idle" } });
const dailyDir = path.join(os.homedir(), ".config/opencode/dreams/daily");
const today = new Date().toISOString().split("T")[0];
const todayLog = path.join(dailyDir, `log_${today}.jsonl`);
result.dailyDir = dailyDir;
result.todayLogExists = fs.existsSync(todayLog);
result.todayLogName = path.basename(todayLog);
result.todayLogContent = fs.existsSync(todayLog) ? fs.readFileSync(todayLog, "utf-8") : "";

// DEF-09: dispose fecha o banco — recall seguinte deve falhar
result.dispose = await plugin.dispose();
try {
  await plugin.tool.dream_recall.execute({ query: "qualquer" });
  result.dbClosedAfterDispose = false;
} catch (e) {
  result.dbClosedAfterDispose = true;
}

console.log("E2E_RESULT:" + JSON.stringify(result));
