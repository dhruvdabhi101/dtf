# Builds DTFFixture.exe — the sample app the framework's own tests drive on Windows.
# Output: fixtures/tray-app-win/bin/DTFFixture.exe (self-contained, single file).
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $repoRoot 'native\windows\find-dotnet.ps1')
$dotnet = Find-Dotnet

& $dotnet publish DTFFixture.csproj -c Release -o bin --nologo -v quiet
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE" }
Write-Host "built $(Join-Path $PSScriptRoot 'bin\DTFFixture.exe')"
