#!/bin/bash
# Script para ativação e verificação dos serviços systemd user do opencode-dreams
set -e

echo "=== Ativação do OpenCode Dreams Systemd Timer ==="

# 1. Recarregar daemons do systemd user
echo "[1/4] Executando systemctl --user daemon-reload..."
systemctl --user daemon-reload

# 2. Habilitar e iniciar o timer
echo "[2/4] Habilitando e iniciando opencode-dreams.timer..."
systemctl --user enable opencode-dreams.timer
systemctl --user restart opencode-dreams.timer

# 3. Validar se o timer está ativo
echo "[3/4] Verificando status do timer..."
systemctl --user is-active --quiet opencode-dreams.timer && echo "Timer ATIVO com sucesso!" || (echo "Erro: Timer inativo!" && exit 1)

# 4. Listar próximos disparos
echo "[4/4] Listando agendamentos..."
systemctl --user list-timers opencode-dreams.timer

echo "=== Configuração Concluída com Sucesso! ==="
