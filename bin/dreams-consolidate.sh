#!/bin/bash
# Wrapper para o consolidador diário de memórias (opencode-plugin-dreams)
# Garantias de execução: Checagem de conectividade ISOLADA para a LLM remota,
# proteção de hardware e logging isolado.
#
# DEF-07: Light Sleep e Deep Sleep são rotinas 100% locais e rodam SEMPRE,
# mesmo sem internet. A verificação de ping só decide se a chamada remota da
# LLM no REM Sleep roda online ou em modo offline local (DREAMS_OFFLINE=1).

LOG_FILE="$HOME/.local/state/opencode-dreams.log"
exec >> "$LOG_FILE" 2>&1

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Iniciando consolidação diária de memórias (opencode-dreams)..."

# 1. Checagem de conectividade (nunca aborta o ciclo local)
ONLINE=1
if ! ping -c 1 -W 5 1.1.1.1 > /dev/null 2>&1; then
    ONLINE=0
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Sem internet. Rotinas locais (Light/Deep Sleep) seguem normalmente; apenas a LLM remota do REM Sleep roda em modo offline."
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Conectividade OK. Prosseguindo..."
fi

# 2. Blindagem de Recursos de Hardware (CPU/GPU)
# Asseguramos que não há rotas para modelos locais setando a variável de ambiente.
# Qualquer chamada para o REM Sleep (síntese) deverá usar exclusivamente modelos de nuvem.
export OLLAMA_HOST="127.0.0.1:99999" # Invalida fallback acidental para Ollama
export CUDA_VISIBLE_DEVICES=""       # Oculta a GTX 1050 Ti Pascal do processo de script caso use Python acidentalmente.
export FORBID_LOCAL_INFERENCE="true"

# 3. Path do CLI a ser executado (A ser ajustado caso Túlio defina diferente)
PLUGIN_DIR="$HOME/.config/opencode/plugins/opencode-plugin-dreams"
CLI_PATH="$PLUGIN_DIR/src/cli.ts"

if [ ! -f "$CLI_PATH" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Erro: CLI não encontrado em $CLI_PATH"
    exit 1
fi

# Executa o consolidador por etapas (Assumimos Bun, que é padrão no ambiente opencode)
EXIT_CODE=0

# Etapa 1/3: Light Sleep (local — sempre executa)
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Executando bun run $CLI_PATH light..."
bun run "$CLI_PATH" light || EXIT_CODE=$?

# Etapa 2/3: REM Sleep — LLM remota apenas com internet; sem internet, modo offline local
if [ "$ONLINE" -eq 1 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Executando bun run $CLI_PATH rem (LLM remota)..."
    bun run "$CLI_PATH" rem || EXIT_CODE=$?
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Executando bun run $CLI_PATH rem em MODO OFFLINE (sem LLM remota)..."
    DREAMS_OFFLINE=1 bun run "$CLI_PATH" rem || EXIT_CODE=$?
fi

# Etapa 3/3: Deep Sleep (local — sempre executa)
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Executando bun run $CLI_PATH deep..."
bun run "$CLI_PATH" deep || EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Consolidação concluída com sucesso."
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Falha na consolidação. Exit code: $EXIT_CODE"
fi

exit $EXIT_CODE
