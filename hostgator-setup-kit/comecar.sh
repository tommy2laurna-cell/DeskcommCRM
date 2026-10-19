#!/usr/bin/env bash
#
# DeskcommCRM — a porta de entrada.
#
# Diferente do install.sh, este script roda no SEU computador (macOS, Linux ou
# WSL), antes de existir servidor. Ele responde a única pergunta que trava quem
# está começando — "o que eu preciso ter antes de instalar isso?" — e entrega o
# comando certo para o caso de cada um.
#
# Uso:
#   bash hostgator-setup-kit/comecar.sh     (a partir da pasta do projeto entregue)
#
# LRN: não baixa nada da internet. O que se instala é a pasta que você tem em
# mãos — assim uma mudança no repositório do autor não altera uma instalação.
#
set -euo pipefail

# Pasta do projeto (a que tem o docker-compose.prod.yml), para mostrar o comando
# de cópia ao servidor. Fora dela (script solto), mostra um marcador.
PROJETO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd || true)"
[ -f "$PROJETO_DIR/docker-compose.prod.yml" ] || PROJETO_DIR="<pasta do projeto>"
COMUNIDADE_URL="https://lp-comunidade.automatiklabs.com.br"

# ── Aparência ───────────────────────────────────────────────────────────────
# Gêmeas das do install.sh (que por sua vez é standalone porque roda antes do
# clone). Este aqui roda antes AINDA — pode chegar pela rede sozinho, sem repo
# e sem o irmão ao lado. Se mexer numa, mexa na outra.
if   [ -n "${NO_COLOR:-}" ];    then COLOR=0
elif [ -n "${FORCE_COLOR:-}" ]; then COLOR=1
elif [ -t 1 ];                  then COLOR=1
else                                 COLOR=0
fi
paint() { local code="$1"; shift; if [ "$COLOR" = 1 ]; then printf '\033[%sm%s\033[0m\n' "$code" "$*"; else printf '%s\n' "$*"; fi; }
c_grn() { paint 32 "$*"; }
c_ylw() { paint 33 "$*"; }
c_dim() { paint 2  "$*"; }
die()   { paint 31 "✖ $*"; exit 1; }

LOGO_COLS=71
banner() {
  local cols linha ch
  cols="$(tput cols 2>/dev/null || echo 80)"
  case "$cols" in ''|*[!0-9]*) cols=80;; esac
  printf '\n'
  if [ "$COLOR" != 1 ] || [ "$cols" -lt $((LOGO_COLS + 2)) ]; then
    paint 1 "  DESKCOMM"
  else
    [ -t 1 ] && printf '\033[2J\033[H'
    while IFS= read -r linha; do
      linha="${linha//█/$'\033[32m'█$'\033[0m'}"
      for ch in ═ ╗ ║ ╝ ╚ ╔; do linha="${linha//$ch/$'\033[2m'$ch$'\033[0m'}"; done
      printf '  %s\n' "$linha"
    done <<'LOGO'
██████╗ ███████╗███████╗██╗  ██╗ ██████╗ ██████╗ ███╗   ███╗███╗   ███╗
██╔══██╗██╔════╝██╔════╝██║ ██╔╝██╔════╝██╔═══██╗████╗ ████║████╗ ████║
██║  ██║█████╗  ███████╗█████╔╝ ██║     ██║   ██║██╔████╔██║██╔████╔██║
██║  ██║██╔══╝  ╚════██║██╔═██╗ ██║     ██║   ██║██║╚██╔╝██║██║╚██╔╝██║
██████╔╝███████╗███████║██║  ██╗╚██████╗╚██████╔╝██║ ╚═╝ ██║██║ ╚═╝ ██║
╚═════╝ ╚══════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚═╝     ╚═╝
LOGO
  fi
  printf '\n'
  c_dim "  Agentes de IA que atendem no WhatsApp, dentro do seu CRM."
  c_dim "  Open-source · roda no seu servidor · os dados são seus."
}

# ── Entrada do teclado ──────────────────────────────────────────────────────
# Este script existe para ser chamado por `curl -fsSL … | bash`, e nesse modo o
# stdin do processo É O PIPE (o texto do próprio script), não o teclado: um
# `read` comum consumiria o código-fonte como se fosse resposta, ou veria EOF na
# primeira pergunta. Reatar em /dev/tty é o que faz o menu existir nesse
# caminho; sem terminal nenhum (CI, cron), não há o que perguntar.
TTY_IN=""
if [ -t 0 ]; then TTY_IN="/dev/stdin"
elif [ -r /dev/tty ] && { : < /dev/tty; } 2>/dev/null; then TTY_IN="/dev/tty"
fi

# Devolve != 0 quando a ENTRADA ACABOU, que é diferente de "respondeu vazio"
# (Enter, que vale o default). Confundir os dois prendia o script: alimentado
# por um pipe que termina antes das perguntas — `curl … | bash` de quem só
# responde a primeira —, o processo NÃO terminava (medido: teto de 20s estourado,
# com o menu parado na tela e nada indicando que só um Ctrl-C sai dali). Com a
# distinção, o mesmo caso encerra em 0 imprimindo os dois caminhos.
#
# O mecanismo exato ficou em aberto: o consumo de CPU na espera é ~0 (perfil de
# bloqueio), mas a leitura do código sugeriria reentrada no mesmo ramo. Os dois
# sinais discordam e não vale fechar a questão aqui — o comportamento que
# importa (não termina × termina) está medido nas duas versões.
perguntar() {  # perguntar <variável> <texto> [default]
  local var="$1" texto="$2" padrao="${3:-}" resposta=""
  if [ -z "$TTY_IN" ]; then printf -v "$var" '%s' "$padrao"; return 0; fi
  printf '%s' "$texto"
  if ! read -r resposta < "$TTY_IN"; then printf '\n'; return 1; fi
  printf -v "$var" '%s' "${resposta:-$padrao}"
}

# ── O que o servidor precisa ────────────────────────────────────────────────
# Os números saem de docs/runbooks/waha-hostgator.md (dimensionamento do WAHA):
# o WhatsApp usa cerca de 150 MB por número conectado e a stack são 7 contêineres.
mostrar_requisitos() {
  cat <<REQ

  O CRM roda 24 horas por dia, com o WhatsApp junto. O servidor precisa de:

    • VPS com Docker Compose v2 (o instalador instala o Docker se faltar)
    • 4 GB de RAM recomendados (2 GB sobe, mas fica no limite) e 80 GB de disco
    • Ubuntu 22.04 LTS ou 24.04 LTS
    • Portas 80 e 443 abertas
    • Um domínio com registro A apontando para o IP do servidor

  Funciona em qualquer provedor de VPS.

REQ
  printf '\n'
}

comando_de_instalacao() {
  cat <<CMD

  Copie esta pasta do projeto para o servidor e rode o instalador lá:

       scp -r "${PROJETO_DIR}" root@SEU_IP_AQUI:deskcommcrm
       ssh root@SEU_IP_AQUI
       cd deskcommcrm && bash hostgator-setup-kit/install.sh

  O instalador cuida do resto: instala o Docker se faltar, cria o banco,
  configura o domínio com HTTPS e sobe o CRM. Ele pergunta o que só você sabe
  (o domínio, as chaves, a senha do primeiro acesso) e valida cada resposta na
  hora — nada de descobrir um dado errado dez minutos depois.

CMD
}

# ── Fluxo ───────────────────────────────────────────────────────────────────
banner

if [ -z "$TTY_IN" ]; then
  # Sem teclado (pipe puro, CI): não dá para conduzir ninguém. Entrega os dois
  # caminhos de uma vez, em vez de escolher um por conta própria.
  c_ylw "  (sem terminal interativo — segue o resumo dos dois caminhos)"
  mostrar_requisitos
  comando_de_instalacao
  exit 0
fi

while :; do
  cat <<MENU

  Onde o seu CRM vai rodar?

    1) Ainda não tenho servidor
    2) Já tenho um servidor (VPS), mas estou no meu computador
    3) Já estou dentro do servidor agora

MENU
  # Enter cai no 1 de propósito: quem já tem servidor costuma chegar ao produto
  # pelo README com o SSH aberto e ir direto ao install.sh. Quem chega por AQUI
  # — um vídeo, a comunidade, um link solto — é, na maioria, quem ainda não tem.
  if ! perguntar escolha "  Digite 1, 2 ou 3 (Enter = 1): " "1"; then
    c_ylw "  (a entrada terminou — deixo os dois caminhos aqui)"
    mostrar_requisitos
    comando_de_instalacao
    exit 0
  fi

  case "$escolha" in
    1)
      mostrar_requisitos
      c_dim "  Quando o servidor estiver de pé, rode este mesmo comando de novo e"
      c_dim "  escolha a opção 2 — eu te dou o passo seguinte."
      ;;
    2)
      cat <<SSH

  Entre no servidor pelo terminal. O provedor te mandou o IP e a senha de root
  por e-mail quando a VPS ficou pronta:

       ssh root@SEU_IP_AQUI

SSH
      comando_de_instalacao
      break
      ;;
    3)
      if [ -f "$(dirname "$0")/install.sh" ]; then
        # Confirmação explícita porque este é o único ramo que MUDA a máquina, e
        # o engano é fácil: quem clonou o repo no próprio notebook para ler o
        # código está a uma tecla de instalar a stack inteira nele. Mostrar o
        # hostname é o que faz a pessoa perceber onde ela está de verdade.
        printf '\n'
        c_ylw "  Atenção: isso instala o CRM NESTA máquina — $(hostname 2>/dev/null || echo 'esta')."
        c_ylw "  Se você está no seu computador pessoal, e não no servidor, responda n."
        # EOF aqui cai no ramo de NÃO instalar: este é o único ponto do script
        # que muda a máquina, e "não consegui perguntar" nunca vira um sim.
        perguntar ok "  Continuar? (s/N) " "N" || ok="N"
        case "$ok" in
          [Ss]*)
            c_grn "  ✓ achei o instalador aqui do lado. Começando."
            printf '\n'
            exec bash "$(dirname "$0")/install.sh"
            ;;
        esac
        c_dim "  Ok, não instalei nada. Escolha 1 ou 2 se precisar do outro caminho."
        continue
      fi
      c_ylw "  Você está no servidor, mas a pasta do projeto ainda não foi copiada para cá."
      comando_de_instalacao
      break
      ;;
    *)
      c_ylw "  Não entendi '${escolha}'. Digite 1, 2 ou 3."
      ;;
  esac
done

cat <<FIM
  ─── Quando travar ────────────────────────────────────────

  Tem gente rodando exatamente este CRM na comunidade, e é lá que saem os
  avisos de versão nova:

       ${COMUNIDADE_URL}

FIM
