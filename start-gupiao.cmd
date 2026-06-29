@echo off
setlocal
chcp 65001 >nul

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js first.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Please install Node.js with npm first.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo Starting stock forecast app...
start "gupiao-dev-server" cmd /k "cd /d "%~dp0" && npm run dev"

echo Waiting for http://localhost:5173 ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ok=$false; for($i=0;$i -lt 30;$i++){ try { $r=Invoke-WebRequest -Uri 'http://localhost:5173/' -UseBasicParsing -TimeoutSec 1; if($r.StatusCode -eq 200){ $ok=$true; break } } catch {}; Start-Sleep -Seconds 1 }; if($ok){ Start-Process ('http://localhost:5173/?t=' + [DateTimeOffset]::Now.ToUnixTimeMilliseconds()) } else { Write-Host 'Server did not become ready. Check the gupiao-dev-server window.'; exit 1 }"

if errorlevel 1 (
  pause
  exit /b 1
)

endlocal
