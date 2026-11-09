@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
set "PSMETAC_EXE=%~dp0..\..\psmetac.exe"
set "PSMETAC_MCP=%~dp0..\mcp-runtime\src\mcp.ts"

if not exist "%PSMETAC_EXE%" (
  echo PSMetaC executable was not found. 1>&2
  exit /b 2
)
if not exist "%PSMETAC_MCP%" (
  echo PSMetaC MCP runtime was not found. 1>&2
  exit /b 3
)

"%PSMETAC_EXE%" "%PSMETAC_MCP%" %*
exit /b %errorlevel%
