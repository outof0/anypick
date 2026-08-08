/**
 * One screen for a credential the user types: the secret, every qualifier the
 * provider declares, and the name to save it under.
 *
 * A qualifier row keeps the provider's known values under ← → because a
 * plausible typo in something like an API region yields an account that starts
 * and then fails every request. It stays editable all the same — vendor lists
 * go stale faster than this one is updated.
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import { brandColor, G, ScreenShell } from '../components/chrome';
import {
  applyLineEdit,
  displayValue,
  graphemeLength,
  lineEditFor,
  renderLine,
} from '../model/line-editor';
import type { CredentialInputField } from '../../types';

export interface CredentialFormValues {
  secret: string;
  options: Record<string, string>;
  name: string;
}

export interface CredentialFormScreenProps {
  providerName: string;
  /** One of the provider's `credentialInputs`, e.g. `api-key`. */
  credentialKind: string;
  fields: readonly CredentialInputField[];
  initial?: Partial<CredentialFormValues>;
  error?: string;
  onSubmit: (values: CredentialFormValues) => void;
  onCancel: () => void;
}

interface Row {
  id: string;
  label: string;
  secret?: boolean;
  choices?: readonly string[];
}

const SECRET_ROW = 'secret';
const NAME_ROW = 'name';

/** `api-key` reads as an initialism, not a hyphenated word. */
export function credentialKindLabel(kind: string): string {
  return kind === 'api-key' ? 'API key' : kind.replace(/-/g, ' ');
}

function optionRowId(field: string): string {
  return `option:${field}`;
}

function cycle(choices: readonly string[], current: string, delta: number): string {
  const at = choices.indexOf(current);
  if (at < 0) {
    return (delta > 0 ? choices[0] : choices[choices.length - 1]) ?? current;
  }
  return choices[(at + delta + choices.length) % choices.length] ?? current;
}

export function CredentialFormScreen(props: CredentialFormScreenProps) {
  const { fields, credentialKind, providerName } = props;
  const secretLabel = credentialKindLabel(credentialKind);

  const rows = React.useMemo<Row[]>(
    () => [
      { id: SECRET_ROW, label: secretLabel, secret: true },
      ...fields.map((f) => ({ id: optionRowId(f.name), label: f.label, choices: f.choices })),
      { id: NAME_ROW, label: 'Name' },
    ],
    [fields, secretLabel],
  );

  const [values, setValues] = React.useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {
      [SECRET_ROW]: props.initial?.secret ?? '',
      [NAME_ROW]: props.initial?.name ?? credentialKind,
    };
    for (const f of fields) {
      seed[optionRowId(f.name)] =
        props.initial?.options?.[f.name] ?? f.default ?? f.choices[0] ?? '';
    }
    return seed;
  });
  const [cursors, setCursors] = React.useState<Record<string, number>>({});
  const [active, setActive] = React.useState(0);
  const [localError, setLocalError] = React.useState<string>();

  const valueOf = (id: string) => values[id] ?? '';
  const cursorOf = (id: string) => cursors[id] ?? graphemeLength(valueOf(id));

  const write = (id: string, value: string, cursor: number) => {
    setValues((v) => ({ ...v, [id]: value }));
    setCursors((c) => ({ ...c, [id]: cursor }));
    setLocalError(undefined);
  };

  const move = (delta: number) => {
    setActive((i) => (((i + delta) % rows.length) + rows.length) % rows.length);
    setLocalError(undefined);
  };

  const submit = () => {
    const secret = valueOf(SECRET_ROW).trim();
    if (!secret) {
      setLocalError(`The ${secretLabel.toLowerCase()} is required.`);
      setActive(0);
      return;
    }
    const options: Record<string, string> = {};
    for (const [at, f] of fields.entries()) {
      const value = valueOf(optionRowId(f.name)).trim();
      if (!value) {
        setLocalError(`${f.label} is required.`);
        setActive(at + 1);
        return;
      }
      options[f.name] = value;
    }
    const name = valueOf(NAME_ROW).trim();
    if (!name) {
      setLocalError('Name needs at least one letter or number.');
      setActive(rows.length - 1);
      return;
    }
    props.onSubmit({ secret, options, name });
  };

  useInput((input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    const row = rows[active];
    if (!row) {
      return;
    }
    if (key.tab) {
      move(key.shift ? -1 : 1);
      return;
    }
    if (key.upArrow) {
      move(-1);
      return;
    }
    if (key.downArrow) {
      move(1);
      return;
    }
    if (key.return || input === '\r' || input === '\n') {
      if (active < rows.length - 1) {
        move(1);
        return;
      }
      submit();
      return;
    }

    const value = valueOf(row.id);
    const cursor = cursorOf(row.id);

    // A qualifier with known values cycles under ← →; a free-text row uses the
    // arrows to move the cursor, so the choice list has to be checked first.
    if ((key.leftArrow || key.rightArrow) && row.choices && row.choices.length > 0) {
      const next = cycle(row.choices, value, key.leftArrow ? -1 : 1);
      write(row.id, next, graphemeLength(next));
      return;
    }
    const edit = lineEditFor(input, key);
    if (edit) {
      const next = applyLineEdit({ value, cursor }, edit);
      write(row.id, next.value, next.cursor);
    }
  });

  const labelWidth = Math.max(...rows.map((r) => r.label.length)) + 2;
  const focusedRow = rows[active];
  const onLastRow = active === rows.length - 1;

  const renderRow = (row: Row, index: number) => {
    const value = valueOf(row.id);
    const focused = index === active;
    const { before, at, after } = renderLine(
      { value, cursor: cursorOf(row.id) },
      Boolean(row.secret),
    );
    return (
      <Box key={row.id}>
        <Text bold={focused} color={focused ? brandColor('accent') : undefined}>
          {focused ? `${G.focus} ` : '  '}
          {row.label.padEnd(labelWidth)}
        </Text>
        <Text>
          {focused ? (
            <>
              {before}
              <Text inverse>{at}</Text>
              {after}
            </>
          ) : value ? (
            displayValue(value, Boolean(row.secret))
          ) : (
            <Text dimColor>not set</Text>
          )}
        </Text>
      </Box>
    );
  };

  return (
    <ScreenShell
      path={['accounts', 'add', secretLabel.toLowerCase()]}
      error={localError ?? props.error}
      outcome={onLastRow ? 'enter save' : 'enter next field'}
      support={
        focusedRow?.choices
          ? '← → choose · tab switch field · esc back'
          : 'tab switch field · esc back'
      }
      hints={[
        { key: '← →', label: 'choose', when: Boolean(focusedRow?.choices) },
        { key: 'tab', label: 'switch field' },
        { key: 'enter', label: onLastRow ? 'save' : 'next field' },
        { key: 'esc', label: 'back' },
      ]}
    >
      <Box flexDirection="column">
        <Text bold> New {secretLabel}</Text>
        <Text dimColor>
          {' '}
          Stored for {providerName}&apos;s proxy only — your signed-in login is left alone.
        </Text>
        <Text> </Text>
        {rows.map(renderRow)}
        {focusedRow?.choices?.length ? (
          <Box marginTop={1}>
            <Text>{' '.repeat(2 + labelWidth)}</Text>
            {focusedRow.choices.map((choice, i) => {
              const picked = choice === valueOf(focusedRow.id);
              return (
                <Text key={choice} bold={picked} dimColor={!picked}>
                  {i > 0 ? ' · ' : ''}
                  {choice}
                </Text>
              );
            })}
          </Box>
        ) : null}
      </Box>
    </ScreenShell>
  );
}
