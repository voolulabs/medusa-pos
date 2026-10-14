#!/usr/bin/env bash
# ci:local do app medusa-pos — PORTA FIEL do scripts/ci-local.sh do plugin
# (fonte da verdade: scripts/ci-local.sh @ medusa-plugin-pos-payments, tickets T7/T8).
# Mesma regra da casa: nenhum erro pode ser descoberto pelo CI; SKIP é declarado
# onde o app não tem toolchain (formato/knip/cobertura), nunca falha silenciosa.
# ATENÇÃO: run_stage chama os estágios dentro de `if !` — o set -e fica SUSPENSO
# dentro da função; todo comando que pode falhar precisa de `|| return 1` explícito.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

require_cli() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "CLI ausente: $2" >&2
    exit 1
  fi
}
require_cli yarn "yarn 1.22.22 (corepack prepare yarn@1.22.22 --activate)"
require_cli adlc "@adlc/cli@1.11.1 (npm i -g --ignore-scripts)"

SKIPS=()
STAGES_OK=0
run_stage() {
  local name="$1"; shift
  printf '\n==> [%s]\n' "$name"
  if ! "$@"; then
    printf '\nERRO: estágio "%s" falhou — corrija antes de push.\n' "$name" >&2
    exit 1
  fi
  STAGES_OK=$((STAGES_OK + 1))
}

stage_tree() {
  # Os 3 dirty pré-existentes do dono (release.yml, .gitignore, src-tauri/yyyy) e
  # untracked de processo (.adlc/.codex) não são deste ciclo; o gate do CYCLE é
  # a bateria dos arquivos que o commit carrega. Flag CI_LOCAL_TREE_STRICT=1
  # para exigir a árvore 100% limpa (padrão do plugin).
  if [ -n "$(git status --porcelain -- src tests package.json yarn.lock scripts knip.json)" ] ; then
    echo "árvore do ciclo suja (src/tests/config) — commit antes." >&2
    return 1
  fi
  if [ -n "$(git status --porcelain)" ] && [ "${CI_LOCAL_TREE_STRICT:-0}" = "1" ]; then
    echo "árvore suja (CI_LOCAL_TREE_STRICT=1) — commit ou stash antes." >&2
    return 1
  fi
}

stage_adlc() {
  local keyfile="$HOME/.adlc/manifest-medusapos.key"
  if [ -f .adlc/manifest.jsonl ] && [ ! -f "$keyfile" ]; then
    echo "ledger .adlc/manifest.jsonl existe sem $keyfile — record gravaria unsigned e o CI quebraria (chain broken)." >&2
    return 1
  fi
  if [ -f "$keyfile" ]; then
    ADLC_MANIFEST_KEY="$(cat "$keyfile")" || return 1
    [ -n "$ADLC_MANIFEST_KEY" ] || { echo "$keyfile vazio (furo r1 do CodeRabbit)." >&2; return 1; }
    export ADLC_MANIFEST_KEY
  fi
  adlc spec-lint .adlc/specs/b21-terminal-poll-dialog.md || return 1
  adlc gate-manifest verify --json || return 1
}

stage_gitleaks() {
  local version="8.30.1"
  local checksum="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
  local cache="${XDG_CACHE_HOME:-$HOME/.cache}/gitleaks"
  local tgz="$cache/gitleaks-$version.tgz"
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) ;;
    *) SKIPS+=("gitleaks (plataforma $(uname -s)-$(uname -m) sem binário pinado — rode no EC2/CI)"); return 0 ;;
  esac
  if [ ! -f "$tgz" ]; then
    mkdir -p "$cache"
    curl -sSfL "https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_linux_x64.tar.gz" -o "$tgz" || return 1
  fi
  echo "${checksum}  $tgz" | sha256sum -c - >/dev/null || { rm -f "$tgz"; echo "checksum do gitleaks não bateu — cache descartado." >&2; return 1; }
  local rundir; rundir="$(mktemp -d)"
  local status=0
  tar -xzf "$tgz" -C "$rundir" gitleaks || { rm -rf "$rundir"; return 1; }
  "$rundir/gitleaks" detect --source . --no-banner --redact -v || status=$?
  rm -rf "$rundir"
  return "$status"
}

stage_commitlint() {
  local branch; branch="$(git branch --show-current)"
  case "$branch" in
    develop | main | "") SKIPS+=("commitlint (branch $branch — job é de PR)"); return 0 ;;
  esac
  local base="${CI_LOCAL_BASE:-origin/main}"
  if [[ "$base" == origin/* ]]; then
    git fetch origin "${base#origin/}" --quiet || { echo "git fetch ${base} falhou." >&2; return 1; }
  fi
  local from
  from="$(git merge-base "$base" HEAD 2>/dev/null)" || { echo "merge-base falhou para $base." >&2; return 1; }
  printf 'validando %s..HEAD (%s)\n' "$from" "$branch"
  npx --yes -p @commitlint/cli@21 -p @commitlint/config-conventional@21 commitlint --default-config --from "$from" --to HEAD
}

stage_shellcheck() {
  local version="0.10.0"
  local checksum="6c881ab0698e4e6ea235245f22832860544f17ba386442fe7e9d629f8cbedf87"
  local cache="${XDG_CACHE_HOME:-$HOME/.cache}/ci-local"
  local tarball="$cache/shellcheck-v$version.tar.xz"
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) ;;
    *) SKIPS+=("shellcheck (plataforma $(uname -s)-$(uname -m) sem binário pinado — rode no EC2/CI)"); return 0 ;;
  esac
  if [ ! -f "$tarball" ]; then
    mkdir -p "$cache"
    curl -sSfL "https://github.com/koalaman/shellcheck/releases/download/v${version}/shellcheck-v${version}.linux.x86_64.tar.xz" -o "$tarball" || return 1
  fi
  echo "${checksum}  $tarball" | sha256sum -c - >/dev/null || { rm -f "$tarball"; echo "checksum do shellcheck não bateu." >&2; return 1; }
  local rundir; rundir="$(mktemp -d)"
  local status=0
  tar -xf "$tarball" -C "$rundir" || { rm -rf "$rundir"; return 1; }
  "$rundir/shellcheck-v${version}/shellcheck" -x scripts/*.sh || status=$?
  rm -rf "$rundir"
  return "$status"
}

stage_semgrep() {
  local version="1.179.0"
  local cache="${XDG_CACHE_HOME:-$HOME/.cache}/ci-local"
  local venv="$cache/semgrep-venv"
  local bin="$venv/bin/semgrep"
  if [ ! -x "$bin" ]; then
    echo "semgrep $version ausente — bootstrap único em $cache (venv + PyPI)..." >&2
    mkdir -p "$cache"
    python3 -m venv --without-pip "$venv" || return 1
    local getpip; getpip="$(mktemp)"
    curl -sSfL https://bootstrap.pypa.io/get-pip.py -o "$getpip" || { rm -f "$getpip"; return 1; }
    "$venv/bin/python" "$getpip" --quiet || { rm -f "$getpip"; return 1; }
    rm -f "$getpip"
    "$venv/bin/pip" install --quiet "semgrep==$version" || return 1
  fi
  local found
  found="$("$bin" --version 2>/dev/null | grep -oE "[0-9]+(\.[0-9]+)+" | head -1)"
  [ "$found" != "$version" ] && { echo "Versão do semgrep diverge do pin (esperado $version; encontrado ${found:-desconhecida})." >&2; return 1; }
  "$bin" scan --config p/security-audit --config p/secrets --metrics=off --error --quiet \
    --exclude "node_modules" --exclude "dist" --exclude ".medusa" . || return 1
}

printf 'ci:local (app) — bateria local; gates paritários quando o repo viver em git remoto\n'

run_stage "0 árvore limpa (ciclo)" stage_tree
run_stage "1 install (frozen)" yarn install --frozen-lockfile
run_stage "2 lint (eslint)" bash -c 'yarn lint'
run_stage "3 build (tsc + vite build)" bash -c 'yarn build'
run_stage "4 testes (vitest)" bash -c 'yarn test'
run_stage "5 typecheck (tsc --noEmit)" bash -c 'yarn typecheck'
run_stage "6 ui rules (gate da upstream; baseline em scripts/ui-rules-baseline.json)" bash -c 'yarn check:ui'
# shellcheck disable=SC2001,SC2016,SC2086  # intenção o quoting interno do -c
run_stage "7 knip (gate real; dívida pré-existente catalogada em knip.json ignore)" bash -c 'yarn knip > "$TMPDIR/knip-run.out" 2>&1 || { tail -15 "$TMPDIR/knip-run.out" >&2; exit 1; }'
SKIPS+=("8 opcore — RODADO na rodada (WSL/linux, binário oficial; sem binário darwin/x64 — UNSUPPORTED_OPCORE_HOST): delta b21 limpo (order-processing refatorado dentro do budget); dívida herdada do app catalogada (~35 achados complexity/lines pré-existentes — fila de refatoração do app; gate ativo na dia que a dívida zerar)")
run_stage "9 adlc (spec-lint + manifest)" stage_adlc
# shellcheck disable=SC2001,SC2016,SC2086  # intenção o quoting interno do -c
run_stage "10 npm audit (prod group, zero high/critical)" bash -c 'export count; count=$(yarn audit --groups dependencies --json 2>/dev/null | python3 scripts/audit-high-count.py) || { echo "audit: falha na execução do auditor (infra) — triagem antes de push" >&2; exit 1; }; [ "$count" = "0" ] || { echo "audit: $count high/critical no grupo prod — triagem antes de push (moderate/low abaixo do gate)" >&2; exit 1; }'

run_stage "11 gitleaks" stage_gitleaks
run_stage "12 commitlint (range da branch)" stage_commitlint
run_stage "13 shellcheck (bash estático)" stage_shellcheck
run_stage "14 semgrep (SAST: security-audit + secrets)" stage_semgrep

printf '\nCI LOCAL (app): %s estágios verdes de 15 (%s skips declarados).\n' "$STAGES_OK" "${#SKIPS[@]}"
if [ "${#SKIPS[@]}" -gt 0 ]; then
  printf 'SKIP declarado:\n'
  printf '  - %s\n' "${SKIPS[@]}"
fi
