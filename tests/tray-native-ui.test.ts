import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

function swiftDeclaration(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  if (start < 0) {
    throw new Error(`Missing Swift declaration: ${declaration}`);
  }

  const bodyStart = source.indexOf('{', start);
  if (bodyStart < 0) {
    throw new Error(`Missing body for Swift declaration: ${declaration}`);
  }

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') {
      depth += 1;
    }
    if (source[index] === '}') {
      depth -= 1;
    }
    if (depth === 0) {
      return source.slice(start, index + 1);
    }
  }

  throw new Error(`Unclosed Swift declaration: ${declaration}`);
}

async function loadNativeSwiftBundle(): Promise<string> {
  const nativeDir = fileURLToPath(new URL('../src/tray/native/', import.meta.url));
  let names: string[] = [];
  try {
    const manifest = await readFile(join(nativeDir, 'sources.txt'), 'utf8');
    names = manifest
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && line.endsWith('.swift'));
  } catch {
    names = (await readdir(nativeDir)).filter((name) => name.endsWith('.swift')).sort();
  }
  const chunks = await Promise.all(names.map((name) => readFile(join(nativeDir, name), 'utf8')));
  return chunks.join('\n\n');
}

describe('native macOS tray surface', () => {
  let source: string;

  beforeAll(async () => {
    source = await loadNativeSwiftBundle();
  });

  it('keeps MenuBarExtra as a compact quick-control surface', () => {
    const appScene = swiftDeclaration(source, 'struct AnyPickTrayApp');
    const quickPanelName = appScene.match(/MenuBarExtra\s*\{\s*(\w+)\s*\(/)?.[1];

    expect(appScene).toContain('MenuBarExtra');
    expect(appScene).not.toMatch(/NativeTrayPanel\s*\(/);
    expect(quickPanelName, 'MenuBarExtra must render a dedicated quick panel').toBeDefined();

    const quickPanel = swiftDeclaration(source, `struct ${quickPanelName}`);

    const width = quickPanel.match(/\.frame\s*\(\s*width:\s*(\d+)/)?.[1];
    expect(width, 'NativeQuickPanel must declare a predictable compact width').toBeDefined();
    expect(Number(width)).toBeLessThanOrEqual(400);
    expect(quickPanel).not.toContain('NavigationSplitView');
  });

  it('opens full management in a reusable native window with sidebar navigation', () => {
    const appDelegate = swiftDeclaration(source, 'final class AnyPickAppDelegate');
    const hostingRoot = appDelegate.match(/NSHostingController\s*\(\s*rootView:\s*(\w+)/)?.[1];
    const boundRoot = hostingRoot
      ? appDelegate.match(new RegExp(`let\\s+${hostingRoot}\\s*=\\s*(\\w+)\\s*\\(`))?.[1]
      : undefined;
    const mainWindowName = boundRoot ?? hostingRoot;

    expect(appDelegate).toContain('NSWindowController');
    expect(appDelegate).toMatch(/NSWindow\s*\(/);
    expect(appDelegate).toContain('makeKeyAndOrderFront');
    expect(mainWindowName, 'NSWindow must host the full SwiftUI management surface').toBeDefined();

    const mainWindow = swiftDeclaration(source, `struct ${mainWindowName}`);
    expect(mainWindow).toContain('NavigationSplitView');
  });

  it('drives hover/pointer via NSTrackingArea probe, not SwiftUI onHover alone', () => {
    const hoverProbe = swiftDeclaration(source, 'final class TrayHoverNSView');
    expect(hoverProbe).toContain('NSTrackingArea');
    // Pointing-hand is owned by the probe for interactive rows; keep it local.
    expect(hoverProbe).toMatch(/NSCursor\s*\.\s*pointingHand/);
    expect(source).toContain('struct TrayHoverProbe');
  });

  it('keeps common route switches in the quick panel without dumping the model catalog', () => {
    const routeRow = swiftDeclaration(source, 'struct NativeQuickRouteRow');

    // Same popover chrome as Codex model switch — not a system Menu dump.
    expect(routeRow).toContain('NativeRoutePicker');
    expect(routeRow).not.toContain('TraySwitchMenu');
    expect(routeRow).toContain('store.invoke(action)');
    expect(routeRow).toContain('.confirmationDialog(');
    expect(routeRow).toContain('openRouteBrowser');
    expect(routeRow).toContain('openModels');
    // Capped chip list still uses a horizontal scroller (nested MenuBarExtra).
    expect(routeRow).toContain('TrayChipStrip');
    expect(source).toContain('struct TrayChipStrip');
    expect(source).toContain('HorizontalChipScrollView');
    // Chips show provider brand badges, not account initials.
    const chip = swiftDeclaration(source, 'struct TrayRouteChip');
    expect(chip).toContain('NativeProviderBadge');
    expect(chip).not.toMatch(/trayChipMark/);
    expect(routeRow).toContain('trayRouteProviderId(action)');
    expect(source).toMatch(/func trayRouteProviderId/);
    // Source-first chips: Hub is one chip, not every hub model.
    expect(routeRow).toMatch(/routeKind == "hub"/);
    expect(routeRow).not.toMatch(/ForEach\([^\n]*hubActions/);
    expect(routeRow).not.toMatch(/gateway-model|hub-model/);
  });

  it('ships monochrome brand icons for built-in providers including Kiro and Grok', async () => {
    const iconsDir = fileURLToPath(new URL('../src/tray/icons/', import.meta.url));
    const names = await readdir(iconsDir);
    for (const name of [
      'claude.svg',
      'openai.svg',
      'googlegemini.svg',
      'opencode.svg',
      'openrouter.svg',
      'kiro.svg',
      'grok.svg',
    ]) {
      expect(names, `missing tray brand icon ${name}`).toContain(name);
      const svg = await readFile(join(iconsDir, name), 'utf8');
      expect(svg).toMatch(/viewBox="0 0 24 24"/);
      expect(svg).toMatch(/fill="#fff"/);
    }
    const shared = swiftDeclaration(source, 'struct NativeProviderBadge');
    expect(shared).toMatch(/"kiro":\s*"kiro\.svg"/);
    expect(shared).toMatch(/"grok":\s*"grok\.svg"/);
  });

  it('keeps Models nested under Accounts — not a primary sidebar destination', () => {
    const mainWindow = swiftDeclaration(source, 'struct NativeMainWindow');
    expect(mainWindow).toMatch(/Label\("Accounts"/);
    expect(mainWindow).toMatch(/Label\("Proxies"/);
    expect(mainWindow).toMatch(/Label\("Logs"/);
    expect(mainWindow).toMatch(/Label\("Settings"/);
    const sidebarList = mainWindow.match(
      /List\(selection:[\s\S]*?\)\s*\{([\s\S]*?)\}\s*\.listStyle\(\.sidebar\)/,
    )?.[1];
    expect(sidebarList, 'NativeMainWindow must declare a sidebar List').toBeDefined();
    expect(sidebarList).not.toMatch(/\.tag\(\s*NativeTrayTab\.clientModels\s*\)/);
    expect(sidebarList).not.toMatch(/Label\("Models"/);
  });

  it('exposes Proxy Hub setup as a detail destination under Proxies', () => {
    expect(source).toMatch(/case hubSetup/);
    expect(source).toContain('struct NativeHubSetupPanel');
    const mainWindow = swiftDeclaration(source, 'struct NativeMainWindow');
    expect(mainWindow).toMatch(/\.hubSetup/);
    expect(mainWindow).toContain('NativeHubSetupPanel');
  });

  it('offers Proxy Hub routing on app rows when Hub is available', () => {
    const appRow = swiftDeclaration(source, 'struct NativeAppRouteRow');
    expect(appRow).toMatch(/hubActions/);
    expect(appRow).toMatch(/routeKind == "hub"/);
    expect(appRow).toMatch(/Routed via Proxy Hub/);
    expect(appRow).toContain('NativeRoutePicker');
  });

  it('auto-polls live logs while the Logs panel is open', () => {
    const store = swiftDeclaration(source, 'final class TrayStore');
    expect(store).toContain('startLogPolling');
    expect(store).toContain('stopLogPolling');
    const monitor = swiftDeclaration(source, 'struct NativeMonitorPanel');
    expect(monitor).toContain('startLogPolling');
    expect(monitor).toContain('stopLogPolling');
    expect(monitor).toContain('NativeLogViewer');
  });

  it('groups Switch into Accounts, Proxies, Gateways and opens the active path', () => {
    const popover = swiftDeclaration(source, 'struct NativeRoutePickerPopover');
    const face = swiftDeclaration(source, 'struct NativeRoutePicker');
    // Match NativeRoleModelPicker / NativeModelChoicePopover chrome.
    expect(face).toMatch(/nativeControlFill/);
    expect(face).toMatch(/chevron\.up\.chevron\.down/);
    // Hide Switch when only one (or zero) selectable sources.
    expect(source).toMatch(/func routeHasAlternates/);
    expect(face).toMatch(/routeHasAlternates|canSwitch/);
    // Two or more enabled sources show Switch (Work/Personal is the common case).
    const routeHasAlternates = swiftDeclaration(source, 'func routeHasAlternates');
    expect(routeHasAlternates).toMatch(/\.count\s*>\s*1/);
    expect(routeHasAlternates).not.toMatch(/\.count\s*>\s*2/);
    // Three sections (enum lives above the popover struct).
    expect(source).toMatch(/case accounts = "Accounts"/);
    expect(source).toMatch(/case proxies = "Proxies"/);
    expect(source).toMatch(/case gateways = "Gateways"/);
    expect(popover).toMatch(/Proxy Hub/);
    expect(popover).toMatch(/openActivePathIfNeeded/);
    expect(popover).toMatch(/Search sources/);
    expect(popover).toMatch(/frame\(width:\s*TraySpacing\.quickPanelWidth\)|frame\(width: 380\)/);
    expect(popover).toMatch(/direct-account/);
    // No separate Current block; live route lives inside its section with checkmark.
    expect(popover).not.toMatch(/pickerLabel\("Current"\)/);
    expect(popover).not.toMatch(/Sources by provider/);
    expect(popover).not.toMatch(/gateway-model|hub-model/);
  });

  it('uses a resizable main window with frame autosave', () => {
    const appDelegate = swiftDeclaration(source, 'final class AnyPickAppDelegate');
    expect(appDelegate).toMatch(/\.resizable/);
    expect(appDelegate).toMatch(/setFrameAutosaveName/);
    expect(appDelegate).not.toMatch(/contentMaxSize\s*=\s*size/);
  });

  it('shows menu-bar attention and HIG app commands', () => {
    const appScene = swiftDeclaration(source, 'struct AnyPickTrayApp');
    expect(appScene).toMatch(/StatusLabel\s*\(\s*store:/);
    expect(appScene).toMatch(/\.commands\s*\{/);
    expect(appScene).toMatch(/keyboardShortcut\s*\(\s*","/);
    expect(appScene).toMatch(/keyboardShortcut\s*\(\s*"r"/);
    expect(appScene).toMatch(/keyboardShortcut\s*\(\s*"w"/);
    expect(appScene).toMatch(/keyboardShortcut\s*\(\s*"n"/);
    expect(appScene).toMatch(/closeMainWindow/);

    const statusLabel = swiftDeclaration(source, 'struct StatusLabel');
    expect(statusLabel).toMatch(/attentionCount/);
    expect(statusLabel).toMatch(/Circle\s*\(/);

    const store = swiftDeclaration(source, 'final class TrayStore');
    expect(store).toMatch(/var attentionCount/);
    expect(store).toMatch(/announcementRequested/);
  });

  it('aligns quick-panel vocabulary with the main window', () => {
    // Tab label lives on the section enum above NativeQuickPanel.
    expect(source).toMatch(/case logs = "Logs"/);
    expect(source).not.toMatch(/case logs = "Activity"/);
    const quickPanel = swiftDeclaration(source, 'struct NativeQuickPanel');
    expect(quickPanel).toMatch(/Accounts…|Accounts\u2026|"Accounts…"/);
    expect(quickPanel).not.toMatch(/actionTitle: "Manage/);
    expect(quickPanel).toMatch(/Recent activity/);
    // Status lives in the header only — footer is primary action + attention.
    expect(quickPanel).toMatch(/private var footer/);
    const footerStart = quickPanel.indexOf('private var footer');
    const footerChunk = quickPanel.slice(footerStart, footerStart + 1200);
    expect(footerChunk).not.toMatch(/statusText/);
    expect(footerChunk).toMatch(/Add Account/);
    expect(footerChunk).toMatch(/attentionCount/);
  });

  it('ships first-run onboarding, snapshot loading, and Reduce Motion tokens', () => {
    expect(source).toContain('struct NativeOnboardingChecklist');
    expect(source).toContain('struct NativeSnapshotLoading');
    expect(source).toContain('enum TrayMotion');
    expect(source).toMatch(/accessibilityDisplayShouldReduceMotion/);

    const store = swiftDeclaration(source, 'final class TrayStore');
    expect(store).toMatch(/var snapshotReady/);
    expect(store).toMatch(/var isFirstRun/);
    expect(store).toMatch(/var needsInstalledApps/);
    const firstRun = store.slice(
      store.indexOf('var isFirstRun'),
      store.indexOf('var needsInstalledApps'),
    );
    expect(firstRun).toMatch(/accounts\.isEmpty/);
    expect(firstRun).toMatch(/gateways\.isEmpty/);
    expect(firstRun).not.toMatch(/appRouteClients\.isEmpty|nativeAccountClients\.isEmpty/);
    expect(store).toMatch(/var hasInstalledClient/);
    expect(store).toMatch(/clientId != nil && \$0\.installed/);

    const accounts = swiftDeclaration(source, 'struct NativeAccountsPanel');
    expect(accounts).toContain('NativeOnboardingChecklist');
    expect(accounts).toContain('NativeSnapshotLoading');

    const quickPanel = swiftDeclaration(source, 'struct NativeQuickPanel');
    expect(quickPanel).toContain('NativeOnboardingChecklist');
    expect(quickPanel).toContain('NativeSnapshotLoading');
  });

  it('persists local chrome prefs and supports dismissing setup tips', () => {
    expect(source).toContain('enum TrayPreferences');
    expect(source).toMatch(/onboardingDismissed/);
    expect(source).toMatch(/quickSection/);
    expect(source).toMatch(/mainTab/);
    expect(source).toMatch(/func trayShouldShowOnboarding/);
    expect(source).toMatch(/Show Setup Tips Again/);

    const nav = swiftDeclaration(source, 'final class NativeNavigationModel');
    expect(nav).toMatch(/TrayPreferences\.mainTabRaw/);
    expect(nav).toMatch(/isPrimary/);

    const quickPanel = swiftDeclaration(source, 'struct NativeQuickPanel');
    expect(quickPanel).toMatch(/quickSectionRaw|QuickPanelSection\.restored/);
  });

  it('avoids nested MenuBarExtra popovers and ships Dynamic Type polish', () => {
    const routeRow = swiftDeclaration(source, 'struct NativeQuickRouteRow');
    // More… must drive the shared Switch presentation, not a second popover.
    expect(routeRow).toMatch(/isPresented:\s*\$showingRoutePicker/);
    expect(routeRow).toMatch(/Button\("More…"/);
    const moreChunk = routeRow.slice(routeRow.indexOf('Button("More…")'));
    expect(moreChunk.slice(0, 500)).not.toMatch(/\.popover\s*\(/);

    const picker = swiftDeclaration(source, 'struct NativeRoutePicker');
    expect(picker).toMatch(/var isPresented:\s*Binding<Bool>\?/);
    expect(picker).toMatch(/busyRequestId/);

    expect(source).toMatch(/@ScaledMetric/);
    expect(source).toMatch(/trayQuickPanelMaxHeight/);
    expect(source).toMatch(/trayHapticSuccess/);
    expect(source).toMatch(/TimelineView/);
    expect(source).toMatch(/snapshotFreshnessText/);
  });

  it('is split into modular Swift sources under src/tray/native', async () => {
    const nativeDir = fileURLToPath(new URL('../src/tray/native/', import.meta.url));
    const names = (await readdir(nativeDir)).filter((name) => name.endsWith('.swift'));
    expect(names.length).toBeGreaterThanOrEqual(8);
    expect(names).toContain('AppEntry.swift');
    expect(names).toContain('QuickPanel.swift');
    expect(names).toContain('MainWindow.swift');
  });
});
