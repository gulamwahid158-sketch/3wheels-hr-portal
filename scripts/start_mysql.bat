@echo off
REM Starts the local MySQL 8.4 server in this window (use when the Windows service is not installed).
REM Close the window or press Ctrl+C to stop it.
"C:\Program Files\MySQL\MySQL Server 8.4\bin\mysqld.exe" --defaults-file="C:\ProgramData\MySQL\MySQL Server 8.4\my.ini" --console
