using System.Text;
using System.Text.Json;

namespace Dtf;

// dtfd-windows — the Windows native driver for the Desktop Testing Framework.
//
// Protocol: newline-delimited JSON over stdin/stdout, identical to dtfd-macos.
// One request per line:
//   {"id": 1, "op": "tray.list", "args": {}}
// One response per line:
//   {"id": 1, "ok": true, "result": ...}
//   {"id": 1, "ok": false, "error": {"code": "...", "message": "..."}}
//
// Diagnostics go to stderr so they never corrupt the stream.

static class Program
{
    /// <summary>
    /// Responses (main thread) and recorder events (recorder worker) share
    /// stdout, so every write is serialised: an interleaved half-line would
    /// corrupt the stream.
    /// </summary>
    static readonly object EmitLock = new();
    static readonly Stream Out = Console.OpenStandardOutput();
    static readonly JsonSerializerOptions JsonOpts = new() { WriteIndented = false, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public static void Emit(Dictionary<string, object?> payload)
    {
        byte[] bytes;
        try
        {
            bytes = JsonSerializer.SerializeToUtf8Bytes(payload, JsonOpts);
        }
        catch (Exception e)
        {
            Warn($"result was not JSON-encodable: {e.Message}");
            bytes = Encoding.UTF8.GetBytes("{\"ok\":false,\"error\":{\"code\":\"encodeFailed\",\"message\":\"result was not JSON-encodable\"}}");
        }
        lock (EmitLock)
        {
            Out.Write(bytes, 0, bytes.Length);
            Out.WriteByte((byte)'\n');
            Out.Flush();
        }
    }

    public static void Warn(string s)
    {
        try { Console.Error.WriteLine(s); } catch { }
    }

    // UIA is a COM API and the recorder needs a free-threaded caller: element
    // handles are created on this thread and used from the recorder's worker
    // and from non-blocking action threads. An MTA makes that legal without
    // marshalling.
    [MTAThread]
    static int Main(string[] args)
    {
        // The manifest declares PerMonitorV2, and this call covers the case of
        // being launched in a way that ignores the manifest. UIA reports
        // physical pixels; a DPI-unaware process gets virtualised coordinates
        // and every click on a scaled display lands short.
        try { Native.SetProcessDpiAwarenessContext(Native.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); } catch { }

        var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));

        Emit(new()
        {
            ["event"] = "ready", ["version"] = "1.1.0", ["platform"] = "win32", ["protocol"] = 1,
            // No Accessibility permission exists on Windows: any interactive
            // process may read UIA and synthesise input.
            ["trusted"] = true,
        });

        string? line;
        while ((line = stdin.ReadLine()) != null)
        {
            if (line.Length == 0) continue;
            JsonDocument doc;
            try { doc = JsonDocument.Parse(line); }
            catch
            {
                Emit(new() { ["ok"] = false, ["error"] = Err("badRequest", "line was not a JSON object") });
                continue;
            }
            using (doc)
            {
                var root = doc.RootElement;
                if (root.ValueKind != JsonValueKind.Object)
                {
                    Emit(new() { ["ok"] = false, ["error"] = Err("badRequest", "line was not a JSON object") });
                    continue;
                }
                long id = root.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.Number ? idEl.GetInt64() : -1;
                if (!root.TryGetProperty("op", out var opEl) || opEl.ValueKind != JsonValueKind.String)
                {
                    Emit(new() { ["id"] = id, ["ok"] = false, ["error"] = Err("badRequest", "missing 'op'") });
                    continue;
                }
                var op = opEl.GetString()!;
                var opArgs = new Args(root.TryGetProperty("args", out var a) && a.ValueKind == JsonValueKind.Object ? a.Clone() : default);

                if (op == "shutdown")
                {
                    Recorder.Shared.Stop();
                    Emit(new() { ["id"] = id, ["ok"] = true, ["result"] = new Dictionary<string, object?> { ["ok"] = true } });
                    return 0;
                }
                if (op == "gc")
                {
                    // Element refs pin IUIAutomationElements; tests call this between cases.
                    Registry.Shared.Clear();
                    Emit(new() { ["id"] = id, ["ok"] = true, ["result"] = new Dictionary<string, object?> { ["ok"] = true } });
                    continue;
                }

                try
                {
                    var result = Ops.Dispatch(op, opArgs);
                    Emit(new() { ["id"] = id, ["ok"] = true, ["result"] = result });
                }
                catch (OpError e)
                {
                    Emit(new() { ["id"] = id, ["ok"] = false, ["error"] = Err(e.Code, e.Message) });
                }
                catch (Exception e)
                {
                    Emit(new() { ["id"] = id, ["ok"] = false, ["error"] = Err("internal", e.ToString()) });
                }
            }
        }
        Recorder.Shared.Stop();
        return 0;
    }

    static Dictionary<string, object?> Err(string code, string message) => new() { ["code"] = code, ["message"] = message };
}

/// <summary>A failure with a stable code the Node side can branch on (`notFound`, `staleRef`, ...).</summary>
sealed class OpError : Exception
{
    public string Code { get; }
    public OpError(string code, string message) : base(message) { Code = code; }
}

/// <summary>Typed access to a request's `args` object.</summary>
readonly struct Args
{
    readonly JsonElement _el;
    public Args(JsonElement el) { _el = el; }

    bool TryGet(string key, out JsonElement v)
    {
        v = default;
        return _el.ValueKind == JsonValueKind.Object && _el.TryGetProperty(key, out v) && v.ValueKind != JsonValueKind.Null;
    }

    public bool Has(string key) => TryGet(key, out _);
    public JsonElement Raw(string key) => TryGet(key, out var v) ? v : default;

    public string? Str(string key) => TryGet(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    public int? Int(string key) => TryGet(key, out var v) && v.ValueKind == JsonValueKind.Number ? (int)Math.Round(v.GetDouble()) : null;
    public double? Dbl(string key) => TryGet(key, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : null;
    public bool? Bool(string key) => TryGet(key, out var v) && (v.ValueKind == JsonValueKind.True || v.ValueKind == JsonValueKind.False) ? v.GetBoolean() : null;

    public List<string> StrList(string key)
    {
        var out_ = new List<string>();
        if (TryGet(key, out var v) && v.ValueKind == JsonValueKind.Array)
            foreach (var x in v.EnumerateArray()) if (x.ValueKind == JsonValueKind.String) out_.Add(x.GetString()!);
        return out_;
    }

    public string RequireStr(string key) => Str(key) ?? throw new OpError("badArgs", $"missing string arg '{key}'");
    public int RequireInt(string key) => Int(key) ?? throw new OpError("badArgs", $"missing integer arg '{key}'");
}
