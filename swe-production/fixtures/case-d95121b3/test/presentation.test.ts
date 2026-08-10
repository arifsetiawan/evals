import { describe, it, expect } from 'vitest';
import { SEARCH_SOURCES } from '../src/sources';
import { TYPE_LABELS, TYPE_ICONS, TYPE_COLORS, labelFor, type SearchRowKind } from '../src/presentation';

/**
 * Every row kind the API can put in a result set — the record sources plus the two
 * that are not records. The earlier version of this file iterated `SEARCH_SOURCES`
 * alone, which is why `fanout` shipped rendering its raw key as the group heading.
 */
const ALL_ROW_KINDS: SearchRowKind[] = [
  ...SEARCH_SOURCES.map((s) => s.kind),
  'menu',
  'fanout',
];

/**
 * Adding a search source without an entry here does not crash — the omnibox just
 * renders the raw key, so a supplier appears under a heading reading "vendor". That
 * shipped once; these tests are why it cannot again.
 */
describe('search result presentation', () => {
  it('gives every row kind a label, icon and colour — not just the record sources', () => {
    // Sources are the easy half. `menu` and `fanout` are rows too, and they are the
    // ones that actually shipped broken.
    for (const kind of ALL_ROW_KINDS) {
      expect(TYPE_LABELS[kind], `${kind} has no label`).toBeTruthy();
      expect(TYPE_ICONS[kind], `${kind} has no icon`).toBeTruthy();
      expect(TYPE_COLORS[kind], `${kind} has no colour`).toBeTruthy();
    }
  });

  it('never lets a row kind render as its own raw key', () => {
    // "FANOUT" as a heading is the failure this whole file exists to prevent, and it
    // reached production once because the check below was scoped too narrowly.
    for (const kind of ALL_ROW_KINDS) {
      expect(labelFor(kind), `${kind} renders as its raw key`).not.toBe(kind);
    }
  });

  it('never shows a table or module name as a heading', () => {
    // "Vendor" is what the table is called; "Pemasok" is what the shop owner says.
    const systemWords = ['vendor', 'pos', 'bill', 'receipt', 'contact', 'employee', 'task', 'sku'];
    for (const label of Object.values(TYPE_LABELS)) {
      expect(systemWords, `heading "${label}" is a system word`).not.toContain(label.toLowerCase());
    }
  });

  it('falls back to the raw kind rather than rendering nothing', () => {
    // A hit whose source was removed should still be readable, not a blank heading.
    expect(labelFor('sesuatu-yang-baru')).toBe('sesuatu-yang-baru');
  });
});
