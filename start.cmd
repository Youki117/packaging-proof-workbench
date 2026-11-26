@echo off
start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "$url='http://127.0.0.1:8774/'; for($i=0; $i -lt 30; $i++){try {Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1 -ErrorAction Stop | Out-Null; Start-Process $url; exit} catch {Start-Sleep -Milliseconds 300}}"
node "%~dp0server.mjs"
pause
