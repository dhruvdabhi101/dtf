# Builds dtfd-windows.exe — the native driver the Windows dtf driver talks to.
# Output: native/windows/bin/dtfd-windows.exe (self-contained, single file, so a
# runner needs no particular .NET runtime installed to *run* it; only building
# needs the SDK).
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

. (Join-Path $PSScriptRoot 'find-dotnet.ps1')
$dotnet = Find-Dotnet

& $dotnet publish dtfd-windows.csproj -c Release -o bin --nologo -v quiet
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE" }
Write-Host "built $(Join-Path $PSScriptRoot 'bin\dtfd-windows.exe')"
