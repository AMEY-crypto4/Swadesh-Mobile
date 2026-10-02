# Waits until the server answers, then opens Chrome and Edge on the login page and prints the LAN address.
$url = 'http://localhost:4000'
for ($i = 0; $i -lt 150; $i++) {
  try { if ((Invoke-WebRequest "$url/healthz" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { break } } catch {}
  Start-Sleep -Seconds 2
}
function Open-In($exe, $paths) {
  foreach ($p in $paths) { if (Test-Path $p) { Start-Process $p $url; return } }
  Start-Process $url   # fall back to the default browser
}
Open-In 'chrome' @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")
Open-In 'edge'   @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")
