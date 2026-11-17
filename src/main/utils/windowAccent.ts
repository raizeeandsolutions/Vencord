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

const ACCENT_COLOR = 0x5A232323;
const applied = new Set<string>();

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

    [DllImport("user32.dll")]
    private static extern int SetWindowCompositionAttribute(IntPtr hwnd, ref WindowCompositionAttributeData data);

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
[DiscordGlass]::Apply(${hwnd}, ${color})
`;

export function applyWindowAccent(win: BrowserWindow) {
    if (process.platform !== "win32") return;

    const bounds = win.getBounds();
    if (bounds.width < 800 || bounds.height < 600) return;

    try {
        const handle = win.getNativeWindowHandle();
        const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
        const key = hwnd.toString();
        if (applied.has(key)) return;
        applied.add(key);
        const encoded = Buffer.from(script(hwnd, ACCENT_COLOR), "utf16le").toString("base64");

        execFile(
            "powershell.exe",
            ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
            { windowsHide: true, timeout: 10_000 },
            err => {
                if (err) console.error("[Vencord] Failed to apply window accent", err);
                else console.log("[Vencord] Window accent applied");
            }
        );
    } catch (e) {
        console.error("[Vencord] Failed to apply window accent", e);
    }
}

