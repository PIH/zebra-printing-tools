#!/usr/bin/env bash
# Install zpl2pdf into bin/<platform>/ for use by browser-print-shim.py.
# Pinned to a specific release for reproducibility. Idempotent.
#
# Tested asset layout for v3.1.1: flat tarball (no directory prefix), binary
# named ZPL2PDF (upper-case). A lower-case symlink zpl2pdf is created so the
# shim's invocation is consistent across platforms.

set -euo pipefail

# Detect the right SHA256 verification tool (varies by OS).
if command -v sha256sum >/dev/null 2>&1; then
  SHA_CMD=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
  SHA_CMD=(shasum -a 256)
else
  echo "Neither sha256sum nor shasum available — cannot verify checksums." >&2
  echo "Install via: sudo apt install coreutils  (Linux) — or shasum is part of macOS by default." >&2
  exit 1
fi

VERSION="v3.1.1"
# Note: the GitHub repo name is capitalised (ZPL2PDF) — this affects download URLs.
REPO="brunoleocam/ZPL2PDF"
HERE="$(cd "$(dirname "$0")" && pwd)"

# Detect platform/arch.
case "$(uname -s)" in
  Linux)   OS="linux" ;;
  Darwin)  OS="osx" ;;
  *) echo "Unsupported OS: $(uname -s). Use install-zpl2pdf.ps1 on Windows." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "Unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac
PLATFORM="${OS}-${ARCH}"
DEST="${HERE}/bin/${PLATFORM}"

# Skip if already installed.
if [[ -x "${DEST}/zpl2pdf" ]]; then
  echo "zpl2pdf already installed at ${DEST}/zpl2pdf"
  "${DEST}/zpl2pdf" --version 2>/dev/null || true
  exit 0
fi

ASSET="ZPL2PDF-${VERSION}-${PLATFORM}.tar.gz"
URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}"
# SHA256SUMS.txt lists the versioned asset names in UPPERCASE hex.
CHECKSUMS_URL="https://github.com/${REPO}/releases/download/${VERSION}/SHA256SUMS.txt"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

echo "Downloading ${ASSET}…"
curl -fsSL -o "${TMP}/${ASSET}" "${URL}"

echo "Fetching SHA256SUMS.txt…"
if curl -fsSL -o "${TMP}/SHA256SUMS.txt" "${CHECKSUMS_URL}"; then
  # SHA256SUMS.txt uses bare filenames (no ./ prefix), uppercase hex, and CRLF
  # line endings. Strip \r before matching so the filename anchor works.
  EXPECTED="$(tr -d '\r' < "${TMP}/SHA256SUMS.txt" | grep -iE "[[:space:]]${ASSET}\$" | awk '{print tolower($1)}' || true)"
  if [[ -n "${EXPECTED}" ]]; then
    echo "Verifying SHA256…"
    ACTUAL="$("${SHA_CMD[@]}" "${TMP}/${ASSET}" | awk '{print $1}')"
    if [[ "${EXPECTED}" != "${ACTUAL}" ]]; then
      echo "SHA256 mismatch! expected=${EXPECTED} actual=${ACTUAL}" >&2
      exit 1
    fi
    echo "  OK"
  else
    echo "Warning: ${ASSET} not listed in SHA256SUMS.txt — skipping verification."
  fi
else
  echo "Warning: SHA256SUMS.txt not available — skipping verification."
fi

echo "Extracting to ${DEST}/…"
mkdir -p "${DEST}"
# The v3.1.1 tarballs are flat (no top-level directory wrapper).
# Try --strip-components=1 first in case a future release wraps in a dir;
# fall back to a flat extraction if that fails.
if ! tar -xzf "${TMP}/${ASSET}" -C "${DEST}" --strip-components=1 2>/dev/null; then
  tar -xzf "${TMP}/${ASSET}" -C "${DEST}"
fi

# Make the binary executable. The .pdb / .xml files in the tarball can stay
# at default modes — only the executable matters.
if [[ -f "${DEST}/ZPL2PDF" ]]; then
  chmod +x "${DEST}/ZPL2PDF"
elif [[ -f "${DEST}/zpl2pdf" ]]; then
  chmod +x "${DEST}/zpl2pdf"
else
  echo "Extraction succeeded but no zpl2pdf or ZPL2PDF binary found in ${DEST}/" >&2
  exit 1
fi

# The released binary is named ZPL2PDF (upper-case) on all non-Windows platforms.
# Create a lower-case symlink so the shim can use a consistent name.
if [[ -f "${DEST}/ZPL2PDF" && ! -e "${DEST}/zpl2pdf" ]]; then
  ln -s ZPL2PDF "${DEST}/zpl2pdf"
fi

echo "Installed:"
"${DEST}/zpl2pdf" --version || echo "  (binary present at ${DEST}/zpl2pdf)"
