#!/usr/bin/env bash
# codemax installer
#
#   curl -fsSL https://codemax.saidev.codes/install | bash
#   (same script: https://raw.githubusercontent.com/SkidGod4444/codemax-cli/main/install.sh)
#
# macOS and Linux (Windows: use install.ps1 in PowerShell).
# Installs codemax into ~/.codemax/cli and puts `codemax` on your PATH via
# Bun's bin folder, adding that folder to your shell profile if needed. Never reads, sets or asks for API keys: codemax runs on the
# agent subscriptions you are already logged in to.
#
# Options (environment variables):
#   CODEMAX_DIR=<path>     where the code lives        (default ~/.codemax/cli)
#   CODEMAX_REPO=<url>     git source                  (default the GitHub repo)
#   CODEMAX_REF=<ref>      tag or branch to install    (default the newest vX.Y.Z
#                          release tag; main only if no release exists yet)
#   CODEMAX_YES=1          install Bun without asking if it is missing
#
# Uninstall: rm -rf ~/.codemax/cli ~/.bun/bin/codemax

set -euo pipefail

REPO="${CODEMAX_REPO:-https://github.com/SkidGod4444/codemax-cli.git}"
REF="${CODEMAX_REF:-}"
DIR="${CODEMAX_DIR:-$HOME/.codemax/cli}"
BUN_HOME="${BUN_INSTALL:-$HOME/.bun}"

if [ -t 1 ]; then
  P=$'\033[38;5;204m'; B=$'\033[1m'; D=$'\033[2m'; R=$'\033[0m'
else
  P=""; B=""; D=""; R=""
fi
say()  { printf '%s\n' "$*"; }
step() { printf '%s❯%s %s\n' "$P" "$R" "$*"; }
ok()   { printf '  %s⎿%s  %s\n' "$D" "$R" "$*"; }
die()  { printf '%s✗%s %s\n' "$P" "$R" "$*" >&2; exit 1; }

say ""
say "  ${B}codemax${R} ${D}· every AI coding plan you pay for, one terminal${R}"
say ""

# ── platform
case "$(uname -s)" in
  Darwin | Linux) ;;
  MINGW* | MSYS* | CYGWIN*) die "On Windows, run this in PowerShell instead: irm https://codemax.saidev.codes/install.ps1 | iex" ;;
  *) die "Unsupported system: $(uname -s)" ;;
esac

# ── git
command -v git >/dev/null 2>&1 || die "git is required. Install it, then run this again."

# ── bun 1.3+
need_bun=0
if command -v bun >/dev/null 2>&1; then
  BUN=bun
elif [ -x "$BUN_HOME/bin/bun" ]; then
  BUN="$BUN_HOME/bin/bun"
else
  need_bun=1
fi

if [ "$need_bun" = 1 ]; then
  step "codemax runs on Bun, which is not installed."
  answer="n"
  if [ "${CODEMAX_YES:-}" = 1 ]; then
    answer="y"
  elif [ -r /dev/tty ]; then
    printf '  Install Bun now from bun.sh? [Y/n] '
    read -r answer </dev/tty || answer="n"
    answer="${answer:-y}"
  fi
  case "$answer" in
    y | Y | yes) curl -fsSL https://bun.sh/install | bash >/dev/null ;;
    *) die "Install Bun (https://bun.sh), then run this again." ;;
  esac
  BUN="$BUN_HOME/bin/bun"
  [ -x "$BUN" ] || die "Bun did not install. See https://bun.sh"
fi

version="$("$BUN" --version)"
major="${version%%.*}"; rest="${version#*.}"; minor="${rest%%.*}"
if [ "$major" -lt 1 ] || { [ "$major" -eq 1 ] && [ "$minor" -lt 3 ]; }; then
  die "codemax needs Bun 1.3 or newer (found $version). Run: bun upgrade"
fi
ok "Bun $version"

# ── which version: the newest release tag, so a work-in-progress push to main
#    never reaches users. Falls back to main only until the first release.
if [ -z "$REF" ]; then
  tags="$(GIT_TERMINAL_PROMPT=0 git ls-remote --tags --refs "$REPO" 'v*' 2>/dev/null)" \
    || die "Could not reach $REPO. Check your connection, or that the repository is public."
  REF="$(printf '%s\n' "$tags" | sed 's#.*refs/tags/##' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1 || true)"
  if [ -z "$REF" ]; then
    REF=main
    ok "No release yet, installing the latest main"
  fi
fi

# ── code: fetch just the chosen release into a plain checkout (quietly; a
#    release tag is not a branch, so cloning it directly makes git chatter)
if [ -d "$DIR/.git" ]; then
  step "Updating codemax to $REF"
  git -C "$DIR" remote set-url origin "$REPO"
else
  step "Downloading codemax $REF"
  [ -e "$DIR" ] && die "$DIR exists and is not a codemax checkout. Move it or set CODEMAX_DIR."
  mkdir -p "$DIR"
  git -C "$DIR" init --quiet
  git -C "$DIR" remote add origin "$REPO"
fi
GIT_TERMINAL_PROMPT=0 git -C "$DIR" fetch --quiet --depth 1 --no-tags origin "$REF" 2>/dev/null \
  || die "Could not download $REF from $REPO. Check your connection, or that the repository is public."
git -C "$DIR" -c advice.detachedHead=false checkout --quiet --force --detach "FETCH_HEAD^{commit}"
ok "$(git -C "$DIR" log -1 --format='%h %s' | cut -c1-60)"

step "Installing dependencies"
(cd "$DIR" && "$BUN" install --production --silent) || die "bun install failed in $DIR"
ok "done"

# ── command on PATH
mkdir -p "$BUN_HOME/bin"
chmod +x "$DIR/bin/codemax"
ln -sf "$DIR/bin/codemax" "$BUN_HOME/bin/codemax"
ok "codemax → $BUN_HOME/bin/codemax"

# ── agents already on this machine
found=""
for a in claude codex opencode grok gemini cursor-agent copilot; do
  command -v "$a" >/dev/null 2>&1 && found="$found $a"
done
say ""
if [ -n "$found" ]; then
  say "  Agents found:${B}${found}${R}"
else
  say "  No agent CLIs found yet. Install and log in to at least one,"
  say "  for example Claude Code or Codex, then start codemax."
fi

say ""
say "  ${B}Installed.${R} Next:"
say "    codemax doctor          ${D}# checks nothing will bill an API key${R}"
say "    cd your-project && codemax"
# ── Bun's bin folder on PATH: add it to the shell profile once, if missing
case ":$PATH:" in
  *":$BUN_HOME/bin:"*) ;;
  *)
    shell_name="$(basename "${SHELL:-bash}")"
    case "$shell_name" in
      zsh) profile="$HOME/.zshrc"; line="export PATH=\"$BUN_HOME/bin:\$PATH\"" ;;
      fish) profile="$HOME/.config/fish/config.fish"; line="fish_add_path \"$BUN_HOME/bin\"" ;;
      bash)
        if [ "$(uname -s)" = Darwin ]; then profile="$HOME/.bash_profile"; else profile="$HOME/.bashrc"; fi
        line="export PATH=\"$BUN_HOME/bin:\$PATH\"" ;;
      *) profile="$HOME/.profile"; line="export PATH=\"$BUN_HOME/bin:\$PATH\"" ;;
    esac
    if [ -f "$profile" ] && grep -qF "$BUN_HOME/bin" "$profile"; then
      say "  ${D}Open a new terminal to use codemax.${R}"
    else
      mkdir -p "$(dirname "$profile")"
      printf '\n# codemax\n%s\n' "$line" >> "$profile"
      say "  Added $BUN_HOME/bin to your PATH in ${profile/#$HOME/~}."
      say "  ${D}Open a new terminal (or run: source ${profile/#$HOME/~}) to use codemax.${R}"
    fi
    ;;
esac
say ""
