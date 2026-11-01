{
  description = "develapar-video: Desktop app to auto-generate videos with Google Flow (Tauri v2 + Bun Engine)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            rustc
            cargo
            nodejs_22
            bun
            ffmpeg
            pkg-config
          ] ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isDarwin [
            pkgs.apple-sdk_15
          ];

          shellHook = ''
            export APP_NAME="develapar-video"
            export FLOW_MCP_FFMPEG="${pkgs.ffmpeg}/bin/ffmpeg"
          '';
        };
      }
    );
}
