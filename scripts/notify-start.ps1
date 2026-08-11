<#
.SYNOPSIS
  通知 llm-monitor 代理 CLl 工具已启动，然后执行目标命令。
  在 PowerShell 配置文件 (~\Documents\PowerShell\Microsoft.PowerShell_profile.ps1) 中添加：
    function claude  { . D:\AICode\llm-monitor\scripts\notify-start.ps1 -Tool ClaudeCode  -Command claude  @args }
    function codex   { . D:\AICode\llm-monitor\scripts\notify-start.ps1 -Tool codex      -Command codex   @args }
#>
param(
  [Parameter(Mandatory=$true)]
  [string]$Tool,

  [Parameter(Mandatory=$true)]
  [string]$Command,

  [Parameter(ValueFromRemainingArguments=$true)]
  $Remaining
)

$webuiPort = if ($env:LLM_MONITOR_WEBUI_PORT) { $env:LLM_MONITOR_WEBUI_PORT } else { 9401 }
$body = @{ tool = $Tool } | ConvertTo-Json -Compress
try {
  Invoke-RestMethod -Uri "http://localhost:$webuiPort/api/sessions/start" `
    -Method POST -Body $body -ContentType "application/json" 2>$null | Out-Null
} catch {
  # 代理未运行也继续启动（静默忽略）
}

# 执行实际的 CLI 命令
& $Command $Remaining
