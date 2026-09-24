using System.Drawing;
using System.Drawing.Imaging;
using static Dtf.Native;

namespace Dtf;

static class Screen
{
    public static List<Dictionary<string, object?>> Info()
    {
        var out_ = new List<Dictionary<string, object?>>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr mon, IntPtr _, ref RECT __, IntPtr ___) =>
        {
            var mi = new MONITORINFOEX { cbSize = System.Runtime.InteropServices.Marshal.SizeOf<MONITORINFOEX>() };
            if (!GetMonitorInfoW(mon, ref mi)) return true;
            double scale = 1;
            if (GetDpiForMonitor(mon, 0, out var dpiX, out uint _) == 0) scale = dpiX / 96.0;
            out_.Add(new()
            {
                ["frame"] = new Rect(mi.rcMonitor.left, mi.rcMonitor.top, mi.rcMonitor.Width, mi.rcMonitor.Height).ToJson(),
                ["scale"] = scale,
                ["main"] = (mi.dwFlags & 1) != 0,
            });
            return true;
        }, IntPtr.Zero);
        return out_;
    }

    /// <summary>
    /// PNG of one window (PrintWindow, which renders occluded windows too) or
    /// of the whole virtual screen. No permission is involved on Windows.
    /// </summary>
    public static Dictionary<string, object?> Shot(Args a)
    {
        Bitmap? bmp = null;
        var hwnd = new IntPtr(a.Dbl("windowId") is double w ? (long)w : 0);
        if (hwnd != IntPtr.Zero && IsWindow(hwnd) && !IsIconic(hwnd))
        {
            GetWindowRect(hwnd, out var r);
            if (r.Width > 0 && r.Height > 0)
            {
                bmp = new Bitmap(r.Width, r.Height, PixelFormat.Format32bppArgb);
                using var g = Graphics.FromImage(bmp);
                var hdc = g.GetHdc();
                var ok = PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT);
                g.ReleaseHdc(hdc);
                if (!ok) { bmp.Dispose(); bmp = null; }
            }
        }
        if (bmp == null)
        {
            // The virtual screen spans every monitor; SM_XVIRTUALSCREEN.. give its bounds.
            int x = GetSystemMetrics(76), y = GetSystemMetrics(77), cx = GetSystemMetrics(78), cy = GetSystemMetrics(79);
            if (a.Dbl("rectX") is double rx) { x = (int)rx; y = (int)(a.Dbl("rectY") ?? 0); cx = (int)(a.Dbl("rectWidth") ?? cx); cy = (int)(a.Dbl("rectHeight") ?? cy); }
            bmp = new Bitmap(Math.Max(1, cx), Math.Max(1, cy), PixelFormat.Format32bppArgb);
            using var g = Graphics.FromImage(bmp);
            g.CopyFromScreen(x, y, 0, 0, bmp.Size, CopyPixelOperation.SourceCopy);
        }
        using (bmp)
        {
            using var ms = new MemoryStream();
            bmp.Save(ms, ImageFormat.Png);
            var bytes = ms.ToArray();
            var path = a.Str("outPath");
            if (path != null)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
                File.WriteAllBytes(path, bytes);
            }
            return new() { ["base64"] = Convert.ToBase64String(bytes), ["path"] = path };
        }
    }
}
