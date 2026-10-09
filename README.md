# 🌙 Chamber Dream (`opencode-plugin-dreams`)

Plugin oficial de **memória contínua, consolidação cognitiva e arquitetura de sono** para o ecossistema [OpenCode](https://opencode.ai).

O **Chamber Dream** resolve o problema clássico de perda de contexto e amnésia entre sessões de LLM. Inspirado nas neurociências e no ciclo biológico do sono, o plugin ingere passivamente os diálogos reais de trabalho, destila aprendizados preditivos através de modelos cognitivos em nuvem e projeta regras ativas para os agentes operacionais sem sobrecarregar a janela de contexto.

---

## 🧠 Como Funciona a Arquitetura Tri-Fásica

Diferente de sistemas rudimentares que apenas salvam logs de telemetria ("sessão finalizada", "sessão compactada"), o Chamber Dream executa um ciclo cognitivo estruturado em três fases de sono mais a vigília ativa:

```
┌────────────────────────────────────────────────────────────────────────┐
│                          VIGÍLIA ATIVA                                 │
│  • dream_learn (registro intencional)                                  │
│  • dream_recall (busca rápida em FTS5 SQLite)                          │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ (diálogos salvos em opencode.db)
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                       FASE 1: LIGHT SLEEP (Ingestão)                   │
│  • Lê opencode.db (read-only, últimas 24h)                             │
│  • Filtra payloads de ferramentas, diffs de código e ruídos            │
│  • Buffer seguro de 120.000 chars com truncamento invertido           │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ (dialogue_pending.txt)
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                       FASE 2: REM SLEEP (Destilação)                   │
│  • Prompt cognitivo estruturado (extrai apenas lições com valor futuro)│
│  • Cascata: 1º Mimo 2.6 Flash Free ──(fallback)──> 2º Gemini 3.7 Flash │
│  • Sem IA disponível? Lança erro explícito e preserva o handoff        │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ (memórias persistidas no DreamsDB)
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                       FASE 3: DEEP SLEEP (Decaimento & Projeção)       │
│  • Curva de esquecimento de Ebbinghaus: Score = (Base + Recalls) * e^kt│
│  • Reforço de sinapses para memórias consultadas ou repetidas          │
│  • Poda automática de itens com score < 0.20                           │
│  • Exporta Top 20: COLLECTIVE_MEMORY.md e personas/<agente>.md         │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 🛠️ Ferramentas de Vigília (Tools do OpenCode)

Quando o plugin está carregado no runtime do OpenCode, os agentes têm acesso imediato a duas ferramentas nativas:

1. **`dream_learn`**:
   * Permite que agentes e orquestradores registrem lições ativamente durante a vigília.
   * **Categorias:** `preference`, `decision`, `pitfall`, `learning`.
   * **Escopo:** `collective` (regras gerais do ecossistema) ou `agent:<nome>` (específico da persona, ex.: `agent:silas`, `agent:clara`).

2. **`dream_recall`**:
   * Busca instantânea por relevância textual via **SQLite FTS5**.
   * Cada busca bem-sucedida incrementa o contador `recall_count` e reforça o score da memória contra o esquecimento temporal.

---

## ⚙️ Mecânica das Fases do Sono

### 1. Light Sleep (`src/core/session_reader.ts`)
* Abre a base SQLite `~/.local/share/opencode/opencode.db` em modo **estritamente read-only** (`{ readonly: true }`).
* Captura apenas blocos de texto reais trocados entre usuário e agentes (`user` e `assistant`).
* **Truncamento Invertido:** Se o dia exceder 120.000 caracteres (~28k tokens), o sistema fatia o início do dia com o prefixo `[… início do dia omitido]`, garantindo que as instruções e correções mais recentes da tarde e noite **nunca sejam perdidas**.

### 2. REM Sleep (`src/core/mimo_synthesizer.ts`)
* Processa o texto com destilador cognitivo que devolve um array JSON de memórias atômicas.
* **Cascata Resiliente de Modelos:**
  1. `opencode/mimo-v2.6-flash-free` (prioridade 100% gratuita).
  2. `google/antigravity-gemini-3.7-flash` (variant: `low`, acionado em caso de erro de cota ou indisponibilidade do Mimo).
* **Política Anti-Falsificação:** Se nenhum modelo de IA estiver disponível ou em modo `DREAMS_OFFLINE=1`, o sistema **não inventa fatos**. Ele emite um erro explícito e mantém `dialogue_pending.txt` intacto no disco para reprocessar na noite seguinte.

### 3. Deep Sleep (`src/core/sleep_cycle.ts`)
* Aplica decaimento temporal exponencial baseado no tempo desde o último reforço (`last_reinforced`):
  $$\text{Score} = (1.0 + \text{recall\_count} + \text{confirmations}) \times e^{-\lambda \times \Delta t \times \text{decay\_weight}}$$
* Atualiza os arquivos de projeção em disco com as **Top 20 memórias** mais pontuadas:
  * `~/.config/opencode/dreams/collective/COLLECTIVE_MEMORY.md`
  * `~/.config/opencode/dreams/personas/<agente>.md`

---

## 📥 Como Instalar e Configurar

### 1. Pré-requisitos
* [Bun](https://bun.sh) (v1.1 ou superior instalado)
* [OpenCode CLI](https://opencode.ai) (v1.18.x)

### 2. Clonando o Repositório
Clone o repositório diretamente na pasta de plugins do seu usuário OpenCode:

```bash
mkdir -p ~/.config/opencode/plugins
cd ~/.config/opencode/plugins
git clone https://github.com/maiteuxzanela/chamber_dream.git opencode-plugin-dreams
cd opencode-plugin-dreams
bun install
```

### 3. O que precisa ser Editado / Configurado

#### A. Modelos de IA (Opcional)
Por padrão, o sintetizador usa:
* Principal: `opencode/mimo-v2.6-flash-free`
* Fallback: `google/antigravity-gemini-3.7-flash`

Se desejar alterar os modelos, edite as constantes em `src/core/mimo_synthesizer.ts`:
```typescript
export const DEFAULT_MIMO_MODEL = "opencode/mimo-v2.6-flash-free";
export const DEFAULT_FALLBACK_MODEL = "google/antigravity-gemini-3.7-flash";
```
Ou defina a variável de ambiente:
```bash
export OPENCODE_MODEL="seu-provedor/seu-modelo"
```

#### B. Registro do Plugin no OpenCode
Adicione o plugin ao seu `~/.config/opencode/opencode.json` (ou `opencode.jsonc`):

```json
{
  "plugins": [
    "~/.config/opencode/plugins/opencode-plugin-dreams"
  ]
}
```

#### C. Injeção no `AGENTS.md` (Para seus agentes lerem as memórias)
Adicione no início do seu arquivo de governança (`AGENTS.md` ou `SYSTEM_PROMPT.md`):

```markdown
> 🧠 **Memórias Ativas Consolidadas (Dreams):**  
> Todo agente opera sob as lições consolidadas pelo ciclo noturno de sono:  
> - **Memória Coletiva Global:** `~/.config/opencode/dreams/collective/COLLECTIVE_MEMORY.md`  
> - **Memória Individual da sua Persona:** `~/.config/opencode/dreams/personas/<seu_nome>.md`  
> - **Busca Ativa:** Utilize `dream_recall(query: "...")` para resgatar decisões arquiteturais e armadilhas.
```

---

## ⏰ Automatizando a Consolidação Noturna (Systemd)

Para que o ciclo de sono execute automaticamente todas as noites (ex.: às 03:00 da madrugada), crie os serviços de usuário do Systemd:

### 1. Criar o serviço: `~/.config/systemd/user/opencode-dreams.service`
```ini
[Unit]
Description=OpenCode Dreams Daily Memory Consolidation Service
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment="HOME=%h"
Environment="PATH=%h/.bun/bin:/usr/local/bin:/usr/bin:/bin"
Environment="OPENCODE_MODEL=google/antigravity-gemini-3.7-flash"
Environment="OLLAMA_HOST=127.0.0.1:99999"
Environment="CUDA_VISIBLE_DEVICES="
Environment="FORBID_LOCAL_INFERENCE=true"
WorkingDirectory=%h/.config/opencode/plugins/opencode-plugin-dreams
ExecStart=%h/.config/opencode/plugins/opencode-plugin-dreams/bin/dreams-consolidate.sh
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

### 2. Criar o temporizador: `~/.config/systemd/user/opencode-dreams.timer`
```ini
[Unit]
Description=OpenCode Dreams Daily Memory Consolidation Timer

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
RandomizedDelaySec=60

[Install]
WantedBy=timers.target
```

### 3. Ativar o temporizador:
```bash
systemctl --user daemon-reload
systemctl --user enable --now opencode-dreams.timer
```

---

## 💻 Comandos da CLI do Dreams

Você pode disparar as fases manualmente a qualquer momento via terminal:

```bash
# Executa o ciclo completo (Light -> REM -> Deep)
bun run src/cli.ts consolidate

# Executa apenas a captura de diálogos recentes
bun run src/cli.ts light

# Executa apenas a síntese cognitiva das conversas pendentes
bun run src/cli.ts rem

# Executa apenas o decaimento temporal de Ebbinghaus e atualiza as projeções
bun run src/cli.ts deep
```

---

## 🧪 Testes e Validação Determinística

O projeto é construído sob a diretriz estrita **Anti-Mock Fail-Fast** — 100% dos testes operam contra bancos SQLite reais em diretórios temporários, sem mocks de framework:

```bash
# Executa todos os testes da suíte em modo offline determinístico
DREAMS_OFFLINE=1 bun test

# Executa o typecheck rigoroso do TypeScript
bun x tsc --noEmit
```

---

## 📄 Licença

Distribuído sob a licença MIT. Criado por [Maiteux Zanela](https://github.com/maiteuxzanela).
