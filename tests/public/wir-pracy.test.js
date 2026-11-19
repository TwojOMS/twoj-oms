// Kółko pracy w tle na ekranie importu: po podmianie sekcji przez htmx animacja nie może
// zaczynać się od zera, bo kółko przeskakiwałoby co odświeżenie.
import { describe, expect, it } from 'vitest';
import { podlaczWirPracy } from '../../src/public/oms-nawigacja.js';

function korzen(wir) {
  const listenery = new Map();
  return {
    addEventListener(typ, fn) {
      listenery.set(typ, fn);
    },
    getElementById: (id) => (id === 'import-wir' ? wir : null),
    wyslij(typ) {
      listenery.get(typ)?.();
    },
  };
}

describe('podlaczWirPracy', () => {
  it('po podmianie sekcji wyrównuje animację kółka do osi czasu dokumentu', () => {
    const animacja = { startTime: 1234 };
    const root = korzen({ getAnimations: () => [animacja] });
    podlaczWirPracy(root);
    root.wyslij('htmx:afterSwap');
    expect(animacja.startTime).toBe(0);
  });

  it('bez kółka na stronie podmiana niczego nie psuje', () => {
    const root = korzen(null);
    podlaczWirPracy(root);
    expect(() => root.wyslij('htmx:afterSwap')).not.toThrow();
  });
});
