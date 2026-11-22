# Registers MySQL 8.4 as a Windows service (MySQL84) so it starts automatically with Windows.
# Run ONCE from an elevated PowerShell (right-click -> "Run as administrator"):
#   powershell -ExecutionPolicy Bypass -File scripts\install_mysql_service.ps1
#
# If mysqld is currently running from scripts\start_mysql.bat, stop it first (Ctrl+C).

$ini    = "C:\ProgramData\MySQL\MySQL Server 8.4\my.ini"
$mysqld = "C:\Program Files\MySQL\MySQL Server 8.4\bin\mysqld.exe"

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "Please run this script as Administrator."; exit 1
}
if (Get-Service -Name MySQL84 -ErrorAction SilentlyContinue) {
    Write-Host "Service MySQL84 already exists."
} else {
    & $mysqld --install MySQL84 --defaults-file="$ini"
    if ($LASTEXITCODE -ne 0) { Write-Error "mysqld --install failed ($LASTEXITCODE)"; exit 1 }
}
Set-Service -Name MySQL84 -StartupType Automatic
Start-Service -Name MySQL84
Get-Service -Name MySQL84 | Format-List Name, Status, StartType
