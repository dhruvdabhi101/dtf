using System.Diagnostics;
using System.Drawing;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

namespace DtfFixture;

// DTF Fixture — a deliberately small app that exercises every OS surface the
// framework claims to test: a notification-area icon with a nested menu, native
// alerts, a save dialog, OS notifications, and a close-to-tray lifecycle.
//
// It is the Windows twin of fixtures/tray-app/main.swift and prints the same
// log lines, so the framework's own suite drives both without changes.

static class Program
{
    /// <summary>
    /// Plain-text logging over the pipe the framework gives us. A WinExe has no
    /// console of its own (Console.OutputEncoding even throws), but writing to
    /// the inherited stdout handle works.
    /// </summary>
    public static readonly TextWriter Stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
    public static readonly TextWriter Stderr = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { AutoFlush = true };
    public static void Log(string line) { try { Stdout.WriteLine(line); } catch { } }
    public static void Warn(string line) { try { Stderr.WriteLine(line); } catch { } }

    public const string Scheme = "dtffixture";
    public const string Aumid = "com.dtf.fixture";
    const string PipeName = "dtf-fixture-deeplink";
    const string MutexName = @"Local\dtf-fixture-single-instance";

    [STAThread]
    static int Main(string[] args)
    {

        var deepLinks = args.Where(a => a.StartsWith(Scheme + "://", StringComparison.OrdinalIgnoreCase)).ToList();

        // Single instance. A protocol activation launches a second copy with
        // the URL in argv; hand it to the running instance and quit, the way a
        // real Windows app does (there is no LaunchServices to do it for us).
        using var mutex = new Mutex(true, MutexName, out var first);
        if (!first)
        {
            foreach (var url in deepLinks) ForwardDeepLink(url);
            return 0;
        }

        RegisterScheme();
        RegisterAumid();

        ApplicationConfiguration.Initialize();
        var app = new FixtureContext(deepLinks);
        Application.Run(app);
        return 0;
    }

    static void ForwardDeepLink(string url)
    {
        try
        {
            using var pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.Out);
            pipe.Connect(2000);
            var bytes = Encoding.UTF8.GetBytes(url);
            pipe.Write(bytes, 0, bytes.Length);
            pipe.Flush();
        }
        catch (Exception e)
        {
            Program.Warn($"deeplink-forward-failed {e.Message}");
        }
    }

    /// <summary>
    /// Registers dtffixture:// for this user (HKCU, no elevation) pointing at
    /// this executable — the equivalent of CFBundleURLTypes, done at launch
    /// because nothing installs the fixture.
    /// </summary>
    static void RegisterScheme()
    {
        try
        {
            var exe = Environment.ProcessPath ?? Application.ExecutablePath;
            using var k = Registry.CurrentUser.CreateSubKey($@"Software\Classes\{Scheme}");
            k.SetValue("", $"URL:{Scheme} protocol");
            k.SetValue("URL Protocol", "");
            using var cmd = k.CreateSubKey(@"shell\open\command");
            cmd.SetValue("", $"\"{exe}\" \"%1\"");
        }
        catch (Exception e) { Program.Warn($"scheme-register-failed {e.Message}"); }
    }

    /// <summary>
    /// Toasts from an unpackaged app need an AppUserModelID the shell knows a
    /// display name for; registering it under HKCU\Software\Classes\AppUserModelId
    /// is what the Windows Community Toolkit does too, and it needs no shortcut.
    /// </summary>
    static void RegisterAumid()
    {
        try
        {
            using var k = Registry.CurrentUser.CreateSubKey($@"Software\Classes\AppUserModelId\{Aumid}");
            k.SetValue("DisplayName", "DTF Fixture");
            SetCurrentProcessExplicitAppUserModelID(Aumid);
        }
        catch (Exception e) { Program.Warn($"aumid-register-failed {e.Message}"); }
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SetCurrentProcessExplicitAppUserModelID(string id);

    public static void StartPipeServer(Action<string> onUrl)
    {
        var t = new Thread(() =>
        {
            while (true)
            {
                try
                {
                    using var server = new NamedPipeServerStream(PipeName, PipeDirection.In, 1);
                    server.WaitForConnection();
                    using var reader = new StreamReader(server, Encoding.UTF8);
                    var url = reader.ReadToEnd().Trim();
                    if (url.Length > 0) onUrl(url);
                }
                catch (Exception e) { Program.Warn($"pipe-error {e.Message}"); Thread.Sleep(200); }
            }
        }) { IsBackground = true, Name = "deeplink-pipe" };
        t.Start();
    }
}

sealed class FixtureContext : ApplicationContext
{
    readonly NotifyIcon _tray;
    readonly ContextMenuStrip _trayMenu;
    readonly MainForm _window;
    int _count;
    string? _signedInAs;

    public FixtureContext(List<string> deepLinks)
    {
        _window = new MainForm(this);
        _trayMenu = BuildTrayMenu();
        _tray = new NotifyIcon
        {
            // The tooltip is what the OS exposes as the icon's accessible name,
            // and it is set before the icon is shown so Explorer records it.
            Text = "DTF Fixture",
            Icon = MakeIcon(),
            ContextMenuStrip = _trayMenu,
            Visible = true,
        };
        // Left-click opens the same menu as right-click, matching the NSMenu
        // status item on macOS so `app.tray.open()` behaves the same.
        _tray.MouseUp += (_, e) => { if (e.Button == MouseButtons.Left) ShowTrayMenu(); };

        Program.StartPipeServer((url) => _window.BeginInvoke(() => HandleDeepLink(url)));
        // A cold launch carries the URL in argv rather than through the pipe.
        foreach (var url in deepLinks) HandleDeepLink(url);

        _window.Show();
        _window.Activate();
        Log("fixture-ready");
    }

    static void Log(string line) => Program.Log(line);

    // MARK: Tray

    ContextMenuStrip BuildTrayMenu()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("Show Window", null, (_, _) => ShowWindow());
        menu.Items.Add("Send Notification", null, (_, _) => SendNotification());
        menu.Items.Add("Increment Counter", null, (_, _) => Increment());
        var advanced = new ToolStripMenuItem("Advanced");
        advanced.DropDownItems.Add("Nested Action", null, (_, _) => Log("nested-action-fired"));
        advanced.DropDownItems.Add(new ToolStripMenuItem("Disabled Item") { Enabled = false });
        menu.Items.Add(advanced);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit", null, (_, _) => Quit());
        RebuildStatusMenu(menu);
        return menu;
    }

    /// <summary>Mirrors the auth state into the tray, the way a real tray app does.</summary>
    void RebuildStatusMenu(ContextMenuStrip? menu = null)
    {
        menu ??= _trayMenu;
        foreach (var old in menu.Items.OfType<ToolStripItem>().Where(i => i.Text == "Sign in" || (i.Text?.StartsWith("Signed in as ") ?? false)).ToList())
            menu.Items.Remove(old);
        ToolStripMenuItem item;
        if (_signedInAs != null) item = new ToolStripMenuItem($"Signed in as {_signedInAs}") { Enabled = false };
        else
        {
            item = new ToolStripMenuItem("Sign in");
            item.Click += (_, _) => SignIn();
        }
        menu.Items.Insert(0, item);
    }

    void ShowTrayMenu()
    {
        // NotifyIcon only opens its menu on right-click; the method that does it
        // is private, and calling it is the standard way to get a left-click menu.
        typeof(NotifyIcon).GetMethod("ShowContextMenu", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)
            ?.Invoke(_tray, null);
    }

    static Icon MakeIcon()
    {
        using var bmp = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bmp))
        {
            g.Clear(Color.Transparent);
            g.FillEllipse(Brushes.DodgerBlue, 2, 2, 28, 28);
            using var f = new Font("Segoe UI", 14, FontStyle.Bold, GraphicsUnit.Pixel);
            g.DrawString("D", f, Brushes.White, 9, 7);
        }
        return Icon.FromHandle(bmp.GetHicon());
    }

    // MARK: Actions

    public void ShowWindow()
    {
        _window.Show();
        _window.WindowState = FormWindowState.Normal;
        _window.Activate();
        Log("window-shown");
    }

    public void HideWindow()
    {
        _window.Hide();
        Log("window-hidden");
    }

    public void Increment()
    {
        _count++;
        _window.SetCount(_count);
        Log($"count={_count}");
    }

    /// <summary>Hands off to the system browser exactly as a real OAuth client would.</summary>
    void SignIn()
    {
        var url = "https://example.com/oauth/authorize?client_id=dtf-fixture&redirect_uri=dtffixture%3A%2F%2Fauth"
            + "&response_type=code&scope=openid%20profile&code_challenge_method=S256&code_challenge=fake-pkce-challenge";
        Log($"signin-opening-browser url={url}");
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch (Exception e) { Program.Warn($"browser-open-failed {e.Message}"); }
    }

    /// <summary>The other half of a browser sign-in: the app is re-entered through its custom scheme.</summary>
    void HandleDeepLink(string raw)
    {
        Log($"deeplink-received url={raw}");
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var url) || url.Host != "auth") return;
        var q = global::System.Web.HttpUtility.ParseQueryString(url.Query);
        var token = q["token"];
        if (string.IsNullOrEmpty(token))
        {
            Log("auth-failed reason=missing-token");
            return;
        }
        _signedInAs = q["email"] ?? "unknown";
        Log($"auth-success user={_signedInAs}");
        RebuildStatusMenu();
    }

    /// <summary>
    /// Posts an OS notification: a toast with title, subtitle and body lines,
    /// attributed to "DTF Fixture" through the registered AUMID. Falls back to a
    /// NotifyIcon balloon (which Windows 10+ also renders as a toast) if the
    /// WinRT route is unavailable.
    /// </summary>
    public void SendNotification()
    {
        var body = $"Notification body {_count}";
        try
        {
            var xml = new Windows.Data.Xml.Dom.XmlDocument();
            xml.LoadXml($"<toast><visual><binding template=\"ToastGeneric\"><text>DTF Fixture</text><text>Subtitle line</text><text>{body}</text></binding></visual></toast>");
            var toast = new Windows.UI.Notifications.ToastNotification(xml);
            Windows.UI.Notifications.ToastNotificationManager.CreateToastNotifier(Program.Aumid).Show(toast);
            Log("notification-sent via=toast");
        }
        catch (Exception e)
        {
            Program.Warn($"toast-failed {e.Message}");
            _tray.ShowBalloonTip(5000, "DTF Fixture", $"Subtitle line\n{body}", ToolTipIcon.Info);
            Log("notification-sent via=balloon");
        }
    }

    public void ShowAlert()
    {
        ShowWindow();
        var confirm = new TaskDialogButton("Confirm");
        var page = new TaskDialogPage
        {
            Caption = "DTF Fixture",
            Heading = "Are you sure?",
            Text = "This is a native alert from the DTF fixture.",
            Buttons = { confirm, TaskDialogButton.Cancel },
        };
        var result = TaskDialog.ShowDialog(_window, page);
        Log($"alert-result={(result == confirm ? "confirm" : "cancel")}");
    }

    public void ShowSavePanel()
    {
        using var dlg = new SaveFileDialog { Title = "Save Fixture File", FileName = "fixture.txt", Filter = "Text files|*.txt|All files|*.*" };
        var r = dlg.ShowDialog(_window);
        Log($"save-result={(r == DialogResult.OK ? dlg.FileName : "cancelled")}");
    }

    public void Quit()
    {
        Log("quitting");
        _tray.Visible = false;
        _tray.Dispose();
        Application.Exit();
    }
}

sealed class MainForm : Form
{
    readonly FixtureContext _ctx;
    readonly Label _counter;

    public MainForm(FixtureContext ctx)
    {
        _ctx = ctx;
        Text = "DTF Fixture";
        // Control.Name is what WinForms reports as the UIA AutomationId.
        Name = "main-window";
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(460, 320);
        MinimumSize = new Size(300, 200);

        var menu = new MenuStrip { Name = "main-menu" };
        var file = new ToolStripMenuItem("File");
        static ToolStripMenuItem Item(string text, Keys shortcut, Action action)
        {
            var i = new ToolStripMenuItem(text) { ShortcutKeys = shortcut };
            i.Click += (_, _) => action();
            return i;
        }
        file.DropDownItems.Add(Item("New Note", Keys.Control | Keys.N, _ctx.Increment));
        file.DropDownItems.Add(Item("Save…", Keys.Control | Keys.S, _ctx.ShowSavePanel));
        file.DropDownItems.Add(new ToolStripSeparator());
        file.DropDownItems.Add(Item("Close Window", Keys.Control | Keys.W, _ctx.HideWindow));
        file.DropDownItems.Add(new ToolStripSeparator());
        file.DropDownItems.Add(Item("Quit DTF Fixture", Keys.Control | Keys.Q, _ctx.Quit));
        var edit = new ToolStripMenuItem("Edit");
        edit.DropDownItems.Add("Cut", null, (_, _) => (ActiveControl as TextBox)?.Cut());
        edit.DropDownItems.Add("Copy", null, (_, _) => (ActiveControl as TextBox)?.Copy());
        edit.DropDownItems.Add("Paste", null, (_, _) => (ActiveControl as TextBox)?.Paste());
        edit.DropDownItems.Add("Select All", null, (_, _) => (ActiveControl as TextBox)?.SelectAll());
        var window = new ToolStripMenuItem("Window");
        window.DropDownItems.Add("Minimize", null, (_, _) => WindowState = FormWindowState.Minimized);
        window.DropDownItems.Add("Show Window", null, (_, _) => _ctx.ShowWindow());
        var help = new ToolStripMenuItem("Help");
        help.DropDownItems.Add("About DTF Fixture", null, (_, _) => MessageBox.Show(this, "DTF Fixture 1.0", "About DTF Fixture"));
        menu.Items.AddRange(new ToolStripItem[] { file, edit, window, help });
        MainMenuStrip = menu;
        Controls.Add(menu);

        var stack = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true, Location = new Point(24, 48), Padding = Padding.Empty };
        _counter = new Label { Name = "counter-label", Text = "Count: 0", AutoSize = true, Margin = new Padding(0, 0, 0, 10) };
        stack.Controls.Add(_counter);

        var field = new TextBox { Name = "demo-field", PlaceholderText = "Type something", Width = 260, Margin = new Padding(0, 0, 0, 10), AccessibleName = "Type something" };
        stack.Controls.Add(field);

        foreach (var (title, action) in new (string, Action)[]
        {
            ("Increment", _ctx.Increment),
            ("Send Notification", _ctx.SendNotification),
            ("Show Alert", _ctx.ShowAlert),
            ("Save File…", _ctx.ShowSavePanel),
        })
        {
            var b = new Button { Text = title, Name = $"btn-{title.ToLowerInvariant().Replace(' ', '-')}", AutoSize = true, Margin = new Padding(0, 0, 0, 6) };
            b.Click += (_, _) => action();
            stack.Controls.Add(b);
        }
        Controls.Add(stack);
    }

    public void SetCount(int n) => _counter.Text = $"Count: {n}";

    /// <summary>
    /// Closing hides the window instead of quitting — the classic tray-app
    /// behaviour, and exactly the lifecycle an in-process test cannot verify.
    /// </summary>
    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            _ctx.HideWindow();
            return;
        }
        base.OnFormClosing(e);
    }
}
