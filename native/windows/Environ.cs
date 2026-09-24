using System.Runtime.InteropServices;
using System.Text;
using static Dtf.Native;

namespace Dtf;

/// <summary>Environment facts `dtf doctor` needs and nothing else can see.</summary>
static class Environ
{
    /// <summary>
    /// Focus Assist / Do Not Disturb state.
    ///
    /// The setting has no public API. It is published through WNF as
    /// WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED: 0 = off, 1 = priority only
    /// (Windows 11 calls this "Do not disturb"), 2 = alarms only. Reading a WNF
    /// state is undocumented but stable since Windows 10 1607, and it is what
    /// every third-party Focus Assist toggle uses. Anything else — the
    /// CloudStore registry blob, the notification settings — is either a
    /// serialised opaque struct or lags behind the live state.
    /// </summary>
    public static Dictionary<string, object?> FocusAssist()
    {
        try
        {
            var name = new WNF_STATE_NAME { Data0 = 0xA3BF1C75, Data1 = 0x0D83063E };
            uint size = 4;
            var buf = Marshal.AllocHGlobal(4);
            try
            {
                var status = NtQueryWnfStateData(ref name, IntPtr.Zero, IntPtr.Zero, out _, buf, ref size);
                if (status != 0) return new() { ["state"] = "unknown", ["detail"] = $"NtQueryWnfStateData returned 0x{status:X8}" };
                var v = Marshal.ReadInt32(buf);
                return new()
                {
                    ["state"] = v switch { 0 => "off", 1 => "priorityOnly", 2 => "alarmsOnly", _ => "unknown" },
                    ["raw"] = v,
                };
            }
            finally { Marshal.FreeHGlobal(buf); }
        }
        catch (Exception e)
        {
            return new() { ["state"] = "unknown", ["detail"] = e.Message };
        }
    }

    /// <summary>
    /// Whether this session can actually be driven: unlocked, with an
    /// interactive desktop. A locked or disconnected RDP session keeps UIA
    /// mostly working while every click and keystroke silently goes nowhere —
    /// the same symptom a locked screen produces on macOS.
    /// </summary>
    public static Dictionary<string, object?> SessionInfo()
    {
        bool? locked = null; string state = "unknown";
        try
        {
            if (WTSQuerySessionInformationW(IntPtr.Zero, WTS_CURRENT_SESSION, WTSSessionInfoEx, out var buf, out var bytes) && buf != IntPtr.Zero)
            {
                try
                {
                    // WTSINFOEXW { DWORD Level; WTSINFOEX_LEVEL Data; } with
                    // LEVEL1 { DWORD SessionId; WTS_CONNECTSTATE_CLASS State; LONG SessionFlags; ... }
                    var level = Marshal.ReadInt32(buf);
                    if (level == 1)
                    {
                        var conn = Marshal.ReadInt32(buf, 8 + 4);
                        var flags = Marshal.ReadInt32(buf, 8 + 8);
                        state = conn switch { 0 => "active", 1 => "connected", 4 => "disconnected", 5 => "idle", _ => $"state{conn}" };
                        // 0 = WTS_SESSIONSTATE_LOCK, 1 = WTS_SESSIONSTATE_UNLOCK (Windows 8+ semantics).
                        if (flags == 0) locked = true; else if (flags == 1) locked = false;
                    }
                }
                finally { WTSFreeMemory(buf); }
            }
        }
        catch { }
        if (locked == null)
        {
            // Fallback: the input desktop is "Winlogon" while the lock screen is up.
            var d = OpenInputDesktop(0, false, 0x0001);
            if (d != IntPtr.Zero)
            {
                var sb = new StringBuilder(256);
                if (GetUserObjectInformationW(d, 2, sb, sb.Capacity, out _)) locked = !sb.ToString().Equals("Default", StringComparison.OrdinalIgnoreCase);
                CloseDesktop(d);
            }
        }
        return new()
        {
            ["locked"] = locked,
            ["connectState"] = state,
            ["interactive"] = Environment.UserInteractive,
            ["elevated"] = IsElevated(0),
        };
    }
}

/// <summary>
/// App permissions via the CapabilityAccessManager consent store.
///
/// Unlike macOS's SIP-protected TCC.db these registry values are writable by
/// the user, so a test can reset *and pre-grant* camera, microphone or location
/// access for the app under test. Per-app entries for classic desktop apps live
/// under `<capability>\NonPackaged\<exe path with backslashes as #>`; packaged
/// apps use their package family name directly under `<capability>`.
/// </summary>
static class Permissions
{
    const string Root = @"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore";

    static string KeyFor(string capability, string app)
    {
        var isPath = app.Contains('\\') || app.Contains(':');
        return isPath ? $@"{Root}\{capability}\NonPackaged\{app.Replace('\\', '#')}" : $@"{Root}\{capability}\{app}";
    }

    public static Dictionary<string, object?> Read(string capability, string app)
    {
        using var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(KeyFor(capability, app));
        var v = k?.GetValue("Value") as string;
        // Absent entry: the capability's global default applies (also "Value" on the capability key).
        string? global = null;
        using (var g = Microsoft.Win32.Registry.CurrentUser.OpenSubKey($@"{Root}\{capability}")) global = g?.GetValue("Value") as string;
        return new() { ["value"] = v, ["global"] = global, ["exists"] = k != null };
    }

    public static Dictionary<string, object?> Write(string capability, string app, string? value)
    {
        var path = KeyFor(capability, app);
        if (value == null)
        {
            // Reset: forget the app's answer so the next request prompts again
            // (or falls back to the global default, for capabilities that never prompt).
            try { Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(path, false); } catch { }
            return new() { ["ok"] = true, ["reset"] = true };
        }
        using var k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(path, true) ?? throw new OpError("permissionWriteFailed", $"could not create HKCU\\{path}");
        k.SetValue("Value", value, Microsoft.Win32.RegistryValueKind.String);
        return new() { ["ok"] = true, ["value"] = value };
    }
}
