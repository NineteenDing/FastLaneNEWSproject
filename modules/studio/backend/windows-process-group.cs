// Windows API declarations follow Microsoft Learn; implementation owned by this project.
// Unnamed, non-inheritable job handle; new root is atomically assigned at creation.
// Wire fields/types: windows-process-group-protocol.ts; the receiver validates before admission.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class FastLaneProcessGroup
{
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
        public BasicLimit Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct CpuRate { public uint Flags, Rate; }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
        public uint Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, Width, Height, CharactersX, CharactersY, Fill, Flags;
        public ushort ShowWindow, ReservedSize;
        public IntPtr ReservedPointer, StdInput, StdOutput, StdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo Startup; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr value, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr value, uint size, IntPtr returnedSize);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnedSize);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inheritHandles, uint flags, IntPtr environment, string cwd, ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static void Set<T>(IntPtr job, int kind, T value) {
        IntPtr buffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(T)));
        try { Marshal.StructureToPtr(value, buffer, false); Check(SetInformationJobObject(job, kind, buffer, (uint)Marshal.SizeOf(typeof(T)))); }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    static T Query<T>(IntPtr job, int kind) {
        IntPtr buffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(T)));
        try { Check(QueryInformationJobObject(job, kind, buffer, (uint)Marshal.SizeOf(typeof(T)), IntPtr.Zero)); return (T)Marshal.PtrToStructure(buffer, typeof(T)); }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    static uint[] ProcessIds(IntPtr job) {
        const int maximum = 8192;
        int bytes = 8 + maximum * IntPtr.Size;
        IntPtr buffer = Marshal.AllocHGlobal(bytes);
        try {
            Check(QueryInformationJobObject(job, 3, buffer, (uint)bytes, IntPtr.Zero));
            int assigned = Marshal.ReadInt32(buffer), count = Marshal.ReadInt32(buffer, 4);
            if (count < 1 || count > maximum || assigned != count) throw new Exception("Incomplete Job inventory");
            uint[] pids = new uint[count];
            for (int index = 0; index < count; index++) pids[index] = checked((uint)Marshal.ReadIntPtr(buffer, 8 + index * IntPtr.Size).ToInt64());
            Array.Sort(pids);
            return pids;
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    static string Quote(string value) {
        StringBuilder text = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            text.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); text.Append(c); slashes = 0;
        }
        return text.Append('\\', slashes * 2).Append('"').ToString();
    }
    static void Status(IntPtr job, uint pid) {
        CpuRate cpu = Query<CpuRate>(job, 15);
        ExtendedLimit limits = Query<ExtendedLimit>(job, 9);
        Accounting accounting = Query<Accounting>(job, 1);
        uint[] pids = null;
        try { pids = ProcessIds(job); } catch (Win32Exception) {} catch (Exception) {}
        Console.Out.WriteLine("{\"type\":\"status\",\"rootProcessId\":" + pid + ",\"activeProcesses\":" + (pids == null ? accounting.ActiveProcesses : (uint)pids.Length) +
            ",\"cpuPercent\":" + cpu.Rate / 100 + ",\"memoryLimitBytes\":" + limits.JobMemory.ToUInt64() +
            (pids == null ? "" : ",\"processIds\":[" + String.Join(",", pids) + "]") + "}");
    }
    public static void Run(string executable, string[] args, string cwd, uint cpuRate, ulong memoryBytes) {
        if (cpuRate < 100 || cpuRate > 7500 || cpuRate % 100 != 0 || memoryBytes < 67108864UL || memoryBytes > 6442450944UL)
            throw new ArgumentOutOfRangeException("resource limits");
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        ProcessInfo process = new ProcessInfo();
        IntPtr attributes = IntPtr.Zero, jobList = IntPtr.Zero;
        bool attributesInitialized = false;
        try {
            ExtendedLimit limits = new ExtendedLimit();
            limits.Basic.Flags = 0x2000 | 0x200; // KILL_ON_JOB_CLOSE | JOB_MEMORY; no breakaway.
            limits.JobMemory = new UIntPtr(memoryBytes);
            Set(job, 9, limits);
            Set(job, 15, new CpuRate { Flags = 1 | 4, Rate = cpuRate }); // ENABLE | HARD_CAP
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size)); attributesInitialized = true;
            jobList = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList, job);
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            StartupInfoEx startup = new StartupInfoEx();
            startup.Startup.Size = (uint)Marshal.SizeOf(typeof(StartupInfoEx)); startup.Attributes = attributes;
            StringBuilder command = new StringBuilder(Quote(executable));
            foreach (string arg in args) command.Append(' ').Append(Quote(arg));
            Check(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, false, 0x08080004, IntPtr.Zero, cwd, ref startup, out process));
            Status(job, process.Pid);
            uint exitCode = 1;
            // The owner explicitly admits the suspended task after seeing kernel configuration.
            if (Console.In.ReadLine() == "start") {
                if (ResumeThread(process.Thread) == uint.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
                var inputClosed = new ManualResetEvent(false);
                new Thread(() => { try { Console.In.ReadLine(); } finally { inputClosed.Set(); } }) { IsBackground = true }.Start();
                while (true) {
                    uint wait = WaitForSingleObject(process.Process, 0);
                    if (wait == 0) { Check(GetExitCodeProcess(process.Process, out exitCode)); break; }
                    if (wait != 258) throw new Win32Exception(Marshal.GetLastWin32Error());
                    if (inputClosed.WaitOne(0)) break; // Owner closed input or requested stop.
                    Thread.Sleep(100);
                    Status(job, process.Pid);
                }
            }
            Check(TerminateJobObject(job, 1)); // Includes any descendants outliving the root.
            DateTime deadline = DateTime.UtcNow.AddSeconds(5);
            while (Query<Accounting>(job, 1).ActiveProcesses != 0) {
                if (DateTime.UtcNow >= deadline) throw new Exception("Job exit not confirmed");
                Thread.Sleep(10);
            }
            Console.Out.WriteLine("{\"type\":\"result\",\"exitCode\":" + exitCode + ",\"peakMemoryBytes\":" + Query<ExtendedLimit>(job, 9).PeakJobMemory.ToUInt64() + "}");
        } finally {
            CloseHandle(job); // Last owner handle closes: kernel kills this job, including startup failures.
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
            if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
            if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
        }
    }
}
