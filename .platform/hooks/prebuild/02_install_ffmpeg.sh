#!/usr/bin/env bash
set -euo pipefail

# Installs the pinned FFmpeg build that room audio analysis uses to fully decode
# MP3 and AAC-LC M4A sources. Amazon Linux 2023 ships no FFmpeg package, so the
# hook fetches one static build and trusts it only when its SHA-256 matches the
# digest recorded here. Any download, size, digest, layout or capability failure
# exits non-zero, which fails the deployment instead of silently leaving
# compressed uploads without a decoder.
#
# Source: BtbN/FFmpeg-Builds, LGPL static build of the FFmpeg 9.0 release branch.
# Only the last build of each month is retained for two years, so the September
# 2026 build stays downloadable until about 2028-09; refresh the pin earlier for
# FFmpeg security fixes. To refresh, take one month-end autobuild release and
# update the tag, both archive names, byte sizes and digests together. Check each
# digest against the release's checksums.sha256 and GitHub's asset digest.
FFMPEG_RELEASE_TAG='autobuild-2026-09-30-13-08'
FFMPEG_RELEASE_BASE_URL='https://github.com/BtbN/FFmpeg-Builds/releases/download'
ARM64_ARCHIVE='ffmpeg-n9.0.2-17-g2a571b6068-linuxarm64-lgpl-9.0.tar.xz'
ARM64_ARCHIVE_BYTES='116918620'
ARM64_ARCHIVE_SHA256='b8cc09200780d37801179c803f597c22440b0b06c556addd2e6a07b27475ce37'
X86_64_ARCHIVE='ffmpeg-n9.0.2-17-g2a571b6068-linux64-lgpl-9.0.tar.xz'
X86_64_ARCHIVE_BYTES='137863452'
X86_64_ARCHIVE_SHA256='2d41cbea0ca1a15029b638330740f78d6f5aeb062355bf425433fc938705350a'

# Paths and tools are overridable only so tests can run the hook against an
# isolated filesystem. The pinned URL, size and digest above are not.
INSTALL_ROOT=${ARCHTREE_FFMPEG_INSTALL_ROOT:-/opt/archtree-ffmpeg}
BIN_DIR=${ARCHTREE_FFMPEG_BIN_DIR:-/usr/local/bin}
CURL=${ARCHTREE_CURL_BIN:-curl}
SHA256SUM=${ARCHTREE_SHA256SUM_BIN:-sha256sum}
TAR=${ARCHTREE_TAR_BIN:-tar}
XZ=${ARCHTREE_XZ_BIN:-xz}
DNF=${ARCHTREE_DNF_BIN:-dnf}
MACHINE=${ARCHTREE_FFMPEG_MACHINE:-$(uname -m)}

log() {
  printf '[archtree-ffmpeg] %s\n' "$*"
}

fail() {
  printf '[archtree-ffmpeg] ERROR: %s\n' "$*" >&2
  exit 1
}

# t4g instances are Graviton (aarch64). The x86_64 pin keeps a later instance
# type change from breaking deployments; any other machine fails loudly.
case "${MACHINE}" in
  aarch64|arm64)
    ARCHIVE=${ARM64_ARCHIVE}
    ARCHIVE_BYTES=${ARM64_ARCHIVE_BYTES}
    ARCHIVE_SHA256=${ARM64_ARCHIVE_SHA256}
    ;;
  x86_64|amd64)
    ARCHIVE=${X86_64_ARCHIVE}
    ARCHIVE_BYTES=${X86_64_ARCHIVE_BYTES}
    ARCHIVE_SHA256=${X86_64_ARCHIVE_SHA256}
    ;;
  *)
    fail "No pinned FFmpeg build exists for machine '${MACHINE}'. Add a verified pin to this hook."
    ;;
esac

ARCHIVE_URL="${FFMPEG_RELEASE_BASE_URL}/${FFMPEG_RELEASE_TAG}/${ARCHIVE}"
VERSION_DIR="${INSTALL_ROOT}/${ARCHIVE%.tar.xz}"
MARKER="${VERSION_DIR}/.archive-sha256"
WORK_DIR=''

cleanup() {
  if [[ -n "${WORK_DIR}" ]]; then
    rm -rf -- "${WORK_DIR}"
  fi
}
trap cleanup EXIT

# Mirrors scripts/check-runtime.mjs: the restricted decoder needs the AAC and MP3
# decoders, MOV and MP3 demuxers, the null muxer, PCM s16le and file/pipe input.
# Output is captured before matching so an early grep exit cannot SIGPIPE FFmpeg.
decoder_capable() {
  local binary=$1 version decoders demuxers muxers encoders protocols
  version=$("${binary}" -hide_banner -version 2>/dev/null) || return 1
  decoders=$("${binary}" -hide_banner -decoders 2>/dev/null) || return 1
  demuxers=$("${binary}" -hide_banner -demuxers 2>/dev/null) || return 1
  muxers=$("${binary}" -hide_banner -muxers 2>/dev/null) || return 1
  encoders=$("${binary}" -hide_banner -encoders 2>/dev/null) || return 1
  protocols=$("${binary}" -hide_banner -protocols 2>/dev/null) || return 1
  grep -Eq '^ffmpeg version [^[:space:]]+' <<<"${version}" || return 1
  grep -Eq '[[:space:]]aac[[:space:]]' <<<"${decoders}" || return 1
  grep -Eq '[[:space:]]mp3(float)?[[:space:]]' <<<"${decoders}" || return 1
  grep -Eq '[[:space:]]mov,mp4,m4a,3gp,3g2,mj2[[:space:]]' <<<"${demuxers}" || return 1
  grep -Eq '[[:space:]]mp3[[:space:]]' <<<"${demuxers}" || return 1
  grep -Eq '[[:space:]]null[[:space:]]' <<<"${muxers}" || return 1
  grep -Eq '[[:space:]]pcm_s16le[[:space:]]' <<<"${encoders}" || return 1
  grep -Eq '^[[:space:]]+file[[:space:]]*$' <<<"${protocols}" || return 1
  grep -Eq '^[[:space:]]+pipe[[:space:]]*$' <<<"${protocols}" || return 1
}

ffprobe_runs() {
  local version
  version=$("$1" -hide_banner -version 2>/dev/null) || return 1
  grep -Eq '^ffprobe version [^[:space:]]+' <<<"${version}"
}

# A version directory counts as installed only after its binaries were verified
# and the marker recorded the digest they came from; anything else is rebuilt.
installed() {
  [[ -f "${MARKER}" && -x "${VERSION_DIR}/ffmpeg" && -x "${VERSION_DIR}/ffprobe" ]] || return 1
  [[ "$(cat "${MARKER}")" == "${ARCHIVE_SHA256}" ]] || return 1
  decoder_capable "${VERSION_DIR}/ffmpeg" && ffprobe_runs "${VERSION_DIR}/ffprobe"
}

# Exactly one bin/<name> member, at most one directory below the archive root.
# The digest already fixes the bytes; this only tolerates listing conventions.
archive_member() {
  local members=$1 name=$2 matches
  matches=$(grep -E "^(\./)?([^/]+/)?bin/${name}\$" <<<"${members}" || true)
  [[ -n "${matches}" && "$(grep -c '' <<<"${matches}")" == '1' ]] || return 1
  printf '%s' "${matches}"
}

ensure_xz() {
  if command -v "${XZ}" >/dev/null 2>&1; then
    return 0
  fi
  log "xz is unavailable; installing it with dnf to extract the FFmpeg archive."
  if ! command -v "${DNF}" >/dev/null 2>&1 || ! "${DNF}" install -y xz; then
    fail "xz could not be installed, so the FFmpeg archive cannot be extracted."
  fi
  command -v "${XZ}" >/dev/null 2>&1 || fail "xz is still unavailable after installation."
}

download_and_install() {
  local archive members ffmpeg_member ffprobe_member actual_bytes actual_sha256 stage
  ensure_xz
  install -d -m 0755 "${INSTALL_ROOT}"
  # Staging inside the install root keeps the final rename on one filesystem.
  WORK_DIR=$(mktemp -d "${INSTALL_ROOT}/.download.XXXXXX")
  archive="${WORK_DIR}/ffmpeg.tar.xz"

  log "Downloading ${ARCHIVE} from ${FFMPEG_RELEASE_TAG}."
  if ! "${CURL}" --fail --silent --show-error --location \
    --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --connect-timeout 20 --max-time 900 --retry 3 --retry-delay 5 \
    --max-filesize "${ARCHIVE_BYTES}" \
    --output "${archive}" "${ARCHIVE_URL}"; then
    fail "Downloading the pinned FFmpeg archive failed; the deployment stops so the decoder is not left missing."
  fi

  actual_bytes=$(wc -c <"${archive}" | tr -d '[:space:]')
  if [[ "${actual_bytes}" != "${ARCHIVE_BYTES}" ]]; then
    fail "FFmpeg archive size mismatch: expected ${ARCHIVE_BYTES} bytes, received ${actual_bytes}. Refusing to install."
  fi
  actual_sha256=$("${SHA256SUM}" "${archive}" | cut -d ' ' -f 1)
  if [[ "${actual_sha256}" != "${ARCHIVE_SHA256}" ]]; then
    fail "FFmpeg archive SHA-256 mismatch: expected ${ARCHIVE_SHA256}, received ${actual_sha256}. Refusing to install."
  fi
  log "Verified SHA-256 ${ARCHIVE_SHA256}."

  # Extract only the two executables; nothing else from the archive is needed.
  members=$("${TAR}" -tJf "${archive}") || fail "The verified FFmpeg archive could not be listed."
  ffmpeg_member=$(archive_member "${members}" ffmpeg) \
    || fail "The verified FFmpeg archive does not contain exactly one bin/ffmpeg."
  ffprobe_member=$(archive_member "${members}" ffprobe) \
    || fail "The verified FFmpeg archive does not contain exactly one bin/ffprobe."
  install -d -m 0700 "${WORK_DIR}/extract"
  "${TAR}" -xJf "${archive}" -C "${WORK_DIR}/extract" "${ffmpeg_member}" "${ffprobe_member}" \
    || fail "The verified FFmpeg archive could not be extracted."
  rm -f -- "${archive}"

  stage="${WORK_DIR}/stage"
  install -d -m 0755 "${stage}"
  install -m 0755 "${WORK_DIR}/extract/${ffmpeg_member}" "${stage}/ffmpeg"
  install -m 0755 "${WORK_DIR}/extract/${ffprobe_member}" "${stage}/ffprobe"
  decoder_capable "${stage}/ffmpeg" \
    || fail "The pinned FFmpeg build does not run here or lacks the room audio decoding capabilities."
  ffprobe_runs "${stage}/ffprobe" || fail "The pinned ffprobe build does not run on this instance."
  printf '%s\n' "${ARCHIVE_SHA256}" >"${stage}/.archive-sha256"

  # A leftover directory without a valid marker is an interrupted install.
  rm -rf -- "${VERSION_DIR}"
  mv -- "${stage}" "${VERSION_DIR}"
  log "Installed ${ARCHIVE%.tar.xz} in ${INSTALL_ROOT}."
}

# Swaps each command path with a rename, so a running decode or a concurrent
# lookup sees either the previous or the new executable, never a missing one.
link_command() {
  local name=$1 target="${BIN_DIR}/$1" temporary
  if [[ -d "${target}" ]]; then
    fail "${target} is a directory; remove it so the pinned ${name} can be linked."
  fi
  if [[ -e "${target}" && ! -L "${target}" ]]; then
    log "Replacing the unmanaged ${target} with the pinned ${name}."
  fi
  temporary="${BIN_DIR}/.${name}.archtree-$$"
  rm -f -- "${temporary}"
  ln -s "${VERSION_DIR}/${name}" "${temporary}"
  mv -f -- "${temporary}" "${target}"
}

if installed; then
  log "Pinned ${ARCHIVE%.tar.xz} is already installed."
else
  download_and_install
fi

install -d -m 0755 "${BIN_DIR}"
link_command ffmpeg
link_command ffprobe
decoder_capable "${BIN_DIR}/ffmpeg" || fail "${BIN_DIR}/ffmpeg does not resolve to a capable decoder."

# Previous pins and interrupted downloads are owned by this hook alone.
for entry in "${INSTALL_ROOT}"/ffmpeg-* "${INSTALL_ROOT}"/.download.*; do
  if [[ -e "${entry}" && "${entry}" != "${VERSION_DIR}" && "${entry}" != "${WORK_DIR}" ]]; then
    rm -rf -- "${entry}"
  fi
done

log "Room audio decoder ready at ${BIN_DIR}/ffmpeg."
