/**
 * Win32 calls the perf sampler and the chaos faults need, as C# compiled at
 * run time by PowerShell's `Add-Type`.
 *
 * Kept to C# 5 (what Windows PowerShell 5.1 compiles): no string
 * interpolation, no `?.`, no expression-bodied members.
 */
export const WIN32_CS = String.raw`
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class DtfNative {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct PROCESSENTRY32 {
    public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID;
    public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase;
    public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_MEMORY_COUNTERS_EX {
    public uint cb; public uint PageFaultCount; public UIntPtr PeakWorkingSetSize; public UIntPtr WorkingSetSize;
    public UIntPtr QuotaPeakPagedPoolUsage; public UIntPtr QuotaPagedPoolUsage; public UIntPtr QuotaPeakNonPagedPoolUsage;
    public UIntPtr QuotaNonPagedPoolUsage; public UIntPtr PagefileUsage; public UIntPtr PeakPagefileUsage; public UIntPtr PrivateUsage;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS {
    public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
    public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct MEMORYSTATUSEX {
    public uint dwLength; public uint dwMemoryLoad; public ulong ullTotalPhys; public ulong ullAvailPhys;
    public ulong ullTotalPageFile; public ulong ullAvailPageFile; public ulong ullTotalVirtual; public ulong ullAvailVirtual; public ulong ullAvailExtendedVirtual;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_CPU_RATE_CONTROL_INFORMATION { public uint ControlFlags; public uint CpuRate; }

  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32 e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32 e);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long create, out long exit, out long kernel, out long user);
  [DllImport("psapi.dll")] static extern bool GetProcessMemoryInfo(IntPtr h, out PROCESS_MEMORY_COUNTERS_EX c, uint cb);
  [DllImport("kernel32.dll")] static extern bool GetProcessIoCounters(IntPtr h, out IO_COUNTERS c);
  [DllImport("kernel32.dll")] static extern bool GetProcessHandleCount(IntPtr h, out uint count);
  [DllImport("kernel32.dll")] static extern bool GetSystemTimes(out long idle, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX m);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("ntdll.dll")] static extern int NtSuspendProcess(IntPtr h);
  [DllImport("ntdll.dll")] static extern int NtResumeProcess(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attrs, string name);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint len);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr srcProc, IntPtr src, IntPtr dstProc, out IntPtr dst, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();

  const uint QUERY_LIMITED = 0x1000, TERMINATE = 0x0001, SUSPEND_RESUME = 0x0800, SET_QUOTA = 0x0100, DUP_HANDLE = 0x0040, JOB_ALL = 0x1F001F;

  public class Proc { public uint Pid; public uint Ppid; public uint Threads; public string Name; }

  public static List<Proc> Snapshot() {
    List<Proc> list = new List<Proc>();
    IntPtr snap = CreateToolhelp32Snapshot(0x2, 0);
    if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return list;
    try {
      PROCESSENTRY32 e = new PROCESSENTRY32();
      e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
      if (Process32FirstW(snap, ref e)) {
        do {
          Proc p = new Proc(); p.Pid = e.th32ProcessID; p.Ppid = e.th32ParentProcessID; p.Threads = e.cntThreads; p.Name = e.szExeFile;
          list.Add(p);
        } while (Process32NextW(snap, ref e));
      }
    } finally { CloseHandle(snap); }
    return list;
  }

  static string Esc(string s) {
    StringBuilder b = new StringBuilder();
    foreach (char c in s) {
      if (c == '"' || c == '\\') { b.Append('\\'); b.Append(c); }
      else if (c < ' ') b.Append(' ');
      else b.Append(c);
    }
    return b.ToString();
  }

  /** Every process in the trees rooted at 'pids', or at a process named in 'names' whose parent is not. */
  static List<Proc> Select(List<Proc> all, HashSet<uint> pids, HashSet<string> names) {
    Dictionary<uint, Proc> byPid = new Dictionary<uint, Proc>();
    foreach (Proc p in all) byPid[p.Pid] = p;
    HashSet<uint> inSet = new HashSet<uint>();
    foreach (Proc p in all) {
      if (pids.Contains(p.Pid) || names.Contains(p.Name.ToLowerInvariant())) inSet.Add(p.Pid);
    }
    bool grew = true;
    while (grew) {
      grew = false;
      foreach (Proc p in all) {
        if (!inSet.Contains(p.Pid) && p.Ppid != 0 && p.Ppid != p.Pid && inSet.Contains(p.Ppid)) { inSet.Add(p.Pid); grew = true; }
      }
    }
    List<Proc> result = new List<Proc>();
    foreach (Proc p in all) if (inSet.Contains(p.Pid)) result.Add(p);
    return result;
  }

  static void AppendStats(StringBuilder b, Proc p) {
    IntPtr h = OpenProcess(QUERY_LIMITED, false, p.Pid);
    long cpu = -1; ulong priv = 0, ws = 0, ioR = 0, ioW = 0; uint handles = 0; long created = 0;
    if (h != IntPtr.Zero) {
      try {
        long c, x, k, u;
        if (GetProcessTimes(h, out c, out x, out k, out u)) { cpu = k + u; created = c; }
        PROCESS_MEMORY_COUNTERS_EX m;
        if (GetProcessMemoryInfo(h, out m, (uint)Marshal.SizeOf(typeof(PROCESS_MEMORY_COUNTERS_EX)))) { priv = m.PrivateUsage.ToUInt64(); ws = m.WorkingSetSize.ToUInt64(); }
        IO_COUNTERS io;
        if (GetProcessIoCounters(h, out io)) { ioR = io.ReadTransferCount; ioW = io.WriteTransferCount; }
        GetProcessHandleCount(h, out handles);
      } finally { CloseHandle(h); }
    }
    b.Append('[').Append(p.Pid).Append(',').Append(p.Ppid).Append(",\"").Append(Esc(p.Name)).Append("\",")
      .Append(cpu).Append(',').Append(priv).Append(',').Append(ws).Append(',').Append(ioR).Append(',').Append(ioW)
      .Append(',').Append(handles).Append(',').Append(p.Threads).Append(',').Append(created).Append(']');
  }

  /**
   * The sampler: prints one JSON line per tick until the parent process (the
   * test runner) is gone. CPU times are cumulative 100ns units; the runner
   * turns them into percentages from the deltas.
   */
  public static void Sample(int[] pidArr, string[] nameArr, int intervalMs, int parentPid) {
    HashSet<uint> pids = new HashSet<uint>();
    foreach (int p in pidArr) pids.Add((uint)p);
    HashSet<string> names = new HashSet<string>();
    foreach (string n in nameArr) if (n.Length > 0) names.Add(n.ToLowerInvariant());
    int cores = Environment.ProcessorCount;
    while (true) {
      try { Process.GetProcessById(parentPid); } catch (ArgumentException) { return; }
      long t0 = Stopwatch.GetTimestamp();
      StringBuilder b = new StringBuilder();
      long idle, kern, user;
      GetSystemTimes(out idle, out kern, out user);
      MEMORYSTATUSEX ms = new MEMORYSTATUSEX(); ms.dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX));
      GlobalMemoryStatusEx(ref ms);
      long rx = 0, tx = 0;
      try {
        foreach (NetworkInterface ni in NetworkInterface.GetAllNetworkInterfaces()) {
          if (ni.NetworkInterfaceType == NetworkInterfaceType.Loopback || ni.OperationalStatus != OperationalStatus.Up) continue;
          IPInterfaceStatistics s = ni.GetIPStatistics();
          rx += s.BytesReceived; tx += s.BytesSent;
        }
      } catch (Exception) { }
      long now = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
      b.Append("{\"t\":").Append(now).Append(",\"cores\":").Append(cores)
        .Append(",\"sys\":[").Append(idle).Append(',').Append(kern).Append(',').Append(user).Append(',')
        .Append(ms.ullTotalPhys).Append(',').Append(ms.ullAvailPhys).Append(',').Append(rx).Append(',').Append(tx).Append("],\"p\":[");
      bool first = true;
      foreach (Proc p in Select(Snapshot(), pids, names)) {
        if (!first) b.Append(',');
        first = false;
        AppendStats(b, p);
      }
      b.Append("]}");
      Console.Out.WriteLine(b.ToString());
      Console.Out.Flush();
      long spent = (Stopwatch.GetTimestamp() - t0) * 1000 / Stopwatch.Frequency;
      int wait = intervalMs - (int)spent;
      if (wait > 0) Thread.Sleep(wait);
    }
  }

  /** Processes with their parent, for picking a victim out of an app's tree. */
  public static string List() {
    StringBuilder b = new StringBuilder("[");
    bool first = true;
    foreach (Proc p in Snapshot()) {
      if (!first) b.Append(',');
      first = false;
      b.Append('[').Append(p.Pid).Append(',').Append(p.Ppid).Append(",\"").Append(Esc(p.Name)).Append("\"]");
    }
    return b.Append(']').ToString();
  }

  static IntPtr Open(uint access, int pid) {
    IntPtr h = OpenProcess(access, false, (uint)pid);
    if (h == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcess(" + pid + ")");
    return h;
  }

  public static void Suspend(int pid) { IntPtr h = Open(SUSPEND_RESUME, pid); try { int s = NtSuspendProcess(h); if (s != 0) throw new Exception("NtSuspendProcess: 0x" + s.ToString("X")); } finally { CloseHandle(h); } }
  public static void Resume(int pid) { IntPtr h = Open(SUSPEND_RESUME, pid); try { int s = NtResumeProcess(h); if (s != 0) throw new Exception("NtResumeProcess: 0x" + s.ToString("X")); } finally { CloseHandle(h); } }

  /** Ends a process with an exit code, e.g. 0xC0000005 so it reads as an access violation. */
  public static void Terminate(int pid, uint code) {
    IntPtr h = Open(TERMINATE, pid);
    try { if (!TerminateProcess(h, code)) throw new Win32Exception(Marshal.GetLastWin32Error(), "TerminateProcess"); } finally { CloseHandle(h); }
  }

  static IntPtr Job(string name, bool create) {
    IntPtr job = create ? CreateJobObjectW(IntPtr.Zero, name) : OpenJobObjectW(JOB_ALL, false, name);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), (create ? "CreateJobObject " : "OpenJobObject ") + name);
    return job;
  }

  static void SetInfo<T>(IntPtr job, int cls, T info) {
    int len = Marshal.SizeOf(typeof(T));
    IntPtr mem = Marshal.AllocHGlobal(len);
    try {
      Marshal.StructureToPtr(info, mem, false);
      if (!SetInformationJobObject(job, cls, mem, (uint)len)) throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject(" + cls + ")");
    } finally { Marshal.FreeHGlobal(mem); }
  }

  /**
   * Puts processes into a named job and caps it. 'cpuPercent' is a share of the
   * whole machine (all cores); 'memoryBytes' a limit on the job's committed
   * memory. 0 leaves that limit off. Returns the pids that could not be
   * assigned (e.g. sandboxed renderers in a job that forbids nesting).
   *
   * The job is named so a later process (the watchdog, 'dtf chaos restore')
   * can open it again and lift the limits. A job outlives its handles while
   * processes are in it, but its *name* does not: the name goes with the last
   * handle. So a duplicate handle is parked in the first capped process (the
   * app's main one), which keeps the name exactly as long as the app lives.
   */
  public static string Cap(string name, int[] pids, double cpuPercent, long memoryBytes) {
    IntPtr job = Job(name, true);
    StringBuilder failed = new StringBuilder("[");
    try {
      bool first = true, parked = false;
      foreach (int pid in pids) {
        IntPtr h = OpenProcess(SET_QUOTA | TERMINATE | DUP_HANDLE, false, (uint)pid);
        if (h == IntPtr.Zero) h = OpenProcess(SET_QUOTA | TERMINATE, false, (uint)pid);
        bool ok = h != IntPtr.Zero && AssignProcessToJobObject(job, h);
        if (ok && !parked) {
          IntPtr dup;
          parked = DuplicateHandle(GetCurrentProcess(), job, h, out dup, 0, false, 2 /* DUPLICATE_SAME_ACCESS */);
        }
        if (h != IntPtr.Zero) CloseHandle(h);
        if (!ok) { if (!first) failed.Append(','); first = false; failed.Append(pid); }
      }
      if (cpuPercent > 0) {
        JOBOBJECT_CPU_RATE_CONTROL_INFORMATION cpu = new JOBOBJECT_CPU_RATE_CONTROL_INFORMATION();
        cpu.ControlFlags = 0x1 | 0x4; // ENABLE | HARD_CAP
        cpu.CpuRate = (uint)Math.Max(1, Math.Min(10000, Math.Round(cpuPercent * 100)));  // in 1/100 of a percent
        SetInfo(job, 15, cpu);
      }
      if (memoryBytes > 0) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION ext = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        ext.BasicLimitInformation.LimitFlags = 0x200; // JOB_OBJECT_LIMIT_JOB_MEMORY
        ext.JobMemoryLimit = new UIntPtr((ulong)memoryBytes);
        SetInfo(job, 9, ext);
      }
    } finally { CloseHandle(job); }
    return failed.Append(']').ToString();
  }

  /** Lifts every limit Cap set. Processes stay in the job (Windows cannot take them out), but it no longer constrains them. */
  public static void Uncap(string name) {
    IntPtr job;
    try { job = Job(name, false); } catch (Win32Exception e) { if (e.NativeErrorCode == 2) return; throw; } // 2: job gone, every process in it has exited
    try {
      SetInfo(job, 15, new JOBOBJECT_CPU_RATE_CONTROL_INFORMATION());
      SetInfo(job, 9, new JOBOBJECT_EXTENDED_LIMIT_INFORMATION());
    } finally { CloseHandle(job); }
  }
}
`;

/** A PowerShell prologue that compiles `DtfNative` once per script. */
export const WIN32_PRELUDE = `$ErrorActionPreference = 'Stop'
if (-not ('DtfNative' -as [type])) { Add-Type -TypeDefinition @'
${WIN32_CS}
'@ }
`;
