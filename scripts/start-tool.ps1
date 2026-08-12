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
$sessionId = $null
try {
  $body = @{ tool = $Tool } | ConvertTo-Json
  $result = Invoke-RestMethod -Uri "http://localhost:$Port/proxy/sessions/start" -Method Post -Body $body -ContentType 'application/json' -ErrorAction SilentlyContinue
  if ($result) {
    $sessionId = $result.id
    Write-Host "  会话: #$sessionId ($($result.status))" -ForegroundColor Green
  }
} catch {
  Write-Host "  会话预创建失败（代理可能未启动）" -ForegroundColor Yellow
}

# 设置代理环境变量并启动工具（会话 ID 嵌入 URL 确保同终端复用）
$env:LLM_MONITOR_PORT = $Port.ToString()
$env:LLM_MONITOR_TOOL = $Tool

switch ($Tool) {
  'ClaudeCode' {
    if ($sessionId) {
      $env:ANTHROPIC_BASE_URL = "http://localhost:$Port/s/$sessionId/ClaudeCode"
    } else {
      $env:ANTHROPIC_BASE_URL = "http://localhost:$Port/ClaudeCode"
    }
    $env:ANTHROPIC_AUTH_TOKEN = 'llm-monitor'  # Claude Code CLI
    Write-Host "  启动 Claude Code..." -ForegroundColor Gray
    Push-Location $Project
    try {
      claude
    } finally {
      Pop-Location
    }
  }
  'codex' {
    # Codex 不支持 OPENAI_BASE_URL 环境变量，只能通过 config.toml 配置
    $codexHome = "$env:USERPROFILE\.codex"
    $configPath = "$codexHome\config.toml"
    New-Item -ItemType Directory -Force $codexHome | Out-Null
    $baseUrl = if ($sessionId) { "http://localhost:$Port/s/$sessionId/codex" } else { "http://localhost:$Port/codex" }
    $toml = @"
model_provider = "LLM-Monitor"
preferred_auth_method = "apikey"
forced_login_method = "api"

[model_providers.LLM-Monitor]
name = "LLM-Monitor"
base_url = "$baseUrl"
experimental_bearer_token = "llm-monitor"
wire_api = "responses"
"@
    Set-Content -Path $configPath -Value $toml -Encoding UTF8 -Force
    Write-Host "  已写入 Codex 代理配置: $configPath" -ForegroundColor Gray
    Write-Host "    base_url = $baseUrl" -ForegroundColor Gray
    Write-Host "  启动 Codex..." -ForegroundColor Gray
    Push-Location $Project
    try {
      codex
    } finally {
      Pop-Location
    }
  }
}
