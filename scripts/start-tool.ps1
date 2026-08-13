<#
.SYNOPSIS
  通过 llm-monitor 代理启动 Claude Code / Codex CLI 工具

.EXAMPLE
  llm-monitor Claude D:\my-project
  llm-monitor codex
  llm-monitor chatgpt
#>
param(
  [Parameter(Position = 0, Mandatory = $true)]
  [ValidateSet('Claude', 'ClaudeCode', 'Codex', 'ChatGPT')]  # ValidateSet 大小写不敏感
  [string]$Tool,

  [Parameter(Position = 1)]
  [string]$Project,

  [int]$Port = 9400
)

$ErrorActionPreference = 'Stop'

# 标准化工具名（大小写不敏感；ChatGPT 视为 Codex）
$Tool = switch ($Tool.ToLower()) {
  'claude'     { 'ClaudeCode' }
  'claudecode' { 'ClaudeCode' }
  'codex'      { 'Codex' }
  'chatgpt'    { 'Codex' }
  default      { $Tool }
}

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
  'Codex' {
    # Codex 不支持 OPENAI_BASE_URL 环境变量，只能通过 config.toml 配置
    $codexHome = "$env:USERPROFILE\.codex"
    $configPath = "$codexHome\config.toml"
    New-Item -ItemType Directory -Force $codexHome | Out-Null
    $baseUrl = if ($sessionId) { "http://localhost:$Port/s/$sessionId/Codex" } else { "http://localhost:$Port/Codex" }
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
    # 写入策略：不覆盖原有内容 — 代理 section 缺失时追加，base_url 每次都更新
    # 显式 UTF-8（无 BOM）读写：PS 5.1 的 Get-Content 默认按 ANSI 解码会损坏无 BOM UTF-8 内容
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    if (-not (Test-Path $configPath)) {
      # 配置文件不存在 → 写入完整代理配置
      [System.IO.File]::WriteAllText($configPath, $toml, $utf8NoBom)
      Write-Host "  已写入 Codex 代理配置: $configPath" -ForegroundColor Gray
    } else {
      $lines = @([System.IO.File]::ReadAllLines($configPath, [System.Text.Encoding]::UTF8))
      $sectionIdx = -1
      for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^\s*\[model_providers\.LLM-Monitor\]') { $sectionIdx = $i; break }
      }
      if ($sectionIdx -ge 0) {
        # 代理 section 已存在 → 仅更新该 section 内的 base_url，不动其他内容
        $updated = $false
        for ($i = $sectionIdx + 1; $i -lt $lines.Count; $i++) {
          if ($lines[$i] -match '^\s*\[') { break }  # 到达下一个 section
          if ($lines[$i] -match '^\s*base_url\s*=') { $lines[$i] = "base_url = `"$baseUrl`""; $updated = $true; break }
        }
        if (-not $updated) {
          # section 内缺少 base_url → 在 section 标题行后插入
          $tail = if ($sectionIdx + 1 -lt $lines.Count) { $lines[($sectionIdx + 1)..($lines.Count - 1)] } else { @() }
          $lines = $lines[0..$sectionIdx] + @("base_url = `"$baseUrl`"") + $tail
        }
        [System.IO.File]::WriteAllLines($configPath, $lines, $utf8NoBom)
        Write-Host "  Codex 配置已存在，仅更新 base_url（保留原有内容）" -ForegroundColor Gray
      } else {
        # 无代理 section → 末尾追加；顶层 model_provider 缺失时插入文件顶部（TOML 顶层键须在 [section] 之前）
        $raw = $lines -join "`n"
        if ($raw -notmatch '(?m)^\s*model_provider\s*=') {
          $lines = @('model_provider = "LLM-Monitor"', '') + $lines
        } elseif ($raw -notmatch '(?m)^\s*model_provider\s*=\s*[''"]LLM-Monitor[''"]') {
          Write-Host "  ⚠ 配置顶层 model_provider 未指向 LLM-Monitor，如需走代理请手动切换" -ForegroundColor Yellow
        }
        $lines = $lines + @('', '[model_providers.LLM-Monitor]', 'name = "LLM-Monitor"', "base_url = `"$baseUrl`"", 'experimental_bearer_token = "llm-monitor"', 'wire_api = "responses"')
        [System.IO.File]::WriteAllLines($configPath, $lines, $utf8NoBom)
        Write-Host "  已在 Codex 配置末尾追加 LLM-Monitor 代理 section（保留原有内容）" -ForegroundColor Gray
      }
    }
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
