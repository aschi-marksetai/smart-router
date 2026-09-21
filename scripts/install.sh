#!/bin/sh
set -eu
repo=aschi-marksetai/smart-router
os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
[ "$os" = darwin ] || [ "$os" = linux ] || { echo "Unsupported OS: $os" >&2; exit 1; }
case "$arch" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
esac
asset="smart-router-$os-$arch"
base="https://github.com/$repo/releases/latest/download"
target_dir=${INSTALL_DIR:-"$HOME/.local/bin"}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$base/$asset" -o "$tmp/$asset"
curl -fsSL "$base/$asset.sha256" -o "$tmp/$asset.sha256"
(cd "$tmp" && sha256sum -c "$asset.sha256" 2>/dev/null || shasum -a 256 -c "$asset.sha256")
mkdir -p "$target_dir"
install -m 755 "$tmp/$asset" "$target_dir/smart-router"
"$target_dir/smart-router" install-skill
case ":${PATH}:" in *":$target_dir:"*) ;; *) echo "Add $target_dir to PATH" ;; esac
echo "Next: run smart-router init"
