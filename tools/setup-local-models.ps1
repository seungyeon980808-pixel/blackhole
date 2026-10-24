# Windows counterpart of tools/setup-local-models.sh. NOT YET RUN ON A WINDOWS MACHINE.
# Installs what the Ya analysis worker needs; skips anything present; never deletes.
#
#   powershell -ExecutionPolicy Bypass -File tools\setup-local-models.ps1 [-Check]
#
# Ollama and Node.js come from winget; whisper.cpp from its official GitHub release
# (ggml-org/whisper.cpp, b5454 = v1.9.5, whisper-bin-x64.zip). Models go to
# %LOCALAPPDATA%\ya-models (override with YA_MODELS_DIR) and %USERPROFILE%\.ollama\models.
param([switch]$Check, [switch]$WithComparison, [switch]$WithDocumentModel)
$ErrorActionPreference = "Stop"

$ModelsDir = if ($env:YA_MODELS_DIR) { $env:YA_MODELS_DIR } else { Join-Path $env:LOCALAPPDATA "ya-models" }
$OllamaUrl = if ($env:YA_OLLAMA_URL) { $env:YA_OLLAMA_URL } else { "http://127.0.0.1:11434" }
$OllamaModels = @(@{ Name = "gemma4:e2b-it-q4_K_M"; Mb = 4600 })
if ($WithDocumentModel) { $OllamaModels += @{ Name = "gemma4:e4b-it-q4_K_M"; Mb = 6600 } }
if ($WithComparison) { $OllamaModels += @{ Name = "gemma3:1b"; Mb = 806 }, @{ Name = "gemma3:4b"; Mb = 3400 } }
$WhisperFile = "ggml-large-v3-turbo-q5_0.bin"
$WhisperUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$WhisperFile"
$WhisperSha256 = "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2"
$WhisperBinUrl = "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip"
$KordocVersion = "4.24.3"
$LimitMb = 20480

function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function OllamaUp { try { Invoke-RestMethod "$OllamaUrl/api/version" -TimeoutSec 2 | Out-Null; $true } catch { $false } }
function OllamaHas($name) { (ollama list 2>$null | Select-Object -Skip 1 | ForEach-Object { ($_ -split '\s+')[0] }) -contains $name }

$WhisperDir = Join-Path $ModelsDir "whisper"
$WhisperBinDir = Join-Path $ModelsDir "whisper-cpp"
$WhisperCli = Join-Path $WhisperBinDir "Release\whisper-cli.exe"
$Kordoc = Join-Path $ModelsDir "kordoc\node_modules\.bin\kordoc.cmd"

$plan = @(); $needMb = 0
if (-not (Have ollama)) { $plan += "winget Ollama.Ollama" }
if (-not (Have node)) { $plan += "winget OpenJS.NodeJS.LTS" }
if (-not (Test-Path $WhisperCli)) { $plan += "whisper.cpp whisper-bin-x64.zip (~10MB)"; $needMb += 10 }
foreach ($m in $OllamaModels) {
  if (-not ((Have ollama) -and (OllamaUp) -and (OllamaHas $m.Name))) { $plan += "Ollama $($m.Name) ($($m.Mb)MB)"; $needMb += $m.Mb }
}
if (-not (Test-Path (Join-Path $WhisperDir $WhisperFile))) { $plan += "whisper $WhisperFile (548MB)"; $needMb += 548 }
if (-not (Test-Path $Kordoc)) { $plan += "kordoc $KordocVersion + OCR (~460MB)"; $needMb += 460 }

$freeMb = [math]::Floor((Get-PSDrive ($env:LOCALAPPDATA.Substring(0, 1))).Free / 1MB)
Write-Output "남은 디스크: ${freeMb}MB"
if ($plan.Count -eq 0) { Write-Output "설치할 것 없음: 모두 설치되어 있습니다." }
else { Write-Output "설치할 것 (받을 용량 약 ${needMb}MB):"; $plan | ForEach-Object { Write-Output "  - $_" } }

if (-not $Check -and $plan.Count -gt 0) {
  if ($needMb -gt $LimitMb) { throw "받을 용량이 ${LimitMb}MB를 넘습니다. 멈춥니다." }
  if ($freeMb -lt ($needMb + 5120)) { throw "디스크 여유가 부족합니다." }
  if (-not (Have ollama)) { winget install --id Ollama.Ollama -e --accept-package-agreements }
  if (-not (Have node)) { winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements }
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not (OllamaUp)) {
    Start-Process ollama -ArgumentList "serve" -WindowStyle Hidden
    for ($i = 0; $i -lt 30 -and -not (OllamaUp); $i++) { Start-Sleep 1 }
  }
  foreach ($m in $OllamaModels) { if (-not (OllamaHas $m.Name)) { ollama pull $m.Name } }

  New-Item -ItemType Directory -Force $WhisperDir, $WhisperBinDir | Out-Null
  if (-not (Test-Path $WhisperCli)) {
    $zip = Join-Path $WhisperBinDir "whisper-bin-x64.zip"
    Invoke-WebRequest $WhisperBinUrl -OutFile $zip
    Expand-Archive $zip -DestinationPath $WhisperBinDir -Force
  }
  $target = Join-Path $WhisperDir $WhisperFile
  if (-not (Test-Path $target)) {
    Invoke-WebRequest $WhisperUrl -OutFile "$target.part"
    $actual = (Get-FileHash "$target.part" -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $WhisperSha256) { throw "whisper 모델 해시가 다릅니다($actual). .part 파일을 남겨 둡니다." }
    Move-Item "$target.part" $target
  }
  if (-not (Test-Path $Kordoc)) {
    $kdir = Join-Path $ModelsDir "kordoc"
    New-Item -ItemType Directory -Force $kdir | Out-Null
    if (-not (Test-Path (Join-Path $kdir "package.json"))) { '{"name":"ya-kordoc","private":true}' | Set-Content (Join-Path $kdir "package.json") }
    npm install --prefix $kdir --no-fund --no-audit "kordoc@$KordocVersion"
  }
  & $Kordoc check-ocr-models
}

Write-Output ""
Write-Output "작업기 환경 변수 예: YA_WHISPER_BIN=$WhisperCli"
if (OllamaUp) { ollama list }
