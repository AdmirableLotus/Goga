# Capture raw PCM 16kHz mono 16-bit from default mic, write to stdout.
# Params: -Seconds N
param([int]$Seconds = 6)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.IO;
using System.Threading;

public class MicCapture {
    [DllImport("winmm.dll")] static extern int waveInGetNumDevs();
    [DllImport("winmm.dll")] static extern int waveInOpen(out IntPtr h, uint dev, ref WAVEFORMATEX fmt, IntPtr cb, IntPtr inst, uint flags);
    [DllImport("winmm.dll")] static extern int waveInPrepareHeader(IntPtr h, ref WAVEHDR hdr, uint size);
    [DllImport("winmm.dll")] static extern int waveInUnprepareHeader(IntPtr h, ref WAVEHDR hdr, uint size);
    [DllImport("winmm.dll")] static extern int waveInAddBuffer(IntPtr h, ref WAVEHDR hdr, uint size);
    [DllImport("winmm.dll")] static extern int waveInStart(IntPtr h);
    [DllImport("winmm.dll")] static extern int waveInStop(IntPtr h);
    [DllImport("winmm.dll")] static extern int waveInReset(IntPtr h);
    [DllImport("winmm.dll")] static extern int waveInClose(IntPtr h);

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEFORMATEX { public ushort wFormatTag; public ushort nChannels; public uint nSamplesPerSec; public uint nAvgBytesPerSec; public ushort nBlockAlign; public ushort wBitsPerSample; public ushort cbSize; }

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEHDR { public IntPtr lpData; public uint dwBufferLength; public uint dwBytesRecorded; public IntPtr dwUser; public uint dwFlags; public uint dwLoops; public IntPtr lpNext; public IntPtr reserved; }

    public static void Capture(int seconds) {
        if (waveInGetNumDevs() == 0) { Console.Error.WriteLine("NO_MIC"); return; }
        WAVEFORMATEX fmt = new WAVEFORMATEX();
        fmt.wFormatTag = 1; fmt.nChannels = 1; fmt.nSamplesPerSec = 16000;
        fmt.wBitsPerSample = 16; fmt.nBlockAlign = 2; fmt.nAvgBytesPerSec = 32000; fmt.cbSize = 0;
        IntPtr h;
        if (waveInOpen(out h, 0xFFFFFFFF, ref fmt, IntPtr.Zero, IntPtr.Zero, 0) != 0) { Console.Error.WriteLine("OPEN_FAIL"); return; }

        int bufCount = 8, bufSize = 1600; // 50ms each
        WAVEHDR[] hdrs = new WAVEHDR[bufCount];
        IntPtr[] bufs = new IntPtr[bufCount];
        for (int i = 0; i < bufCount; i++) {
            bufs[i] = Marshal.AllocHGlobal(bufSize);
            hdrs[i] = new WAVEHDR(); hdrs[i].lpData = bufs[i]; hdrs[i].dwBufferLength = (uint)bufSize;
            waveInPrepareHeader(h, ref hdrs[i], (uint)Marshal.SizeOf(hdrs[i]));
            waveInAddBuffer(h, ref hdrs[i], (uint)Marshal.SizeOf(hdrs[i]));
        }
        var stdout = Console.OpenStandardOutput();
        Console.Error.WriteLine("READY");
        waveInStart(h);
        long end = DateTime.Now.Ticks + (long)seconds * 10000000;
        while (DateTime.Now.Ticks < end) {
            for (int i = 0; i < bufCount; i++) {
                if ((hdrs[i].dwFlags & 1) != 0) {
                    byte[] data = new byte[hdrs[i].dwBytesRecorded];
                    Marshal.Copy(hdrs[i].lpData, data, 0, (int)hdrs[i].dwBytesRecorded);
                    stdout.Write(data, 0, data.Length); stdout.Flush();
                    waveInUnprepareHeader(h, ref hdrs[i], (uint)Marshal.SizeOf(hdrs[i]));
                    waveInPrepareHeader(h, ref hdrs[i], (uint)Marshal.SizeOf(hdrs[i]));
                    waveInAddBuffer(h, ref hdrs[i], (uint)Marshal.SizeOf(hdrs[i]));
                }
            }
            Thread.Sleep(5);
        }
        waveInStop(h); waveInReset(h);
        for (int i = 0; i < bufCount; i++) { waveInUnprepareHeader(h, ref hdrs[i], (uint)Marshal.SizeOf(hdrs[i])); Marshal.FreeHGlobal(bufs[i]); }
        waveInClose(h);
        Console.Error.WriteLine("DONE");
    }
}
"@
[MicCapture]::Capture($Seconds)
