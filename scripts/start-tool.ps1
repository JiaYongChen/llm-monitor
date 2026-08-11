<#
.SYNOPSIS
  通过 llm-monitor 代理启动 Claude Code / Codex CLI 工具

.EXAMPLE
  llm-monitor Claude D:\my-project
  llm-monitor codex
#>
param(
  [Parameter(Position = 0, Mandatory = $true)]
  [ValidateSet('Claude', 'ClaudeCode', 'codex')]
  [string]$Tool,

  [Parameter(Position = 1)]
  [string]$Project,

  [int]$Port = 9400
)

$ErrorActionPreference = 'Stop'

# 标准化工具名
$Tool = if ($Tool -eq 'Claude') { 'ClaudeCode' } else { $Tool }

# 项目目录
if (-not $Project) {
  $Project = Get-Location
}
$Project = Resolve-Path $Project

Write-Host "=== llm-monitor 代理启动 ===" -ForegroundColor Cyan
Write-Host "  工具: $Tool" -ForegroundColor Gray
Write-Host "  项目: $Project" -ForegroundColor Gray
Write-Host "  代理: http://localhost:$Port" -ForegroundColor Gray

# 预创建 pending 会话
try {
  $body = @{ tool = $Tool } | ConvertTo-Json
  $result = Invoke-RestMethod -Uri "http://localhost:$Port/proxy/sessions/start" -Method Post -Body $body -ContentType 'application/json' -ErrorAction SilentlyContinue
  if ($result) {
    Write-Host "  会话: #$($result.id) ($($result.status))" -ForegroundColor Green
  }
} catch {
  Write-Host "  会话预创建失败（代理可能未启动）" -ForegroundColor Yellow
}

# 设置代理环境变量并启动工具
$env:LLM_MONITOR_PORT = $Port.ToString()
$env:LLM_MONITOR_TOOL = $Tool

switch ($Tool) {
  'ClaudeCode' {
    $env:ANTHROPIC_BASE_URL = "http://localhost:$Port/anthropic"
    Write-Host "  启动 Claude Code..." -ForegroundColor Gray
    Push-Location $Project
    try {
      claude
    } finally {
      Pop-Location
    }
  }
  'codex' {
    $env:OPENAI_BASE_URL = "http://localhost:$Port/openai"
    Write-Host "  启动 Codex..." -ForegroundColor Gray
    Push-Location $Project
    try {
      codex
    } finally {
      Pop-Location
    }
  }
}
