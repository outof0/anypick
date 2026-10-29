/**
 * The macOS app uses SF Symbols. A webview has no SF Symbols, so these are
 * hand-drawn paths in the same silhouette, not a substitute icon set: the
 * sidebar's meaning is carried by the label beside the glyph, never by the
 * glyph alone.
 */
export function Symbol({ name, size = 15 }: { name: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/*
        An unknown name must not silently become a square: a row whose provider
        has no mark and no table entry should say so, not look like Overview.
        `fallbackSymbolFor` in lib/brands.ts is what every provider path should
        go through; this is the last resort for a name nobody mapped.
      */}
      <path d={SYMBOL_PATHS[name] ?? SYMBOL_PATHS['app.dashed']} />
    </svg>
  );
}

const SYMBOL_PATHS: Record<string, string> = {
  'square.grid.2x2': 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z',
  'app.badge': 'M5 4h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M16 13a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z',
  'person.2':
    'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M2 20a7 7 0 0 1 14 0 M16 5.2a3.5 3.5 0 0 1 0 6.6 M17 14.4A7 7 0 0 1 22 20',
  'point.3.connected.trianglepath.dotted':
    'M5 6h5l4 6 5-3 M5 18h5l4-6 M19 5l1 1-1 1 M19 15l1 1-1 1',
  'server.rack': 'M4 5h16v5H4z M4 14h16v5H4z M7 7.5h.01 M7 16.5h.01 M10 7.5h6 M10 16.5h6',
  'list.bullet': 'M9 6h11 M9 12h11 M9 18h11 M4.5 6h.01 M4.5 12h.01 M4.5 18h.01',
  'externaldrive.badge.timemachine': 'M4 6h16v9H4z M4 15v3h16v-3 M12 6v9 M9 12l3 3 3-3',
  'gearshape': 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M12 2v3 M12 19v3 M2 12h3 M19 12h3',
  'chart.bar': 'M4 20h16 M7 16V9 M12 16V5 M17 16v-4',
  'lock': 'M7 11V8a5 5 0 0 1 10 0v3 M5 11h14v9H5z',
  'stethoscope': 'M6 3v6a4 4 0 0 0 8 0V3 M6 3H4 M6 3h2 M14 3h2 M10 13v2a5 5 0 0 0 5 5h1',
  'checkmark.circle': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M8 12l3 3 5-6',
  'exclamationmark.triangle': 'M12 4 21 20H3L12 4z M12 10v4 M12 17h.01',
  'xmark.circle': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M9 9l6 6 M15 9l-6 6',
  'arrow.triangle.2.circlepath':
    'M4 12a8 8 0 0 1 14-5 M20 12a8 8 0 0 1-14 5 M18 3v4h-4 M6 21v-4h4',
  'person.crop.circle': 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M5 20a7 7 0 0 1 14 0',
  'network': 'M12 3v6 M6 21v-4 M18 21v-4 M12 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  'clock.arrow.circlepath':
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2 M18 3l2 2-2 2',
  'magnifyingglass': 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-5-5',
  'person.badge.plus': 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M2 20a7 7 0 0 1 11-5.7 M18 15v6 M15 18h6',
  'ellipsis.circle': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M8 12h.01 M12 12h.01 M16 12h.01',
  'chevron.right': 'M9 5l7 7-7 7',
  'chevron.left': 'M15 5l-7 7 7 7',
  'plus': 'M12 5v14 M5 12h14',
  'arrow.clockwise': 'M20 11a8 8 0 1 0 1 4 M20 5v6h-6',
  'arrow.up.forward.app': 'M13 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7 M12 12l8-8 M15 4h5v5',
  'line.3.horizontal.decrease': 'M3 6h18 M6 12h12 M9 18h6',
  'square.and.arrow.down': 'M12 3v12 M8 11l4 4 4-4 M4 19h16',
  'sparkles': 'M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z',
  'lock.laptopcomputer': 'M6 11V8a5 5 0 0 1 10 0v3 M4 11h16v8H4z M2 19h20',
  'arrow.triangle.branch': 'M6 21V9a4 4 0 0 1 4-4 M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 15V9a4 4 0 0 0-4-4',
  'play': 'M7 4l13 8-13 8z',
  'stop': 'M6 6h12v12H6z',
  'trash': 'M4 7h16 M9 7V4h6v3 M6 7l1 14h10l1-14',
  'eye': 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  'doc.text': 'M6 3h8l4 4v14H6z M14 3v4h4 M9 12h6 M9 16h6',
  // The copy pair. Both live in one table so a copy command and its
  // confirmation can never drift into two different hand-drawn marks, and so
  // the widths match: `IconButton` holds a fixed box, so a swap costs nothing.
  'doc.on.doc':
    'M9 3h6l4 4v9 M15 3v4h4 M9 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h8 M15 3h4 M20 15v6 M17 18l3 3 3-3',
  'checkmark': 'M20 6 9 17l-4-4',

  // Provider marks. One silhouette per provider, so two unbundled rows never
  // collapse into the same glyph — the reason macOS keeps a fallback *table*
  // (`BrandIcons.swift:366`) rather than one generic icon.
  'brain.head.profile': 'M12 5a4 4 0 0 0-4 4 3 3 0 0 0 0 6 4 4 0 0 0 4 4 M12 5v14 M9 9h1.5 M14 12h1.5 M9 15h1.5',
  'terminal': 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z M8 9l3 3-3 3 M13 15h4',
  'sparkle': 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z',
  'shippingbox': 'M3 7l9-4 9 4v10l-9 4-9-4z M3 7l9 4 9-4 M12 11v10 M7.5 5l9 4',
  'creditcard': 'M2 6h20v12H2z M2 10h20 M6 15h4',
  'bubble.left.and.bubble.right':
    'M3 8a4 4 0 0 1 4-4h4a4 4 0 0 1 0 8H9l-3 3v-3H7a4 4 0 0 1-4-4z M10 12a4 4 0 0 1 4-4h3a4 4 0 0 1 4 4 4 4 0 0 1-4 4h-1v3l-3-3h-3a4 4 0 0 1 0-8z',
  'moon': 'M20 14A8.5 8.5 0 0 1 10 4a8.5 8.5 0 1 0 10 10z',
  'z.circle': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M9 8l6 8 M15 8l-6 8',
  'curlybraces': 'M9 4c-2 0-2 3-2 4s-1 4-3 4c2 0 3 3 3 4s0 4 2 4 M15 4c2 0 2 3 2 4s1 4 3 4c-2 0-3 3-3 4s0 4-2 4',
  'character.textbox': 'M4 6h16v12H4z M8 10h8 M12 10v6',
  'wind': 'M3 8h11a3 3 0 1 0-3-3 M3 12h14a3 3 0 1 1-3 3 M3 16h9',
  'circle.grid.3x3': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 3v18 M3 12h18 M5.6 5.6l12.8 12.8 M18.4 5.6L5.6 18.4',
  'waveform.path': 'M3 12h3l2-6 3 12 3-9 2 5h5',
  'rectangle.3.group': 'M3 5h5v6H3z M9 5h5v6H9z M15 5h6v6h-6z M3 13h5v6H3z M9 13h5v6H9z M15 13h6v6h-6z',
  'circle.hexagongrid': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 8v8 M8.5 10l7 4 M8.5 14l7-4',
  'square.stack.3d.up': 'M12 3l9 5-9 5-9-5z M3 13l9 5 9-5 M3 17.5l9 5 9-5',
  'cpu': 'M7 7h10v10H7z M9.5 9.5h5v5h-5z M9 3v4 M15 3v4 M9 17v4 M15 17v4 M3 9h4 M3 15h4 M17 9h4 M17 15h4',
  'keyboard': 'M2 6h20v12H2z M6 10h.01 M10 10h.01 M14 10h.01 M18 10h.01 M6 14h12',
  'cloud': 'M6.5 18a4.5 4.5 0 0 1 .5-9 6 6 0 0 1 11.4 1.6A3.7 3.7 0 0 1 17.5 18z',
  'briefcase': 'M3 8h18v11H3z M8 8V5h8v3 M3 13h18',
  'bolt.horizontal.circle': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M13 8l-4 5h3l-1 3 4-5h-3z',
  'waveform.path.ecg': 'M2 12h4l2-5 3 10 3-8 2 4h6',
  'flame': 'M12 22c4 0 7-2.7 7-6.5 0-4.5-4-6-5-11-3 2-4 5-4 7 0 1-.6 2-1.4 2C7.6 13.5 7 12.7 7 11c-1.4 1.6-2 3.3-2 5C5 19.3 8 22 12 22z',
  'bolt': 'M13 2 4 14h6l-1 8 9-12h-6z',
  'waveform': 'M3 12h2l2-7 3 14 3-11 3 8 2-4h3',
  'figure.walk': 'M13 4.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z M11 22l2-7-3-3 1-5 4 3 3 1 M10 15l-3 7',
  'key': 'M14 8a4 4 0 1 1-3.4 6L4 20.6V17H8v-3h2v-2.3A4 4 0 0 1 14 8z',
  'app.fill': 'M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  'app.dashed': 'M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M9 15l3-6 3 6 M10.2 13.2h3.6',
} as const;