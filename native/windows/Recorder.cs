using System.Collections.Concurrent;
using System.Text;
using Interop.UIAutomationClient;
using static Dtf.Native;

namespace Dtf;

/// <summary>
/// Watches real user input through low-level hooks and reports *what* was
/// interacted with, not where — the Windows twin of Recorder.swift, producing
/// the same events.
///
/// Two constraints shape the code, and they are the same two as on macOS:
///
///  * The hook callback runs on the input path. Anything slow in it — and a
///    UIA query into a busy app can take seconds — freezes the mouse and
///    keyboard system-wide. So the callback only copies the event's scalars
///    into a queue; the UIA lookup happens on a worker thread.
///
///  * Windows silently removes a low-level hook whose callback exceeds the
///    LowLevelHooksTimeout (a few hundred ms), and never tells you. Keeping
///    the callback trivial is the only defence.
///
/// Hooks also need a message loop on the thread that installed them, so they
/// live on a dedicated thread that does nothing but pump messages.
/// </summary>
sealed class Recorder
{
    public static readonly Recorder Shared = new();

    Thread? _hookThread, _worker;
    uint _hookThreadId;
    IntPtr _mouseHook, _keyHook;
    HookProc? _mouseProc, _keyProc; // kept alive: the OS holds raw pointers to these
    readonly BlockingCollection<Action> _queue = new();
    readonly object _lock = new();
    bool _pickArmed, _swallowingPickUp;
    int _seq;
    readonly HashSet<uint> _downKeys = new();

    public bool Running { get; private set; }

    public bool PickArmed
    {
        get { lock (_lock) return _pickArmed; }
        set { lock (_lock) _pickArmed = value; }
    }

    // What opened the popup menus currently on screen. Windows gives a popup
    // no link to the item or icon that opened it, so the recorder remembers.
    Dictionary<string, object?>? _trayContext;   // trayItem summary + owning pid
    List<string>? _menuBarRoot;                  // ["File"] after a menu bar click
    readonly List<(IntPtr hwnd, string title)> _menuStack = new();
    DateTime _lastTrayClick = DateTime.MinValue;

    public void Start()
    {
        if (Running) return;
        var ready = new ManualResetEventSlim();
        Exception? failure = null;
        _hookThread = new Thread(() =>
        {
            _hookThreadId = GetCurrentThreadId();
            _mouseProc = MouseHook;
            _keyProc = KeyHook;
            var module = GetModuleHandleW(null);
            _mouseHook = SetWindowsHookExW(WH_MOUSE_LL, _mouseProc, module, 0);
            _keyHook = SetWindowsHookExW(WH_KEYBOARD_LL, _keyProc, module, 0);
            if (_mouseHook == IntPtr.Zero || _keyHook == IntPtr.Zero)
            {
                failure = new OpError("tapFailed", $"could not install input hooks (error {System.Runtime.InteropServices.Marshal.GetLastWin32Error()}); is another elevated process holding input?");
                ready.Set();
                return;
            }
            ready.Set();
            while (GetMessageW(out var msg, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref msg);
                DispatchMessageW(ref msg);
            }
            UnhookWindowsHookEx(_mouseHook); UnhookWindowsHookEx(_keyHook);
            _mouseHook = _keyHook = IntPtr.Zero;
        }) { IsBackground = true, Name = "dtf.recorder.hooks" };
        _hookThread.Start();
        ready.Wait(3000);
        if (failure != null) throw failure;

        _worker = new Thread(() =>
        {
            foreach (var job in _queue.GetConsumingEnumerable())
            {
                try { job(); } catch (Exception e) { Program.Warn($"recorder: {e.Message}"); }
            }
        }) { IsBackground = true, Name = "dtf.recorder.worker" };
        _worker.Start();
        Running = true;
    }

    public void Stop()
    {
        if (!Running) return;
        Running = false;
        PickArmed = false;
        if (_hookThreadId != 0) PostThreadMessageW(_hookThreadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        _hookThread = null;
        lock (_lock) { _trayContext = null; _menuBarRoot = null; _menuStack.Clear(); }
    }

    int NextSeq() { lock (_lock) return ++_seq; }

    static List<string> ModifierNames()
    {
        var out_ = new List<string>();
        bool Down(int vk) => (GetAsyncKeyState(vk) & 0x8000) != 0;
        if (Down(VK_CONTROL)) out_.Add("ctrl");
        if (Down(VK_MENU)) out_.Add("alt");
        if (Down(VK_SHIFT)) out_.Add("shift");
        // The Windows key plays Command's role in the recorded event vocabulary.
        if (Down(VK_LWIN) || Down(VK_RWIN)) out_.Add("cmd");
        return out_;
    }

    // ── Hook callbacks (hook thread; must stay cheap) ────────────────────────

    IntPtr MouseHook(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code < 0 || !Running) return CallNextHookEx(_mouseHook, code, wParam, lParam);
        var msg = (uint)wParam.ToInt64();
        var info = System.Runtime.InteropServices.Marshal.PtrToStructure<MSLLHOOKSTRUCT>(lParam);
        // Our own SendInput traffic (replay, tray.open) is not user input.
        if ((info.flags & LLMHF_INJECTED) != 0) return CallNextHookEx(_mouseHook, code, wParam, lParam);

        switch (msg)
        {
            case WM_LBUTTONDOWN:
            case WM_RBUTTONDOWN:
            case WM_MBUTTONDOWN:
            {
                var isPick = msg == WM_LBUTTONDOWN && PickArmed;
                if (isPick) { PickArmed = false; lock (_lock) _swallowingPickUp = true; }
                var button = msg == WM_RBUTTONDOWN ? "right" : msg == WM_MBUTTONDOWN ? "middle" : "left";
                var count = ClickCount(msg, info.pt, info.time);
                var mods = ModifierNames();
                var seq = NextSeq();
                var (x, y) = (info.pt.x, info.pt.y);
                _queue.Add(() => DescribeClick(seq, x, y, button, count, mods, isPick));
                return isPick ? new IntPtr(1) : CallNextHookEx(_mouseHook, code, wParam, lParam);
            }
            case WM_LBUTTONUP:
            {
                bool swallow;
                lock (_lock) { swallow = _swallowingPickUp; _swallowingPickUp = false; }
                return swallow ? new IntPtr(1) : CallNextHookEx(_mouseHook, code, wParam, lParam);
            }
        }
        return CallNextHookEx(_mouseHook, code, wParam, lParam);
    }

    // Low-level hooks deliver single clicks only; double-clicks are recognised
    // here the way USER32 does it, by time and distance from the previous one.
    uint _lastDownTime; POINT _lastDownPt; uint _lastDownMsg; int _clickCount;
    int ClickCount(uint msg, POINT pt, uint time)
    {
        var dbl = GetDoubleClickTime();
        int cx = GetSystemMetrics(36) / 2, cy = GetSystemMetrics(37) / 2; // SM_CXDOUBLECLK, SM_CYDOUBLECLK
        if (msg == _lastDownMsg && time - _lastDownTime <= dbl && Math.Abs(pt.x - _lastDownPt.x) <= cx && Math.Abs(pt.y - _lastDownPt.y) <= cy) _clickCount++;
        else _clickCount = 1;
        _lastDownTime = time; _lastDownPt = pt; _lastDownMsg = msg;
        return _clickCount;
    }

    IntPtr KeyHook(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code < 0 || !Running) return CallNextHookEx(_keyHook, code, wParam, lParam);
        var msg = (uint)wParam.ToInt64();
        var info = System.Runtime.InteropServices.Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
        if ((info.flags & LLKHF_INJECTED) != 0) return CallNextHookEx(_keyHook, code, wParam, lParam);

        var vk = info.vkCode;
        if (msg is WM_KEYUP or WM_SYSKEYUP) { lock (_lock) _downKeys.Remove(vk); }
        else if (msg is WM_KEYDOWN or WM_SYSKEYDOWN)
        {
            bool isRepeat;
            lock (_lock) isRepeat = !_downKeys.Add(vk);
            // Modifier keys on their own are not keystrokes worth recording.
            if (vk is VK_SHIFT or VK_CONTROL or VK_MENU or VK_LSHIFT or VK_RSHIFT or VK_LCONTROL or VK_RCONTROL or VK_LMENU or VK_RMENU or VK_LWIN or VK_RWIN)
                return CallNextHookEx(_keyHook, code, wParam, lParam);
            var mods = ModifierNames();
            var text = TextFor(vk, info.scanCode);
            var target = GetForegroundWindow();
            var seq = NextSeq();
            _queue.Add(() => DescribeKey(seq, (int)vk, text, mods, target, isRepeat));
        }
        return CallNextHookEx(_keyHook, code, wParam, lParam);
    }

    /// <summary>The character the key produces under the current shift/caps state (empty for control chars).</summary>
    static string TextFor(uint vk, uint scan)
    {
        var state = new byte[256];
        bool Down(int k) => (GetAsyncKeyState(k) & 0x8000) != 0;
        if (Down(VK_SHIFT)) state[VK_SHIFT] = 0x80;
        if ((GetKeyState(VK_CAPITAL) & 1) != 0) state[VK_CAPITAL] = 0x01;
        // Ctrl and Alt are deliberately left out: with them ToUnicode yields
        // control characters, and the Node side wants the key name plus modifiers.
        var layout = GetKeyboardLayout(Tid(GetForegroundWindow()));
        var sb = new StringBuilder(8);
        var n = ToUnicodeEx(vk, scan, state, sb, sb.Capacity, 0, layout);
        if (n <= 0) return "";
        var s = sb.ToString(0, n);
        return s.Any(c => char.IsControl(c)) ? "" : s;
    }

    // ── Describing events (worker thread) ───────────────────────────────────

    void DescribeClick(int seq, int x, int y, string button, int count, List<string> mods, bool pick)
    {
        var data = new Dictionary<string, object?>
        {
            ["seq"] = seq, ["type"] = pick ? "pick" : "click", ["button"] = button, ["count"] = Math.Max(1, count),
            ["modifiers"] = mods, ["x"] = x, ["y"] = y, ["at"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };
        var el = Uia.FromPoint(x, y);
        if (el != null)
        {
            foreach (var (k, v) in Describe.Element(el)) data.TryAdd(k, v);
            Refine(data, el);
        }
        else data["surface"] = "unknown";
        Program.Emit(new() { ["event"] = "record", ["data"] = data });
    }

    /// <summary>
    /// Turns the generic surface from Describe into what the click meant, using
    /// what the recorder saw before: a popup after a tray click is a tray
    /// menu, a popup after a menu-bar click continues that menu's path, and
    /// nested popups extend the path.
    /// </summary>
    void Refine(Dictionary<string, object?> data, IUIAutomationElement el)
    {
        var surface = data["surface"] as string;
        var top = Apps.TopLevelHwndOf(el);
        var title = (data["element"] as Dictionary<string, object?>)?["title"] as string ?? "";
        var hasSubmenu = Props.Read(el, null).HasExpand;
        lock (_lock)
        {
            switch (surface)
            {
                case "tray":
                    _trayContext = new Dictionary<string, object?> { ["item"] = data["trayItem"], ["pid"] = data["pid"], ["app"] = data["app"], ["bundleId"] = data["bundleId"] };
                    _menuBarRoot = null;
                    _menuStack.Clear();
                    _lastTrayClick = DateTime.UtcNow;
                    return;

                case "menuBar":
                    _trayContext = null;
                    _menuStack.Clear();
                    _menuBarRoot = (data["menuPath"] as List<string>)?.ToList() ?? new List<string> { title };
                    return;

                case "contextMenu":
                {
                    // Path bookkeeping: clicking in a popup already on the stack
                    // replaces everything from that level down.
                    var i = _menuStack.FindIndex(m => m.hwnd == top);
                    if (i >= 0) _menuStack.RemoveRange(i, _menuStack.Count - i);
                    _menuStack.Add((top, title));
                    var path = _menuStack.Select(m => m.title).ToList();

                    if (_trayContext != null && (DateTime.UtcNow - _lastTrayClick).TotalSeconds < 120)
                    {
                        data["surface"] = "trayMenu";
                        data["trayItem"] = _trayContext["item"];
                        // The menu belongs to the app that owns the icon, whatever process drew it.
                        if (_trayContext["pid"] is int tp && tp != 0) { data["pid"] = tp; data["app"] = _trayContext["app"]; data["bundleId"] = _trayContext["bundleId"]; }
                        data["menuPath"] = path;
                    }
                    else if (_menuBarRoot != null)
                    {
                        data["surface"] = "menuBar";
                        data["menuPath"] = _menuBarRoot.Concat(path).ToList();
                    }
                    else data["menuPath"] = path;

                    // A leaf click closes the menus; a submenu click keeps them open.
                    if (!hasSubmenu) { _trayContext = null; _menuBarRoot = null; _menuStack.Clear(); }
                    return;
                }

                default:
                    _trayContext = null;
                    _menuBarRoot = null;
                    _menuStack.Clear();
                    return;
            }
        }
    }

    void DescribeKey(int seq, int vk, string text, List<string> mods, IntPtr target, bool isRepeat)
    {
        var pid = target == IntPtr.Zero ? 0 : Pid(target);
        var name = Input.KeyName(vk);
        var key = Input.IsSpecial(vk) ? name : (text.Length > 0 ? text.ToLowerInvariant() : name);
        var data = new Dictionary<string, object?>
        {
            ["seq"] = seq, ["type"] = "key", ["key"] = key ?? text.ToLowerInvariant(), ["text"] = text, ["modifiers"] = mods,
            ["repeat"] = isRepeat, ["pid"] = (int)pid, ["at"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };
        if (pid != 0) { data["app"] = Apps.Name(pid); data["bundleId"] = Apps.BundleId(pid); }
        // The focused element is what typed text lands in; the Node side uses it
        // to turn a run of keystrokes into `find(field).fill(text)`.
        var focus = Uia.Focused();
        if (focus != null) data["focus"] = Describe.Element(focus);
        Program.Emit(new() { ["event"] = "record", ["data"] = data });
    }
}
