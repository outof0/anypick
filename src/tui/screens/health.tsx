/**
 * Doctor / health screen.
 */

import { Box, Text, useInput } from 'ink';
import { brandColor, G, ScreenShell, Spacer, theme, type KeyHint } from '../components/chrome';
import type { HealthModel } from '../model';

export interface HealthScreenProps {
  model: HealthModel;
  selectedIndex: number;
  busy?: boolean;
  message?: string;
  onMove: (delta: number) => void;
  onApplyFixes: () => void;
  onBack: () => void;
}

export function HealthScreen(props: HealthScreenProps) {
  const { model, selectedIndex, busy, message, onMove, onApplyFixes, onBack } = props;
  const checks = model.prioritized;
  const fixCount = model.plan?.actions.length ?? 0;
  const manualCount = model.plan?.manual.length ?? 0;

  useInput((input, key) => {
    if (busy) {
      return;
    }
    if (key.escape) {
      onBack();
      return;
    }
    if (key.upArrow || input === 'k') {
      onMove(-1);
      return;
    }
    if (key.downArrow || input === 'j') {
      onMove(1);
      return;
    }
    if (key.return && fixCount > 0) {
      onApplyFixes();
    }
  });

  const selected = checks[selectedIndex];

  const summary = `${
    model.report.ok ? 'All checks passed' : `${checks.filter((c) => !c.ok).length} finding(s)`
  }${fixCount > 0 ? ` · ${fixCount} safe fix(es)` : ''}${manualCount > 0 ? ` · ${manualCount} manual` : ''}`;

  const outcome = busy
    ? undefined
    : fixCount > 0
      ? `Preview & apply ${fixCount} safe fix(es)`
      : summary;
  const support = busy ? undefined : 'Doctor never switches accounts or installs packages.';

  const hints: KeyHint[] = busy
    ? []
    : fixCount > 0
      ? [
          { key: 'enter', label: 'apply safe fixes' },
          { key: 'esc', label: 'back' },
        ]
      : [{ key: 'esc', label: 'back' }];

  return (
    <ScreenShell
      path="health"
      busy={busy}
      busyLabel="Working"
      outcome={outcome}
      support={support}
      hints={hints}
    >
      <Box flexDirection="column">
        <Text> {summary}</Text>
        <Spacer />
        {checks.length === 0 ? (
          <Text dimColor> No checks returned.</Text>
        ) : (
          checks.slice(0, 30).map((c, i) => (
            <Text
              key={c.id}
              color={i === selectedIndex ? brandColor('accent') : c.ok ? undefined : theme.warn}
              bold={i === selectedIndex}
            >
              {' '}
              {i === selectedIndex ? G.focus : ' '} {c.ok ? G.done : G.warn} {c.message}
            </Text>
          ))
        )}
        <Spacer />
        {selected && !selected.ok ? (
          <Box flexDirection="column">
            <Text dimColor> {selected.detail ?? selected.id}</Text>
            {(selected.suggestions ?? []).map((s, i) => (
              <Text key={i} dimColor>
                {' '}
                → {s}
              </Text>
            ))}
          </Box>
        ) : null}
        {model.plan && model.plan.manual.length > 0 ? (
          <>
            <Spacer />
            <Text bold color={theme.warn}>
              {' '}
              Manual only (doctor will not auto-fix)
            </Text>
            {model.plan.manual.slice(0, 5).map((m) => (
              <Text key={m.id} dimColor>
                {' '}
                · {m.message}
              </Text>
            ))}
          </>
        ) : null}
        {message ? (
          <>
            <Spacer />
            <Text> {message}</Text>
          </>
        ) : null}
      </Box>
    </ScreenShell>
  );
}
