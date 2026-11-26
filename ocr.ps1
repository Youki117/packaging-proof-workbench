param([Parameter(Mandatory=$true)][string]$ImagePath)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
[void][Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
[void][Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
[void][Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
[void][Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]
[void][Windows.Globalization.Language,Windows.Foundation,ContentType=WindowsRuntime]

$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1

function Wait-WinRT($Operation, [Type]$ResultType) {
    $task = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    $task.GetAwaiter().GetResult()
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-Hans-CN'))
if ($null -eq $engine) { throw 'Windows Simplified Chinese OCR is unavailable.' }
$file = Wait-WinRT ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream = Wait-WinRT ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
try {
    $decoder = Wait-WinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $width = $decoder.PixelWidth
    $height = $decoder.PixelHeight
    $limit = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
    $scale = [Math]::Min(1, $limit / [Math]::Max($width, $height))
    $transform = [Windows.Graphics.Imaging.BitmapTransform,Windows.Graphics.Imaging,ContentType=WindowsRuntime]::new()
    $transform.ScaledWidth = [Math]::Max(1, [Math]::Floor($width * $scale))
    $transform.ScaledHeight = [Math]::Max(1, [Math]::Floor($height * $scale))
    $decode = $decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
        [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied, $transform,
        [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation,
        [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)
    $bitmap = Wait-WinRT $decode ([Windows.Graphics.Imaging.SoftwareBitmap])
    try {
        $result = Wait-WinRT ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        $lines = @(foreach ($line in $result.Lines) {
            if ($line.Words.Count -eq 0) { continue }
            $rects = @($line.Words | ForEach-Object { $_.BoundingRect })
            $words = @($line.Words | ForEach-Object {
                $rect = $_.BoundingRect
                @{ text = $_.Text; box = @(($rect.X / $bitmap.PixelWidth), ($rect.Y / $bitmap.PixelHeight),
                    ($rect.Width / $bitmap.PixelWidth), ($rect.Height / $bitmap.PixelHeight)) }
            })
            $left = ($rects | ForEach-Object { $_.X } | Measure-Object -Minimum).Minimum
            $top = ($rects | ForEach-Object { $_.Y } | Measure-Object -Minimum).Minimum
            $right = ($rects | ForEach-Object { $_.X + $_.Width } | Measure-Object -Maximum).Maximum
            $bottom = ($rects | ForEach-Object { $_.Y + $_.Height } | Measure-Object -Maximum).Maximum
            @{ text = $line.Text; words = $words; box = @(($left / $bitmap.PixelWidth), ($top / $bitmap.PixelHeight),
                (($right - $left) / $bitmap.PixelWidth), (($bottom - $top) / $bitmap.PixelHeight)) }
        })
        ConvertTo-Json -InputObject @{ lines = $lines } -Depth 8 -Compress
    } finally { $bitmap.Dispose() }
} finally { $stream.Dispose() }
