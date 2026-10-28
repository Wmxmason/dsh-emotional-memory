param([string]$AppDirectory = (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'))
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$appExecutable = Join-Path $AppDirectory 'DeepSeek Harness.exe'
if (-not (Test-Path -LiteralPath $appExecutable)) { throw 'DeepSeek Harness Desktop was not found' }
$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_SDK_ROOT = Join-Path $AppDirectory 'resources\app.asar\dsh'
$qqRoot = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\@tencent-connect\dsh-qqbot'
if (Test-Path -LiteralPath $qqRoot) { $env:DSH_QQ_ROOT = $qqRoot }
$loaderUri = ([System.Uri](Join-Path $PSScriptRoot 'host-loader.mjs')).AbsoluteUri
& $appExecutable --expose-internals --import $loaderUri --test (Join-Path $taskRoot 'test\harness.host.test.mjs') (Join-Path $taskRoot 'test\qq-rotation.host.test.mjs') | Out-Host
exit $LASTEXITCODE
