#!/usr/bin/env bash
# Puts a real Google Chrome on this host, so a human can sign in to Google in an ordinary window.
#
#   bash scripts/native/install-chrome.sh
#
# Chrome for Testing is refused: Google treats it as an automated browser. Without root this extracts
# the official .deb under the native state folder; installing the same .deb as root also works.
set -euo pipefail
umask 077

STATE="$HOME/.local/share/rakazo-native"
DOWNLOADS="$STATE/downloads"
TOOLS="$STATE/tools/chrome-stable"
DEB="$DOWNLOADS/google-chrome-stable_current_amd64.deb"
# The fixed stable channel package. Nothing here takes a URL from a person or a file.
DEB_URL="https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb"

log() { printf '[chrome] %s\n' "$*"; }
die() { printf '[chrome] %s\n' "$*" >&2; exit 1; }

# A binary is Google Chrome when its own version says so. Chrome for Testing says "for Testing".
is_real_chrome() {
  local bin="$1" version
  [ -n "$bin" ] && [ -x "$bin" ] || return 1
  version="$("$bin" --version 2>/dev/null || true)"
  case "$version" in
    *"Google Chrome"*)
      case "$version" in
        *"for Testing"*) return 1 ;;
        *) return 0 ;;
      esac
      ;;
  esac
  return 1
}

find_chrome() {
  local candidate
  for candidate in \
    "$(command -v google-chrome-stable 2>/dev/null || true)" \
    "$(command -v google-chrome 2>/dev/null || true)" \
    "/opt/google/chrome/chrome" \
    "$TOOLS/opt/google/chrome/chrome"; do
    if is_real_chrome "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

# The Debian package that carries one of Chrome's shared libraries.
package_for() {
  case "$1" in
    libnss3.so) echo libnss3 ;;
    libnspr4.so) echo libnspr4 ;;
    libatk-1.0.so.0) echo libatk1.0-0 ;;
    libatk-bridge-2.0.so.0) echo libatk-bridge2.0-0 ;;
    libatspi.so.0) echo libatspi2.0-0 ;;
    libcups.so.2) echo libcups2 ;;
    libdrm.so.2) echo libdrm2 ;;
    libdbus-1.so.3) echo libdbus-1-3 ;;
    libxkbcommon.so.0) echo libxkbcommon0 ;;
    libXcomposite.so.1) echo libxcomposite1 ;;
    libXdamage.so.1) echo libxdamage1 ;;
    libXfixes.so.3) echo libxfixes3 ;;
    libXrandr.so.2) echo libxrandr2 ;;
    libX11.so.6) echo libx11-6 ;;
    libxcb.so.1) echo libxcb1 ;;
    libgbm.so.1) echo libgbm1 ;;
    libpango-1.0.so.0) echo libpango-1.0-0 ;;
    libcairo.so.2) echo libcairo2 ;;
    libasound.so.2) echo libasound2 ;;
    libglib-2.0.so.0) echo libglib2.0-0 ;;
    libexpat.so.1) echo libexpat1 ;;
    *) echo "" ;;
  esac
}

# A binary with a missing shared library cannot report its version either, so this runs before any
# `--version` check. Otherwise a minimal host is told "did not report itself as Google Chrome"
# instead of which packages to install.
check_libraries() {
  local bin="$1" missing packages="" unknown="" lib package
  missing="$(ldd "$bin" 2>/dev/null | awk '/not found/ {print $1}' | sort -u || true)"
  [ -n "$missing" ] || return 0
  while IFS= read -r lib; do
    [ -n "$lib" ] || continue
    package="$(package_for "$lib")"
    if [ -n "$package" ]; then
      packages="$packages $package"
    else
      unknown="$unknown $lib"
    fi
  done <<<"$missing"
  log "these shared libraries are missing:"
  printf '%s\n' "$missing" | sed 's/^/  /' >&2
  if [ -n "$packages" ]; then
    log "suggested install: sudo apt-get install -y$packages"
  fi
  if [ -n "$unknown" ]; then
    log "find the packages for:$unknown (apt-file search <library>, or your distribution's package search)"
  fi
  die "Chrome cannot start until those libraries are installed; this script never runs sudo."
}

if BIN="$(find_chrome)"; then
  log "using Google Chrome at $BIN"
else
  case "$(uname -m)" in
    x86_64 | amd64) ;;
    *)
      die "Google Chrome is downloaded for x86_64 only here; this host is $(uname -m). Install Google Chrome from https://www.google.com/chrome/ and run this script again."
      ;;
  esac
  command -v curl >/dev/null 2>&1 || die "curl is required to download Google Chrome."
  command -v dpkg-deb >/dev/null 2>&1 || die "dpkg-deb (from dpkg) is required to extract the Google Chrome package."
  mkdir -p "$STATE" "$DOWNLOADS" "$TOOLS"
  chmod 700 "$STATE" "$DOWNLOADS" "$TOOLS" 2>/dev/null || true
  if [ ! -f "$DEB" ]; then
    log "downloading Google Chrome (about 150 MB)"
    curl --proto '=https' --tlsv1.2 -fL --retry 3 --connect-timeout 20 -o "$DEB.part" "$DEB_URL"
    mv "$DEB.part" "$DEB"
  fi
  # An HTML error page or a truncated answer is not a package.
  [ "$(head -c 7 "$DEB")" = "!<arch>" ] || die "$DEB is not a Debian package; remove it and run this script again."
  # The only folder this script ever replaces is its own, right under the state folder.
  case "$TOOLS" in
    "$STATE"/tools/chrome-stable) ;;
    *) die "refusing to write outside the chrome-stable tools folder: $TOOLS" ;;
  esac
  log "extracting into $TOOLS"
  rm -rf "$TOOLS.new"
  mkdir -p "$TOOLS.new"
  dpkg-deb -x "$DEB" "$TOOLS.new"
  rm -rf "$TOOLS"
  mv "$TOOLS.new" "$TOOLS"
  BIN="$TOOLS/opt/google/chrome/chrome"
  # Libraries first: a missing one also breaks `--version`, so this names the packages instead of
  # reporting a perfectly good Chrome binary as "not Google Chrome".
  check_libraries "$BIN"
  is_real_chrome "$BIN" || die "$BIN did not report itself as Google Chrome."
fi

log "$("$BIN" --version 2>/dev/null || echo "version unavailable")"
check_libraries "$BIN"

# The extracted copy's chrome-sandbox is not root-owned and setuid, so the sandbox may refuse to start
# even with every library present. That is a sandbox/user-namespace limit, not a missing library.
if [ -f "$(dirname "$BIN")/chrome-sandbox" ]; then
  log "the extracted copy's chrome-sandbox is not setuid. If Chrome still refuses to start with a sandbox"
  log "error, install the same package as root instead, which sets it up:"
  log "  sudo apt-get install -y $DEB"
  log "user namespaces also work: check /proc/sys/kernel/unprivileged_userns_clone and"
  log " /proc/sys/user/max_user_namespaces."
fi

command -v sqlite3 >/dev/null 2>&1 || log "warning: sqlite3 is missing, so browser-login.sh will report the Google session as unverified and exit 3."

log "use it for the sign-in window:"
printf '\nexport RAKAZO_NATIVE_LOGIN_CHROME_BIN="%s"\n' "$BIN"
printf 'bash scripts/native/browser-login.sh\n'
