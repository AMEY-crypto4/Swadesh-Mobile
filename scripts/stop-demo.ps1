# Stops any previous copy of the app and its embedded databases (matches by command line, never touches other programs).
Get-CimInstance Win32_Process |
  Where-Object { ($_.Name -match '^(node|mysqld|mongod)') -and ($_.CommandLine -match 'swadesh-cc|mysqlmsn|mongo-mem') -and ($_.ProcessId -ne $PID) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
