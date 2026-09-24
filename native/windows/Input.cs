using static Dtf.Native;

namespace Dtf;

/// <summary>
/// Synthetic mouse and keyboard events through SendInput.
///
/// These arrive at the same point in the input pipeline as a real device, so
/// they drive menu tracking loops, native dialogs and anything else that
/// ignores UIA patterns. No permission is needed, but UIPI applies: input from
/// this process is dropped by any window running at a higher integrity level.
/// </summary>
static class Input
{
    // MARK: Key names (shared vocabulary with Input.swift)

    public static readonly Dictionary<string, int> KeyCodes = new(StringComparer.OrdinalIgnoreCase)
    {
        ["enter"] = VK_RETURN, ["return"] = VK_RETURN, ["tab"] = VK_TAB, ["space"] = VK_SPACE,
        // macOS "delete" is the backspace key; "forwarddelete" is the Del key.
        ["delete"] = VK_BACK, ["backspace"] = VK_BACK, ["forwarddelete"] = VK_DELETE,
        ["escape"] = VK_ESCAPE, ["esc"] = VK_ESCAPE, ["capslock"] = VK_CAPITAL,
        ["help"] = VK_HELP, ["home"] = VK_HOME, ["end"] = VK_END, ["pageup"] = VK_PRIOR, ["pagedown"] = VK_NEXT,
        ["left"] = VK_LEFT, ["right"] = VK_RIGHT, ["up"] = VK_UP, ["down"] = VK_DOWN, ["insert"] = VK_INSERT,
        ["printscreen"] = VK_SNAPSHOT, ["pause"] = VK_PAUSE, ["numlock"] = VK_NUMLOCK, ["scrolllock"] = VK_SCROLL,
        ["menu"] = VK_APPS, ["contextmenu"] = VK_APPS,
        ["-"] = VK_OEM_MINUS, ["="] = VK_OEM_PLUS, ["["] = VK_OEM_4, ["]"] = VK_OEM_6, ["\\"] = VK_OEM_5,
        [";"] = VK_OEM_1, ["'"] = VK_OEM_7, [","] = VK_OEM_COMMA, ["."] = VK_OEM_PERIOD, ["/"] = VK_OEM_2, ["`"] = VK_OEM_3,
    };

    static Input()
    {
        for (char c = 'a'; c <= 'z'; c++) KeyCodes[c.ToString()] = char.ToUpperInvariant(c);
        for (char c = '0'; c <= '9'; c++) KeyCodes[c.ToString()] = c;
        for (int i = 1; i <= 24; i++) KeyCodes[$"f{i}"] = VK_F1 + i - 1;
    }

    /// <summary>
    /// Modifier names. `cmd` and `mod` both mean Ctrl: a test written on macOS
    /// says "cmd+s" for Save and must keep meaning Save here. The Windows key
    /// is reachable as `win`/`meta`/`super`.
    /// </summary>
    public static readonly Dictionary<string, int> Modifiers = new(StringComparer.OrdinalIgnoreCase)
    {
        ["cmd"] = VK_CONTROL, ["command"] = VK_CONTROL, ["mod"] = VK_CONTROL, ["primary"] = VK_CONTROL,
        ["ctrl"] = VK_CONTROL, ["control"] = VK_CONTROL,
        ["shift"] = VK_SHIFT,
        ["alt"] = VK_MENU, ["option"] = VK_MENU, ["opt"] = VK_MENU,
        ["win"] = VK_LWIN, ["windows"] = VK_LWIN, ["meta"] = VK_LWIN, ["super"] = VK_LWIN,
    };

    /// <summary>Parses "cmd+shift+n" into modifier VKs plus the terminal key VK.</summary>
    public static (List<int> mods, int vk)? ParseCombo(string combo)
    {
        var parts = combo.Split('+').Select(p => p.Trim()).ToList();
        if (parts.Count == 0 || parts[^1].Length == 0) return null;
        var mods = new List<int>();
        foreach (var m in parts.Take(parts.Count - 1))
        {
            if (!Modifiers.TryGetValue(m, out var vk)) return null;
            mods.Add(vk);
        }
        var last = parts[^1];
        if (KeyCodes.TryGetValue(last, out var code)) return (mods, code);
        return null;
    }

    static readonly HashSet<int> Extended = new()
    {
        VK_INSERT, VK_DELETE, VK_HOME, VK_END, VK_PRIOR, VK_NEXT, VK_LEFT, VK_RIGHT, VK_UP, VK_DOWN,
        VK_NUMLOCK, VK_SNAPSHOT, VK_LWIN, VK_RWIN, VK_APPS, VK_RCONTROL, VK_RMENU,
    };

    static INPUT KeyInput(int vk, bool up)
    {
        var flags = up ? KEYEVENTF_KEYUP : 0;
        if (Extended.Contains(vk)) flags |= KEYEVENTF_EXTENDEDKEY;
        return new INPUT
        {
            type = INPUT_KEYBOARD,
            u = new INPUTUNION { ki = new KEYBDINPUT { wVk = (ushort)vk, wScan = (ushort)MapVirtualKeyW((uint)vk, 0), dwFlags = flags } },
        };
    }

    static void Send(params INPUT[] inputs)
    {
        if (inputs.Length == 0) return;
        var n = SendInput((uint)inputs.Length, inputs, System.Runtime.InteropServices.Marshal.SizeOf<INPUT>());
        if (n != inputs.Length) Program.Warn($"SendInput sent {n}/{inputs.Length} events (error {System.Runtime.InteropServices.Marshal.GetLastWin32Error()}); is the target elevated?");
    }

    // MARK: Keyboard

    public static bool Key(string combo)
    {
        var parsed = ParseCombo(combo);
        if (parsed == null) return false;
        var (mods, vk) = parsed.Value;
        foreach (var m in mods) Send(KeyInput(m, false));
        Send(KeyInput(vk, false));
        Thread.Sleep(12);
        Send(KeyInput(vk, true));
        for (int i = mods.Count - 1; i >= 0; i--) Send(KeyInput(mods[i], true));
        Thread.Sleep(12);
        return true;
    }

    /// <summary>
    /// Types arbitrary text as Unicode events, so no keycode lookup is needed
    /// and non-US layouts, emoji and symbols all work. Newlines and tabs go as
    /// real keys because most controls ignore a U+000A character event.
    /// </summary>
    public static void Type(string text, int delayMs = 8)
    {
        foreach (var ch in text)
        {
            if (ch == '\n' || ch == '\r') { Key("enter"); continue; }
            if (ch == '\t') { Key("tab"); continue; }
            var down = new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wScan = ch, dwFlags = KEYEVENTF_UNICODE } } };
            var up = new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wScan = ch, dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } } };
            Send(down, up);
            Thread.Sleep(Math.Max(0, delayMs));
        }
    }

    // MARK: Mouse

    static INPUT Mouse(uint flags, int data = 0) =>
        new() { type = INPUT_MOUSE, u = new INPUTUNION { mi = new MOUSEINPUT { dwFlags = flags, mouseData = (uint)data } } };

    public static void Move(double x, double y)
    {
        // SetCursorPos takes physical pixels, the same space UIA reports rects
        // in, because this process is per-monitor DPI aware. A MOUSEEVENTF_MOVE
        // event follows so hover tracking (tooltips, menu highlighting) notices.
        SetCursorPos((int)Math.Round(x), (int)Math.Round(y));
        Send(Mouse(MOUSEEVENTF_MOVE));
    }

    static (uint down, uint up) ButtonFlags(string button) => button.ToLowerInvariant() switch
    {
        "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        _ => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
    };

    public static void Click(double x, double y, string button = "left", int count = 1, IEnumerable<string>? modifiers = null)
    {
        var mods = (modifiers ?? Array.Empty<string>()).Select(m => Modifiers.TryGetValue(m, out var vk) ? vk : 0).Where(v => v != 0).ToList();
        var (down, up) = ButtonFlags(button);
        Move(x, y);
        Thread.Sleep(20);
        foreach (var m in mods) Send(KeyInput(m, false));
        for (int i = 0; i < Math.Max(1, count); i++)
        {
            Send(Mouse(down));
            Thread.Sleep(15);
            Send(Mouse(up));
            // Well inside GetDoubleClickTime so a count of 2 registers as a double-click.
            Thread.Sleep(40);
        }
        for (int i = mods.Count - 1; i >= 0; i--) Send(KeyInput(mods[i], true));
    }

    public static void Drag(double fromX, double fromY, double toX, double toY, int steps = 20)
    {
        Move(fromX, fromY);
        Thread.Sleep(30);
        Send(Mouse(MOUSEEVENTF_LEFTDOWN));
        Thread.Sleep(30);
        for (int i = 1; i <= Math.Max(1, steps); i++)
        {
            var t = (double)i / steps;
            Move(fromX + (toX - fromX) * t, fromY + (toY - fromY) * t);
            Thread.Sleep(10);
        }
        Send(Mouse(MOUSEEVENTF_LEFTUP));
    }

    /// <summary>
    /// Scrolls at a point. `dy`/`dx` are in the framework's pixel-ish units;
    /// a WHEEL_DELTA notch is 120 and scrolls about three lines, so ~40 units
    /// per notch keeps macOS and Windows tests roughly in step.
    /// </summary>
    public static void Scroll(double x, double y, int dx, int dy)
    {
        Move(x, y);
        Thread.Sleep(15);
        static int Notches(int v) => v == 0 ? 0 : Math.Sign(v) * Math.Max(120, (int)Math.Round(Math.Abs(v) * 120.0 / 40.0));
        if (dy != 0) Send(Mouse(MOUSEEVENTF_WHEEL, Notches(dy)));
        if (dx != 0) Send(Mouse(MOUSEEVENTF_HWHEEL, Notches(dx)));
    }

    public static (int x, int y) MouseLocation()
    {
        GetCursorPos(out var p);
        return (p.x, p.y);
    }

    /// <summary>
    /// Names for the recorder, the inverse of KeyCodes with the canonical names
    /// the `key` op documents (enter, backspace, escape, ...).
    /// </summary>
    public static string? KeyName(int vk)
    {
        return vk switch
        {
            VK_RETURN => "enter", VK_BACK => "backspace", VK_ESCAPE => "escape", VK_TAB => "tab", VK_SPACE => "space",
            VK_DELETE => "forwarddelete", VK_HOME => "home", VK_END => "end", VK_PRIOR => "pageup", VK_NEXT => "pagedown",
            VK_LEFT => "left", VK_RIGHT => "right", VK_UP => "up", VK_DOWN => "down", VK_INSERT => "insert", VK_HELP => "help",
            VK_CAPITAL => "capslock",
            >= VK_F1 and < VK_F1 + 24 => $"f{vk - VK_F1 + 1}",
            >= 'A' and <= 'Z' => ((char)(vk + 32)).ToString(),
            >= '0' and <= '9' => ((char)vk).ToString(),
            VK_OEM_MINUS => "-", VK_OEM_PLUS => "=", VK_OEM_4 => "[", VK_OEM_6 => "]", VK_OEM_5 => "\\", VK_OEM_1 => ";",
            VK_OEM_7 => "'", VK_OEM_COMMA => ",", VK_OEM_PERIOD => ".", VK_OEM_2 => "/", VK_OEM_3 => "`",
            _ => null,
        };
    }

    /// <summary>Keys whose meaning is not the character they produce.</summary>
    public static bool IsSpecial(int vk) => vk is VK_RETURN or VK_BACK or VK_ESCAPE or VK_TAB or VK_SPACE or VK_DELETE or VK_HOME or VK_END
        or VK_PRIOR or VK_NEXT or VK_LEFT or VK_RIGHT or VK_UP or VK_DOWN or VK_INSERT or VK_HELP or VK_CAPITAL || (vk >= VK_F1 && vk < VK_F1 + 24);
}
