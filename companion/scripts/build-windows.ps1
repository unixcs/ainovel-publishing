$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install ".[dev]"
.\.venv\Scripts\python.exe -m pytest tests
.\.venv\Scripts\pyinstaller.exe `
  --name ainovel-publisher `
  --onefile `
  --clean `
  --paths .\src `
  --collect-all paramiko `
  --collect-all uvicorn `
  --collect-all fastapi `
  --collect-all tzdata `
  .\packaging\entrypoint.py

Write-Host "Built: $Root\dist\ainovel-publisher.exe"
