param(
  [string]$Folder = "אבות האומה",
  [string]$File = "2024.05.09 #1 כללים במקום חוקים.opus",
  [string]$Base = "http://localhost:5000"
)

Write-Host "== Self Test ==" -ForegroundColor Cyan
Write-Host "Folder:" $Folder
Write-Host "File  :" $File
Write-Host "Base  :" $Base

function UrlEncode($s) { return [uri]::EscapeDataString($s) }

try {
  Write-Host "\n1) /episode (should be 200 and include audioUrl)" -ForegroundColor Yellow
  $ep = Invoke-RestMethod -Uri ("$Base/episode?folder="+(UrlEncode $Folder)+"&file="+(UrlEncode $File)) -Method GET -ErrorAction Stop
  $audioUrl = $ep.audioUrl
  Write-Host "episode OK, audioUrl=" $audioUrl
} catch {
  Write-Host "episode ERR:" $_.Exception.Message -ForegroundColor Red
}

$folderEnc = UrlEncode $Folder
$fileEnc   = UrlEncode $File
$audio = "$Base/audio/$folderEnc/$fileEnc"
Write-Host "\n2) /audio (HEAD) =>" $audio -ForegroundColor Yellow
try {
  $head = Invoke-WebRequest -Uri $audio -Method Head -ErrorAction Stop
  Write-Host "HEAD OK  | Status:" $head.StatusCode "CT:" $head.Headers.'Content-Type'
} catch {
  Write-Host "HEAD ERR:" $_.Exception.Message -ForegroundColor Red
}

Write-Host "\n3) /audio Range 0-1023 (bytes)" -ForegroundColor Yellow
try {
  $range = Invoke-WebRequest -Uri $audio -Method Get -Headers @{ Range='bytes=0-1023' } -ErrorAction Stop
  $len = $range.RawContentLength
  Write-Host "RANGE OK | Bytes:" $len
  if ($len -lt 200) {
    Write-Warning "Very small response (<200B). This often indicates a tiny pointer file rather than real audio."
  }
} catch {
  Write-Host "RANGE ERR:" $_.Exception.Message -ForegroundColor Red
}

Write-Host "\n4) Debug resolver (dev-only)" -ForegroundColor Yellow
try {
  $dbg = Invoke-RestMethod -Uri ("$Base/debug/audio/resolve?folder="+(UrlEncode $Folder)+"&file="+(UrlEncode $File)) -Method GET -ErrorAction Stop
  $dbg | ConvertTo-Json -Depth 5
} catch {
  Write-Host "DEBUG ERR (expected if not in dev):" $_.Exception.Message -ForegroundColor DarkYellow
}

Write-Host "\nDone." -ForegroundColor Cyan

