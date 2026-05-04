$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$candidates = @(
    (Join-Path $scriptDir ".venv\Scripts\python.exe"),
    (Join-Path (Split-Path -Parent $scriptDir) ".venv\Scripts\python.exe")
)

$pythonExe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $pythonExe) {
    throw "Could not find a project virtualenv Python. Expected one of: $($candidates -join ', ')"
}

Write-Host "Using Python:" $pythonExe
& $pythonExe (Join-Path $scriptDir "main.py") @args
