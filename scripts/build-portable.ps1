$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputsRoot = Join-Path $sourceRoot 'dist'
$package = Get-Content -LiteralPath (Join-Path $sourceRoot 'package.json') -Raw | ConvertFrom-Json
if ($package.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid package version' }
$cacheRoot = if ($env:APPLE_STOCK_RUNTIME_CACHE) { [IO.Path]::GetFullPath($env:APPLE_STOCK_RUNTIME_CACHE) } else { Join-Path $sourceRoot '.cache\electron-runtime' }
$verification = Get-Content -LiteralPath (Join-Path $cacheRoot 'runtime-verified.json') -Raw | ConvertFrom-Json
$runtimeZip = Join-Path $cacheRoot $verification.name
if ((Get-FileHash -LiteralPath $runtimeZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $verification.sha256) { throw 'Runtime checksum mismatch' }
$target = [IO.Path]::GetFullPath((Join-Path $outputsRoot ('AppleStockMonitor-Windows-v' + $package.version + '-portable')))
if (-not $target.StartsWith($outputsRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Target is outside outputs' }
if (Test-Path -LiteralPath $target) { throw 'Portable folder already exists. Do not overwrite a frozen build.' }
New-Item -ItemType Directory -Path $outputsRoot -Force | Out-Null
Expand-Archive -LiteralPath $runtimeZip -DestinationPath $target
$exe = Join-Path $target 'electron.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw 'Runtime EXE missing' }
Rename-Item -LiteralPath $exe -NewName 'AppleStockMonitor.exe'
$appRoot = Join-Path $target 'resources\app'
New-Item -ItemType Directory -Path $appRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceRoot 'package.json') -Destination $appRoot
Copy-Item -LiteralPath (Join-Path $sourceRoot 'desktop') -Destination $appRoot -Recurse
New-Item -ItemType Directory -Path (Join-Path $appRoot 'extension') | Out-Null
Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'extension') -File | Where-Object { $_.Name -notmatch '\.test\.js$|^pnpm-lock\.yaml$|^check\.mjs$' } | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $appRoot 'extension')
}
Copy-Item -LiteralPath (Join-Path $sourceRoot 'extension\data') -Destination (Join-Path $appRoot 'extension') -Recurse
Copy-Item -LiteralPath (Join-Path $sourceRoot 'extension\icons') -Destination (Join-Path $appRoot 'extension') -Recurse
Copy-Item -LiteralPath (Join-Path $sourceRoot 'Windows使用说明.md') -Destination $target
Copy-Item -LiteralPath (Join-Path $sourceRoot 'extension\LICENSE') -Destination (Join-Path $target 'LICENSE-GPL-3.0.txt')
Copy-Item -LiteralPath (Join-Path $cacheRoot 'runtime-verified.json') -Destination $target
Write-Output ('Portable build: ' + $target)
