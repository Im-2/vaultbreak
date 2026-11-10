# One command to (re)publish the backend from this machine:
#   powershell -ExecutionPolicy Bypass -File scripts/serve-public.ps1
# 1. stops any old stack/tunnel, 2. starts the stack in WSL (sandbox + contracts + seeded Guardians + API on :8787) as a
# hidden background process, 3. opens a free Cloudflare quick tunnel (no account), 4. writes the tunnel URL into the
# rewrite in web/vercel.json and redeploys the site. The Vercel domain is the stable public address; only the tunnel
# behind it changes on every restart. Secrets (model key) are read by the backend from the gitignored .env, never by the website.
param([string]$PublicBase = "https://vaultbreak-orpin.vercel.app", [switch]$NoDeploy, [switch]$Reuse)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $repo ".serve"; New-Item -ItemType Directory -Force $logs | Out-Null
$cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cf) { $cf = "C:\Program Files (x86)\cloudflared\cloudflared.exe" }

Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
function WslIp { (wsl -d Ubuntu -- hostname -I).Trim().Split(" ")[0] }
if ($Reuse) { Write-Host "[serve] reusing the running backend" } else {
Write-Host "[serve] stopping old processes"
wsl -d Ubuntu -- bash -lc "ss -ltnp 2>/dev/null | grep ':8787' | grep -o 'pid=[0-9]*' | cut -d= -f2 | xargs -r kill -9; pkill -f '[n]ear-sandbox'; true" | Out-Null

Write-Host "[serve] starting the stack in WSL (full seed takes a few minutes)"
$lin = (wsl -d Ubuntu -- wslpath -a $repo.Replace('\', '/')).Trim()
$cmd = ". ~/.cargo/env 2>/dev/null; export CARGO_TARGET_DIR=`$HOME/.vb-target; cd '$lin' && PUBLIC_BASE_URL='$PublicBase' bash scripts/dev.sh --no-web > /tmp/vb-api.log 2>&1"
Start-Process wsl.exe -WindowStyle Hidden -ArgumentList @("-d", "Ubuntu", "--", "bash", "-lc", "`"$cmd`"")
}

$ip = WslIp   # Windows localhost does not reach WSL here, so use the WSL address
$up = $false
for ($i = 0; $i -lt 180; $i++) {
  Start-Sleep 5
  try { $s = Invoke-RestMethod "http://${ip}:8787/stats" -TimeoutSec 3; if ($s.guardians -ge 1) { $up = $true; break } } catch {}
}
if (-not $up) { throw "backend did not come up; see: wsl -d Ubuntu -- tail -50 /tmp/vb-api.log" }
Write-Host "[serve] backend is up ($($s.guardians) Guardians)"

Write-Host "[serve] opening the tunnel"
$tlog = Join-Path $logs "tunnel.log"; Remove-Item $tlog -ErrorAction SilentlyContinue
Start-Process $cf -WindowStyle Hidden -ArgumentList @("tunnel", "--no-autoupdate", "--protocol", "http2", "--url", "http://${ip}:8787", "--logfile", $tlog)
$tunnel = $null
for ($i = 0; $i -lt 40 -and -not $tunnel; $i++) {
  Start-Sleep 2
  if (Test-Path $tlog) { $m = Select-String -Path $tlog -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" | Select-Object -First 1; if ($m) { $tunnel = $m.Matches[0].Value } }
}
if (-not $tunnel) { throw "no tunnel URL; see $tlog" }
Write-Host "[serve] tunnel: $tunnel"
Start-Sleep 4
try { Invoke-RestMethod "$tunnel/stats" -TimeoutSec 15 | Out-Null } catch { Write-Host "[serve] note: tunnel not answering yet ($($_.Exception.Message))" }

$vj = Join-Path $repo "web\vercel.json"
$json = Get-Content $vj -Raw
$json = [regex]::Replace($json, '"destination": "https://[^"]*/:path\*"', "`"destination`": `"$tunnel/:path*`"")
[IO.File]::WriteAllText($vj, $json, (New-Object Text.UTF8Encoding $false))
if ($NoDeploy) { Write-Host "[serve] vercel.json updated; skipping deploy"; exit 0 }
Push-Location (Join-Path $repo "web")
$ErrorActionPreference = "Continue"; try { cmd /c "vercel deploy --prod --yes 2>&1" | Select-String "Production|Aliased|rror" } finally { Pop-Location }
Write-Host "[serve] done. Site: $PublicBase  (backend via $tunnel)"
