import { createHash } from 'node:crypto';
import { execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { trayRuntimeDir } from '../core/tray-runtime';
import { ensureDir, pathExists } from '../utils/fs';
import { HotplugError } from '../utils/errors';

const execFileAsync = promisify(execFile);

const NATIVE_TRAY_SOURCE = String.raw`import AppKit
import Foundation

final class HotplugTrayDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var statusLine: NSMenuItem!
    private var inputBuffer = Data()
    private let initialCount: Int

    init(initialCount: Int) {
        self.initialCount = initialCount
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.image = HotplugTrayDelegate.markImage()
            button.toolTip = "Hotplug proxy supervisor"
        }

        let menu = NSMenu()
        menu.addItem(actionItem("Open Hotplug…", #selector(openHotplug), "o"))
        menu.addItem(.separator())
        statusLine = NSMenuItem(title: statusTitle(initialCount), action: nil, keyEquivalent: "")
        statusLine.isEnabled = false
        menu.addItem(statusLine)
        menu.addItem(actionItem("Restart enabled proxies", #selector(restartProxies), "r"))
        menu.addItem(actionItem("Stop all proxies", #selector(stopProxies), "s"))
        menu.addItem(.separator())
        menu.addItem(actionItem("Quit Hotplug", #selector(quitHotplug), "q"))
        statusItem.menu = menu

        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            DispatchQueue.main.async { self?.consume(data) }
        }
    }

    /// Mirrors assets/tray-template.svg — a thicker cut of the logomark that still
    /// resolves at 22pt, where the full mark's prongs collapse into the bodies.
    static func markImage() -> NSImage {
        let parts: [(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat)] = [
            (2.6, 1.4, 1.2, 3.0, 0.6), (5.2, 1.4, 1.2, 3.0, 0.6),
            (15.6, 1.4, 1.2, 3.0, 0.6), (18.2, 1.4, 1.2, 3.0, 0.6),
            (3.4, 6.6, 2.2, 8.8, 1.1), (16.4, 6.6, 2.2, 8.8, 1.1),
            (2.0, 3.4, 5.0, 5.6, 1.6), (15.0, 3.4, 5.0, 5.6, 1.6),
            (2.0, 13.0, 5.0, 5.6, 1.6), (15.0, 13.0, 5.0, 5.6, 1.6),
            (3.4, 10.1, 15.2, 1.8, 0.9), (8.7, 8.4, 4.6, 5.2, 1.6),
            (2.6, 17.6, 1.2, 3.0, 0.6), (5.2, 17.6, 1.2, 3.0, 0.6),
            (15.6, 17.6, 1.2, 3.0, 0.6), (18.2, 17.6, 1.2, 3.0, 0.6),
        ]
        let image = NSImage(size: NSSize(width: 22, height: 22), flipped: true) { _ in
            NSColor.black.setFill()
            for (x, y, w, h, r) in parts {
                NSBezierPath(
                    roundedRect: NSRect(x: x, y: y, width: w, height: h),
                    xRadius: r,
                    yRadius: r
                ).fill()
            }
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "Hotplug"
        return image
    }

    private func actionItem(_ title: String, _ action: Selector, _ key: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    private func statusTitle(_ count: Int) -> String {
        return count == 1 ? "1 proxy running" : "\(count) proxies running"
    }

    private func emit(_ command: String) {
        print(command)
        fflush(stdout)
    }

    private func consume(_ data: Data) {
        inputBuffer.append(data)
        while let newline = inputBuffer.firstIndex(of: 10) {
            let lineData = inputBuffer.prefix(upTo: newline)
            inputBuffer.removeSubrange(...newline)
            guard let line = String(data: lineData, encoding: .utf8) else { continue }
            let fields = line.split(separator: "\t", maxSplits: 1).map(String.init)
            if fields.first == "status", fields.count == 2, let count = Int(fields[1]) {
                statusLine.title = statusTitle(count)
                statusItem.button?.toolTip = "Hotplug · \(statusTitle(count))"
            }
        }
    }

    @objc private func openHotplug() { emit("open") }
    @objc private func restartProxies() { emit("restart") }
    @objc private func stopProxies() { emit("stop") }
    @objc private func quitHotplug() {
        emit("quit")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { NSApp.terminate(nil) }
    }
}

let initialCount = CommandLine.arguments.count > 1 ? Int(CommandLine.arguments[1]) ?? 0 : 0
let app = NSApplication.shared
let delegate = HotplugTrayDelegate(initialCount: initialCount)
app.delegate = delegate
app.run()
`;

export function assertNativeTrayPlatform(): void {
  if (process.platform !== 'darwin') {
    throw new HotplugError(
      'The native Hotplug menu-bar tray requires macOS.',
      'UNSUPPORTED_PLATFORM',
    );
  }
}

export async function nativeTrayBinary(root: string): Promise<string> {
  const runtime = trayRuntimeDir(root);
  const sourcePath = join(runtime, 'HotplugTray.swift');
  const binaryPath = join(runtime, 'hotplug-tray-native');
  const hashPath = join(runtime, 'native.sha256');
  const hash = createHash('sha256').update(NATIVE_TRAY_SOURCE).digest('hex');
  await ensureDir(runtime);
  const cachedHash = await readFile(hashPath, 'utf8').catch(() => '');
  if (cachedHash.trim() === hash && (await pathExists(binaryPath))) {
    return binaryPath;
  }
  await writeFile(sourcePath, NATIVE_TRAY_SOURCE, { mode: 0o600 });
  try {
    await execFileAsync('/usr/bin/xcrun', [
      'swiftc',
      sourcePath,
      '-o',
      binaryPath,
      '-framework',
      'AppKit',
    ]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new HotplugError(
      `Could not build the native macOS tray helper. Install Xcode Command Line Tools and retry. ${detail}`,
      'TRAY_BUILD_FAILED',
    );
  }
  await writeFile(hashPath, `${hash}\n`, { mode: 0o600 });
  return binaryPath;
}

export function sendStatus(native: ChildProcessWithoutNullStreams, count: number): void {
  if (native.stdin.writable) {
    native.stdin.write(`status\t${count}\n`);
  }
}
