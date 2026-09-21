class SmartRouter < Formula
  desc "Routes coding-agent tasks to configured harnesses"
  homepage "https://github.com/aschi-marksetai/smart-router"
  version "0.1.0"
  on_macos do
    on_arm do
      url "https://github.com/aschi-marksetai/smart-router/releases/download/v#{version}/smart-router-darwin-arm64"
      sha256 "REPLACE_SHA256_DARWIN_ARM64"
    end
    on_intel do
      url "https://github.com/aschi-marksetai/smart-router/releases/download/v#{version}/smart-router-darwin-x64"
      sha256 "REPLACE_SHA256_DARWIN_X64"
    end
  end
  on_linux do
    on_arm do
      url "https://github.com/aschi-marksetai/smart-router/releases/download/v#{version}/smart-router-linux-arm64"
      sha256 "REPLACE_SHA256_LINUX_ARM64"
    end
    on_intel do
      url "https://github.com/aschi-marksetai/smart-router/releases/download/v#{version}/smart-router-linux-x64"
      sha256 "REPLACE_SHA256_LINUX_X64"
    end
  end
  def install
    bin.install Dir["smart-router-*"][0] => "smart-router"
  end

  test do
    system bin/"smart-router", "--version"
  end

  def caveats
    "Run `smart-router install-skill` and `smart-router init`."
  end
end
