# Locates a .NET 8+ SDK. Dot-source this and call Find-Dotnet.
#
# `dotnet` is normally on PATH after an installer run. The dotnet-install
# script (the no-admin route, and what CI images often use) puts it under
# %LOCALAPPDATA%\Microsoft\dotnet without touching PATH, so that is checked too.
function Find-Dotnet {
    $candidates = @()
    $onPath = Get-Command dotnet -ErrorAction SilentlyContinue
    if ($onPath) { $candidates += $onPath.Source }
    if ($env:DOTNET_ROOT) { $candidates += (Join-Path $env:DOTNET_ROOT 'dotnet.exe') }
    $candidates += (Join-Path $env:ProgramFiles 'dotnet\dotnet.exe')
    $candidates += (Join-Path $env:LOCALAPPDATA 'Microsoft\dotnet\dotnet.exe')

    foreach ($c in $candidates) {
        if (-not ($c -and (Test-Path $c))) { continue }
        $sdks = & $c --list-sdks 2>$null
        if ($sdks -and ($sdks | Where-Object { $_ -match '^(8|9|[1-9]\d)\.' })) { return $c }
    }
    throw @"
No .NET 8 (or newer) SDK was found. Install it with one of:
  winget install Microsoft.DotNet.SDK.8
  Invoke-WebRequest https://dot.net/v1/dotnet-install.ps1 -OutFile dotnet-install.ps1; .\dotnet-install.ps1 -Channel 8.0
"@
}
