/**
 * Floppy's window on Windows: a WPF window driven by Windows PowerShell 5.1, which every Windows
 * 10 and 11 has, so there's nothing to install. It's transparent, borderless, always on top and
 * has no taskbar button; WPF lets clicks on its transparent pixels through to what's behind.
 *
 * It plays the PNG frames listed in $env:DX_FLOPPY_DIR\manifest.json and talks to its controller
 * in JSON lines: moods, tips and menu state come in on stdin, and clicks, menu choices and moves
 * go out on stdout, by name only. When stdin closes (the controller is gone), it closes too.
 *
 * Kept free of backticks and dollar-brace, so it can live in this template string as written.
 */
export const FLOPPY_WINDOW_PS = String.raw`
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Drawing
# Windows' own answer to "is something full screen?" (a game, a video, a presentation), and the
# window in front, to tell an overlay from something you're watching.
Add-Type -Namespace DxFloppy -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);'
$dir = $env:DX_FLOPPY_DIR
$manifest = [IO.File]::ReadAllText((Join-Path $dir 'manifest.json')) | ConvertFrom-Json

$utf8 = New-Object System.Text.UTF8Encoding($false)
$out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$out.AutoFlush = $true
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
function Send($obj) { try { $out.WriteLine(($obj | ConvertTo-Json -Compress)) } catch { } }

$frames = @{}
$once = @{}
foreach ($m in $manifest.moods) {
  $list = New-Object System.Collections.ArrayList
  foreach ($f in $m.frames) {
    $bi = New-Object System.Windows.Media.Imaging.BitmapImage
    $bi.BeginInit()
    $bi.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
    $bi.UriSource = New-Object System.Uri((Join-Path $dir $f.file))
    $bi.EndInit()
    $bi.Freeze()
    [void]$list.Add(@{ img = $bi; ms = [int]$f.ms })
  }
  $frames[$m.key] = $list
  $once[$m.key] = [bool]$m.once
}

# Whole device pixels only, so the pixel art stays sharp: twice its size at 100%, three times at 150%.
$g = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
$scale = $g.DpiX / 96.0
$g.Dispose()
$n = [Math]::Max(2, [Math]::Floor(2 * $scale + 0.5))
$wDip = $manifest.width * $n / $scale
$hDip = $manifest.height * $n / $scale
$below = ($manifest.height - $manifest.baseline) * $n / $scale

function NewLayer() {
  $w = New-Object System.Windows.Window
  $w.WindowStyle = 'None'
  $w.AllowsTransparency = $true
  $w.Background = [System.Windows.Media.Brushes]::Transparent
  $w.Topmost = $true
  $w.ShowInTaskbar = $false
  $w.ResizeMode = 'NoResize'
  $w.ShowActivated = $false
  $w.UseLayoutRounding = $true
  return $w
}

$win = NewLayer
$win.Title = 'Floppy'
$win.Width = $wDip
$win.Height = $hDip
$img = New-Object System.Windows.Controls.Image
$img.Width = $wDip
$img.Height = $hDip
$img.Stretch = 'Fill'
$img.Cursor = [System.Windows.Input.Cursors]::Hand
[System.Windows.Media.RenderOptions]::SetBitmapScalingMode($img, [System.Windows.Media.BitmapScalingMode]::NearestNeighbor)
$win.Content = $img

$wa = [System.Windows.SystemParameters]::WorkArea
function Clamp($x) { return [Math]::Min([Math]::Max($wa.Left, $x), $wa.Right - $wDip) }
$win.Top = $wa.Bottom - $hDip + $below
$startX = $wa.Right - $wDip - 140
if ($env:DX_FLOPPY_X) { $startX = [double]$env:DX_FLOPPY_X }
$win.Left = Clamp $startX

# ---------------------------------------------------------------- the balloon
$yellow = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromRgb(255, 255, 225))
$tip = NewLayer
$tip.SizeToContent = 'WidthAndHeight'
$stack = New-Object System.Windows.Controls.StackPanel
$border = New-Object System.Windows.Controls.Border
$border.Background = $yellow
$border.BorderBrush = [System.Windows.Media.Brushes]::Black
$border.BorderThickness = 1
$border.CornerRadius = 6
$border.Padding = '10,7,12,8'
$border.MaxWidth = 300
$inner = New-Object System.Windows.Controls.StackPanel
$head = New-Object System.Windows.Controls.StackPanel
$head.Orientation = 'Horizontal'
$dot = New-Object System.Windows.Shapes.Ellipse
$dot.Width = 10
$dot.Height = 10
$dot.Margin = '0,0,6,0'
$dot.VerticalAlignment = 'Center'
$tTitle = New-Object System.Windows.Controls.TextBlock
$tTitle.FontFamily = 'Segoe UI'
$tTitle.FontSize = 12
$tTitle.FontWeight = 'Bold'
[void]$head.Children.Add($dot)
[void]$head.Children.Add($tTitle)
$tText = New-Object System.Windows.Controls.TextBlock
$tText.FontFamily = 'Segoe UI'
$tText.FontSize = 12
$tText.TextWrapping = 'Wrap'
$tText.Margin = '0,3,0,0'
[void]$inner.Children.Add($head)
[void]$inner.Children.Add($tText)
$border.Child = $inner
$tail = New-Object System.Windows.Shapes.Polygon
$tail.Points = [System.Windows.Media.PointCollection]::Parse('0,0 14,0 7,8')
$tail.Fill = $yellow
$tail.Stroke = [System.Windows.Media.Brushes]::Black
$tail.StrokeThickness = 1
$tail.Margin = '0,-1,0,0'
$tail.HorizontalAlignment = 'Center'
[void]$stack.Children.Add($border)
[void]$stack.Children.Add($tail)
$tip.Content = $stack
$tip.Cursor = [System.Windows.Input.Cursors]::Hand

$colors = @{ info = '#2563EB'; error = '#D61F1F'; ok = '#16A34A'; ai = '#7C3AED'; quiet = '#6B7280'; warn = '#D97706' }
$tipState = @{ data = $null; sticky = $false; until = [DateTime]::MinValue; hover = $false }
$away = @{ hidden = $false; n = 0 }
function PlaceTip() {
  $tip.Left = [Math]::Min([Math]::Max($wa.Left + 4, $win.Left + $wDip / 2 - $tip.ActualWidth / 2), $wa.Right - $tip.ActualWidth - 4)
  $tip.Top = $win.Top - $tip.ActualHeight + 2 * $n / $scale
}
function ShowTip($data) {
  if ($null -eq $data -or $away.hidden) { return }
  $tTitle.Text = [string]$data.title
  $tText.Text = [string]$data.text
  $c = $colors[[string]$data.icon]
  if (-not $c) { $c = $colors.info }
  $dot.Fill = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.ColorConverter]::ConvertFromString($c))
  if (-not $tip.IsVisible) { $tip.Show() }
  $tip.UpdateLayout()
  PlaceTip
}
function HideTip() { if ($tip.IsVisible) { $tip.Hide() } }
$tip.Add_SizeChanged({ PlaceTip })

# ---------------------------------------------------------------- the line beside it
# Always there: what's happening and in which project, so nobody has to read Floppy's face.
$label = NewLayer
$label.SizeToContent = 'WidthAndHeight'
$label.Cursor = [System.Windows.Input.Cursors]::Hand
$lBorder = New-Object System.Windows.Controls.Border
$lBorder.Background = $yellow
$lBorder.BorderBrush = [System.Windows.Media.Brushes]::Black
$lBorder.BorderThickness = 1
$lBorder.CornerRadius = 4
$lBorder.Padding = '6,2,8,3'
# Its own size, at the foot of its window: Windows can make a small window taller (or wider) than
# what's in it, and a stretched box left the text at the top and the dot below it.
$lBorder.VerticalAlignment = 'Bottom'
$lBorder.HorizontalAlignment = 'Right'
$lRow = New-Object System.Windows.Controls.StackPanel
$lRow.Orientation = 'Horizontal'
$lDot = New-Object System.Windows.Shapes.Ellipse
$lDot.Width = 8
$lDot.Height = 8
# Level with the middle of the lowercase letters, which sit below the middle of the line.
$lDot.Margin = '0,2,5,0'
$lDot.VerticalAlignment = 'Center'
$lText = New-Object System.Windows.Controls.TextBlock
$lText.FontFamily = 'Segoe UI'
$lText.FontSize = 12
$lText.MaxWidth = 280
$lText.TextTrimming = 'CharacterEllipsis'
[void]$lRow.Children.Add($lDot)
[void]$lRow.Children.Add($lText)
$lBorder.Child = $lRow
$label.Content = $lBorder
$labelState = @{ data = $null }
# Beside Floppy, on the side with room (left first: it usually sits near the clock), just above the taskbar.
function PlaceLabel() {
  if (-not $label.IsVisible) { return }
  $x = $win.Left - $label.ActualWidth - 2
  $lBorder.HorizontalAlignment = 'Right'
  if ($x -lt $wa.Left + 4) { $x = $win.Left + $wDip + 2; $lBorder.HorizontalAlignment = 'Left' }
  $label.Left = [Math]::Min([Math]::Max($wa.Left + 4, $x), $wa.Right - $label.ActualWidth - 4)
  $label.Top = $wa.Bottom - $label.ActualHeight - 6
}
function ShowLabel() {
  $d = $labelState.data
  if ($null -eq $d -or $away.hidden) { return }
  $lText.Text = [string]$d.text
  $c = $colors[[string]$d.icon]
  if (-not $c) { $c = $colors.info }
  $lDot.Fill = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.ColorConverter]::ConvertFromString($c))
  if (-not $label.IsVisible) { $label.Show() }
  $label.UpdateLayout()
  PlaceLabel
}
$label.Add_SizeChanged({ PlaceLabel })

# ---------------------------------------------------------------- frames
$state = @{ mood = 'idle'; base = 'idle'; i = 0 }
$timer = New-Object System.Windows.Threading.DispatcherTimer
function ShowFrame() {
  $f = $frames[$state.mood][$state.i]
  $img.Source = $f.img
  $timer.Interval = [TimeSpan]::FromMilliseconds([Math]::Max(40, $f.ms))
}
function SetMood($m) {
  if (-not $frames.ContainsKey($m)) { return }
  $state.mood = $m
  $state.i = 0
  ShowFrame
}
$timer.Add_Tick({
  $state.i = $state.i + 1
  if ($state.i -ge $frames[$state.mood].Count) {
    $state.i = 0
    if ($once[$state.mood]) { $state.mood = $state.base }
  }
  ShowFrame
  if ($tipState.data -and -not $tipState.sticky -and -not $tipState.hover -and [DateTime]::Now -gt $tipState.until) { HideTip }
})

# ---------------------------------------------------------------- mouse
$drag = @{ down = $false; moved = $false; sx = 0.0; sl = 0.0 }
function ScreenX($e) { return $win.PointToScreen($e.GetPosition($win)).X / $scale }
$img.Add_MouseEnter({ $tipState.hover = $true; ShowTip $tipState.data })
$img.Add_MouseLeave({ $tipState.hover = $false; if (-not $tipState.sticky -and [DateTime]::Now -gt $tipState.until) { HideTip } })
$img.Add_MouseLeftButtonDown({
  param($s, $e)
  $drag.down = $true
  $drag.moved = $false
  $drag.sx = ScreenX $e
  $drag.sl = $win.Left
  [void]$img.CaptureMouse()
})
$img.Add_MouseMove({
  param($s, $e)
  if (-not $drag.down) { return }
  $dx = (ScreenX $e) - $drag.sx
  if (-not $drag.moved -and [Math]::Abs($dx) -gt 4) {
    $drag.moved = $true
    HideTip
    SetMood 'held'
  }
  if ($drag.moved) {
    $win.Left = Clamp ($drag.sl + $dx)
    if ($tip.IsVisible) { PlaceTip }
    PlaceLabel
  }
})
$img.Add_MouseLeftButtonUp({
  if (-not $drag.down) { return }
  $drag.down = $false
  $img.ReleaseMouseCapture()
  if ($drag.moved) {
    $drag.moved = $false
    SetMood $state.base
    Send @{ event = 'moved'; x = [Math]::Round($win.Left, 1) }
  } else {
    $tipState.sticky = $false
    HideTip
    Send @{ event = 'click' }
  }
})
$tip.Add_MouseLeftButtonUp({ $tipState.sticky = $false; HideTip; Send @{ event = 'click' } })
# The line beside it answers like Floppy: hover for the balloon, click to open dx.
$label.Add_MouseEnter({ $tipState.hover = $true; ShowTip $tipState.data })
$label.Add_MouseLeave({ $tipState.hover = $false; if (-not $tipState.sticky -and [DateTime]::Now -gt $tipState.until) { HideTip } })
$label.Add_MouseLeftButtonUp({ $tipState.sticky = $false; HideTip; Send @{ event = 'click' } })

# ---------------------------------------------------------------- right-click menu
$menu = New-Object System.Windows.Controls.ContextMenu
function Item($header, $action, $checkable) {
  $mi = New-Object System.Windows.Controls.MenuItem
  $mi.Header = $header
  $mi.Tag = $action
  $mi.IsCheckable = $checkable
  $mi.Add_Click({ param($s, $e) Send @{ event = 'menu'; action = [string]$s.Tag; checked = [bool]$s.IsChecked } })
  [void]$menu.Items.Add($mi)
  return $mi
}
$miOpen = Item 'Open dx' 'open' $false
$miOpen.FontWeight = 'Bold'
[void]$menu.Items.Add((New-Object System.Windows.Controls.Separator))
$miQuiet = Item 'Quiet for an hour' 'quiet' $true
$miStartup = Item 'Start with Windows' 'startup' $true
[void]$menu.Items.Add((New-Object System.Windows.Controls.Separator))
$miQuit = Item 'Quit Floppy' 'quit' $false
$img.ContextMenu = $menu
$menu.Add_Opened({ HideTip })

# ---------------------------------------------------------------- messages from dx
function Handle($msg) {
  switch ([string]$msg.type) {
    'mood' {
      $then = [string]$msg.mood
      if ($msg.play) {
        $state.base = $then
        if (-not $drag.moved) { SetMood ([string]$msg.play) }
      } else {
        $state.base = $then
        if (-not $drag.moved -and -not ($once[$state.mood] -and $state.mood -ne $then)) { SetMood $then }
      }
      if ($msg.tip) { $tipState.data = $msg.tip }
      if ($msg.status) { $labelState.data = $msg.status; ShowLabel }
      $tipState.sticky = [bool]$msg.sticky
      if ($msg.announce -or $msg.sticky) {
        $tipState.until = [DateTime]::Now.AddSeconds(5)
        if (-not $drag.down) { ShowTip $tipState.data }
      } elseif ($tip.IsVisible -and $tipState.hover) {
        ShowTip $tipState.data
      }
    }
    'menu' {
      $miQuiet.IsChecked = [bool]$msg.quiet
      $miStartup.IsChecked = [bool]$msg.startup
    }
    'quit' { $win.Close() }
  }
}
$pending = @{ task = $reader.ReadLineAsync() }
$poll = New-Object System.Windows.Threading.DispatcherTimer
$poll.Interval = [TimeSpan]::FromMilliseconds(120)
$poll.Add_Tick({
  # Out of the way while something is full screen (2 busy, 3 a full-screen game, 4 presenting).
  $away.n = $away.n + 1
  if ($away.n % 8 -eq 0) {
    $q = 0
    try { [void][DxFloppy.Shell]::SHQueryUserNotificationState([ref]$q) } catch { }
    # "Busy" also comes from overlays that cover the screen without being something you watch
    # (screen recorders' borders, game overlays, an assistant controlling the screen). Those are
    # layered windows (WS_EX_LAYERED); a full-screen video or game window isn't.
    if ($q -eq 2) {
      try {
        $ex = [int64][DxFloppy.Shell]::GetWindowLongPtr([DxFloppy.Shell]::GetForegroundWindow(), -20)
        if (($ex -band 0x80000) -ne 0) { $q = 5 }
      } catch { }
    }
    $busy = ($q -eq 2 -or $q -eq 3 -or $q -eq 4)
    if ($busy -and -not $away.hidden) {
      $away.hidden = $true
      HideTip
      if ($label.IsVisible) { $label.Hide() }
      $win.Hide()
    } elseif (-not $busy -and $away.hidden) {
      $away.hidden = $false
      $win.Show()
      $win.Topmost = $true
      ShowLabel
    }
  }
  while ($pending.task.IsCompleted) {
    $line = $null
    try { $line = $pending.task.Result } catch { }
    if ($null -eq $line) { $win.Close(); return }
    try { Handle ($line | ConvertFrom-Json) } catch { }
    $pending.task = $reader.ReadLineAsync()
  }
})

$win.Add_Closed({ $timer.Stop(); $poll.Stop(); try { $tip.Close() } catch { }; try { $label.Close() } catch { }; $app.Shutdown() })
$shown = @{ done = $false }
$win.Add_ContentRendered({
  if ($shown.done) { return }
  $shown.done = $true
  # Started hidden (no console), Windows hides the first window shown; showing it again fixes that.
  $win.Hide()
  $win.Show()
  Send @{ event = 'ready'; scale = $scale; size = $n }
})

$app = New-Object System.Windows.Application
$app.ShutdownMode = 'OnExplicitShutdown'
SetMood 'idle'
$timer.Start()
$poll.Start()
[void]$app.Run($win)
`;
