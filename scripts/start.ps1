$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$portableNode = Resolve-Path -LiteralPath (Join-Path $root "..\automatizacion-estrategia-seo\node-v22.14.0-win-x64\node.exe") -ErrorAction SilentlyContinue

if ($portableNode) {
  & $portableNode.Path (Join-Path $root "server.mjs")
} else {
  node (Join-Path $root "server.mjs")
}
