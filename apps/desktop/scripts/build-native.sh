#!/usr/bin/env bash
# Build roger-audio, Roger's Swift audio helper, for this Mac's CPU into native/bin/roger-audio.
# `make native` runs it, and so does `make check` on a Mac before it runs `roger-audio selftest`.
# Bundling and signing the binary inside Roger.app is scripts/install-mac.sh's job, not this one's.
#
# Command Line Tools only: swiftc, no Xcode project and no SwiftPM. Language mode 5 on purpose:
# Swift 6 mode's strict concurrency checking flags every Core Audio C callback and the ring the IO
# thread shares with the writer thread, which are guarded by hand (see RingBuffer.swift). The
# deployment target is the first macOS with process taps (14.2). A universal binary is M11.
set -euo pipefail

readonly script_path="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/.."
readonly src_dir="native/roger-audio"
readonly out="native/bin/roger-audio"
readonly stamp="$out.inputs"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-native: roger-audio builds on macOS only" >&2
  exit 1
fi
case "$(uname -m)" in
  arm64 | x86_64) arch="$(uname -m)" ;;
  *)
    echo "build-native: unsupported architecture $(uname -m)" >&2
    exit 1
    ;;
esac

sources=("$src_dir"/*.swift)
flags=(-swift-version 5 -O -target "$arch-apple-macosx14.2" -module-name RogerAudio)

# `make check` runs this on every pass, and an optimised build takes a while: skip it when nothing
# changed. "Nothing" is the compiler, the flags and the source list (a deleted or added file leaves
# no newer mtime behind) plus no source or this script newer than the binary.
inputs="$(swiftc --version 2>&1; echo "${flags[*]}"; printf '%s\n' "${sources[@]}")"
if [[ -x "$out" && -f "$stamp" && "$(cat "$stamp")" == "$inputs" &&
  -z "$(find "$src_dir" "$script_path" -newer "$out" -print -quit)" ]]; then
  echo "build-native: $out is up to date"
  exit 0
fi

mkdir -p "$(dirname "$out")"
echo "==> Building $out ($arch, macOS 14.2+)"
# Compile to a temporary name: a failed build must never leave a binary the next run calls current.
swiftc "${flags[@]}" -sdk "$(xcrun --show-sdk-path)" -o "$out.partial" "${sources[@]}"
mv -f "$out.partial" "$out"
printf '%s' "$inputs" >"$stamp"
