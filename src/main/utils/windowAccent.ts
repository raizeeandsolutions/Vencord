/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { execFile } from "child_process";
import { BrowserWindow } from "electron";
import { appendFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ACCENT_COLOR = 0x5A232323;
const applied = new Set<string>();
const logFile = join(tmpdir(), "vencord-accent.log");

function log(message: string) {
    try {
        appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
    } catch { }
}

const script = (hwnd: bigint, color: number) => `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class DiscordGlass {
    [StructLayout(LayoutKind.Sequential)]
    public struct AccentPolicy {
        public int AccentState;
        public int AccentFlags;
        public int GradientColor;
        public int AnimationId;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct WindowCompositionAttributeData {
        public int Attribute;
        public IntPtr Data;
        public int SizeOfData;
    }

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    private static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll")]
    private static extern int SetWindowCompositionAttribute(IntPtr hwnd, ref WindowCompositionAttributeData data);

    public static int EnableResize(long hwnd) {
        var handle = new IntPtr(hwnd);
        var style = GetWindowLongPtr(handle, -16).ToInt64();
        if ((style & 0x00040000) != 0) return 0;
        SetWindowLongPtr(handle, -16, new IntPtr(style | 0x00040000));
        SetWindowPos(handle, IntPtr.Zero, 0, 0, 0, 0, 0x37);
        return 1;
    }

    public static int Apply(long hwnd, int color) {
        var policy = new AccentPolicy { AccentState = 4, GradientColor = color };
        var size = Marshal.SizeOf(policy);
        var ptr = Marshal.AllocHGlobal(size);
        Marshal.StructureToPtr(policy, ptr, false);
        var data = new WindowCompositionAttributeData { Attribute = 19, Data = ptr, SizeOfData = size };
        var result = SetWindowCompositionAttribute(new IntPtr(hwnd), ref data);
        Marshal.FreeHGlobal(ptr);
        return result;
    }
}
'@
[DiscordGlass]::EnableResize(${hwnd}) | Out-Null

$wh = Get-Service Windhawk -ErrorAction SilentlyContinue
$key = 'HKLM:\\SOFTWARE\\Windhawk\\Engine\\Mods\\translucent-windows'
$active = $false
$hasEffect = $false
if ($wh -and $wh.Status -eq 'Running' -and (Test-Path $key)) {
    $mod = Get-ItemProperty $key
    if ($null -eq $mod.Disabled -or $mod.Disabled -eq 0) {
        $include = [string]$mod.Include
        if ([string]::IsNullOrEmpty($include) -or $include -eq '*' -or $include -match '(?i)discord') {
            $active = $true
            $background = [string]$mod.BackgroundEffects
            $accent = [string]$mod.AccentBlurBehind
            if (-not [string]::IsNullOrWhiteSpace($background) -or -not [string]::IsNullOrWhiteSpace($accent)) {
                $hasEffect = $true
            }

            $exclude = [string]$mod.Exclude
            if ($exclude -match '(?i)discord') {
                $active = $false
            }

            if ($active) {
                $settingsKey = Join-Path $key 'Settings'
                if (Test-Path $settingsKey) {
                    $rules = Get-ItemProperty $settingsKey
                    for ($i = 0; $i -lt 64; $i++) {
                        $target = [string]$rules."RuledPrograms[$i].target"
                        if ([string]::IsNullOrWhiteSpace($target) -or $target -notmatch '(?i)discord\\.exe$') { continue }
                        $ruleType = [string]$rules."RuledPrograms[$i].BackgroundEffects.type"
                        $ruleTheme = [int]$rules."RuledPrograms[$i].RenderingMod.ThemeBackground"
                        $ruleAccent = [int]$rules."RuledPrograms[$i].RenderingMod.AccentColorControls"
                        if (([string]::IsNullOrWhiteSpace($ruleType) -or $ruleType -eq 'none') -and $ruleTheme -eq 0 -and $ruleAccent -eq 0) {
                            $hasEffect = $false
                        }
                        break
                    }
                }
            }
        }
    }
}
if ($active -and $hasEffect) {
    Write-Output 'skip:windhawk'
    exit 0
}
[DiscordGlass]::Apply(${hwnd}, ${color})
`;

export function applyWindowAccent(win: BrowserWindow, attempt = 0) {
    if (process.platform !== "win32" || win.isDestroyed()) return;

    const bounds = win.getBounds();
    if (bounds.width < 800 || bounds.height < 600) {
        if (attempt < 20) setTimeout(() => applyWindowAccent(win, attempt + 1), 500);
        return;
    }

    try {
        const handle = win.getNativeWindowHandle();
        const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
        const key = hwnd.toString();
        if (applied.has(key)) return;
        applied.add(key);

        log(`apply hwnd=${key} size=${bounds.width}x${bounds.height} attempt=${attempt}`);
        const encoded = Buffer.from(script(hwnd, ACCENT_COLOR), "utf16le").toString("base64");

        execFile(
            "powershell.exe",
            ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
            { windowsHide: true, timeout: 15_000 },
            (err, stdout) => {
                log(`result err=${err ? err.message : "none"} stdout=${stdout.trim()}`);
            }
        );
    } catch (e) {
        log(`error ${e}`);
    }
}
