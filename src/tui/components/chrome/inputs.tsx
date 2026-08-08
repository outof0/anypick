import React from 'react';
import { Box, Text, useInput } from 'ink';
import { G, StatusToken, type StatusKind, type WidthBreakpoint } from './status';
import { applyLineEdit, lineAtEnd, lineEditFor, renderLine } from '../../model/line-editor';

interface TextInputProps {
  label: string;
  initial?: string;
  hint?: string;
  password?: boolean;
  preview?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  onChange?: (value: string) => void;
}

export function TextInputField(props: TextInputProps) {
  const [line, setLine] = React.useState(() => lineAtEnd(props.initial ?? ''));

  useInput((input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.return) {
      props.onSubmit(line.value);
      return;
    }
    const edit = lineEditFor(input, key);
    if (!edit) {
      return;
    }
    const next = applyLineEdit(line, edit);
    setLine(next);
    if (next.value !== line.value) {
      props.onChange?.(next.value);
    }
  });

  const { before, at, after } = renderLine(line, props.password);

  return (
    <Box flexDirection="column">
      <Text> {props.label}</Text>
      <Text>
        {' '}
        <Text>
          {'> '}
          {before}
          <Text inverse>{at}</Text>
          {after}
        </Text>
      </Text>
      {props.preview ? <Text dimColor> {props.preview}</Text> : null}
      {props.hint ? <Text dimColor> {props.hint}</Text> : null}
    </Box>
  );
}

// ── Picker ───────────────────────────────────────────────────────

export function Picker(props: {
  items: Array<{
    id: string;
    label: string;
    detail?: string;
    status?: StatusKind;
    statusLabel?: string;
  }>;
  selectedIndex: number;
  multi?: boolean;
  checked?: Set<string>;
  width?: WidthBreakpoint;
}) {
  return (
    <Box flexDirection="column">
      {props.items.map((item, i) => {
        const sel = i === props.selectedIndex;
        const box =
          props.multi && props.checked ? (props.checked.has(item.id) ? '[x]' : '[ ]') : null;
        return (
          <Box key={item.id}>
            <Text bold={sel}>
              {' '}
              {sel ? G.focus : ' '} {box ? `${box} ` : ''}
              {item.label}
            </Text>
            {item.detail ? <Text dimColor> {item.detail}</Text> : null}
            {item.status ? (
              <>
                <Text> </Text>
                <StatusToken kind={item.status} label={item.statusLabel} />
              </>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

export function useListSelection(length: number, initial = 0) {
  const [index, setIndex] = React.useState(initial);
  React.useEffect(() => {
    if (length <= 0) {
      setIndex(0);
      return;
    }
    setIndex((i) => ((i % length) + length) % length);
  }, [length]);
  return {
    index: length <= 0 ? 0 : ((index % length) + length) % length,
    setIndex,
    move: (delta: number) => {
      if (length <= 0) {
        return;
      }
      setIndex((i) => (((i + delta) % length) + length) % length);
    },
  };
}

// ── Backward-compatible aliases ──────────────────────────────────

/** @deprecated use ScreenShell */
