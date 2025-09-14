param(
  [string]$DataDir = ".",
  [switch]$Dev = $true
)
# Activate local venv if present (optional)
$venvActivate = Join-Path $PSScriptRoot ".venv\Scripts\Activate.ps1"
if (Test-Path $venvActivate) {
  Write-Host "Activating virtualenv: $venvActivate"
  . $venvActivate
}
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
  Write-Warning "Python not found on PATH. Please install Python 3.10+ and re-run."
}
$argsList = @("explore\run.py", "--data-dir", $DataDir)
if ($Dev) { $argsList += "--dev" }
Write-Host ("Running: python {0}" -f ($argsList -join ' '))
python @argsList
