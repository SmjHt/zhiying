param([string]$Manifest)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$data = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $voice = $synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'zh-CN' } | Select-Object -First 1
    if (-not $voice) { throw 'No offline Chinese speech voice installed.' }
    $synth.SelectVoice($voice.VoiceInfo.Name)
    $synth.Rate = [int]$data.rate
    $synth.Volume = 100
    foreach ($segment in $data.segments) {
        $synth.SetOutputToWaveFile([string]$segment.path)
        $synth.Speak([string]$segment.text)
        $synth.SetOutputToNull()
    }
} finally {
    $synth.Dispose()
}
