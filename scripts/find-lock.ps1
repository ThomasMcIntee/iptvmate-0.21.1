param([string]$Path)
$src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class Rm {
  [StructLayout(LayoutKind.Sequential)]
  public struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  const int CCH_RM_MAX_APP_NAME = 255; const int CCH_RM_MAX_SVC_NAME = 63;
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_APP_NAME + 1)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_SVC_NAME + 1)] public string strServiceShortName;
    public int ApplicationType; public uint AppStatus; public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, [In] RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Auto)]
  static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint pSessionHandle);
  [DllImport("rstrtmgr.dll")]
  static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);
  public static List<int> WhoLocks(string path) {
    uint handle; string key = Guid.NewGuid().ToString(); var pids = new List<int>();
    int res = RmStartSession(out handle, 0, key); if (res != 0) throw new Exception("RmStartSession " + res);
    try {
      string[] files = { path };
      res = RmRegisterResources(handle, 1, files, 0, null, 0, null);
      if (res != 0) throw new Exception("RmRegisterResources " + res);
      uint pnProcInfo = 0; uint pnProcInfoNeeded = 0; uint reasons = 0;
      res = RmGetList(handle, out pnProcInfoNeeded, ref pnProcInfo, null, ref reasons);
      if (res == 234) {
        var arr = new RM_PROCESS_INFO[pnProcInfoNeeded];
        pnProcInfo = pnProcInfoNeeded;
        res = RmGetList(handle, out pnProcInfoNeeded, ref pnProcInfo, arr, ref reasons);
        if (res == 0) for (int i = 0; i < pnProcInfo; i++) pids.Add(arr[i].Process.dwProcessId);
      }
    } finally { RmEndSession(handle); }
    return pids;
  }
}
'@
Add-Type -TypeDefinition $src -Language CSharp
$pids = [Rm]::WhoLocks($Path)
Write-Host "PIDs holding $Path :"
foreach ($p in $pids) {
  try { Get-Process -Id $p | Select-Object Id, Name, Path | Format-Table -AutoSize } catch { Write-Host "PID $p (gone)" }
}
