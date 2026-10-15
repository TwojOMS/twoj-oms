import { describe, expect, it, vi } from 'vitest';
import { podlaczMenu } from '../../src/public/oms-nawigacja.js';

function szczegoly(nazwa) {
  const listenery = new Map();
  const summary = { focus: vi.fn() };
  return {
    nazwa,
    open: false,
    summary,
    addEventListener(typ, fn) { listenery.set(typ, fn); },
    removeEventListener(typ) { listenery.delete(typ); },
    querySelector(selektor) { return selektor === 'summary' ? summary : null; },
    contains(cel) { return cel === this || cel === summary; },
    emit(typ, event = {}) { listenery.get(typ)?.({ target: this, ...event }); },
  };
}

function korzen(elementy) {
  const listenery = new Map();
  return {
    addEventListener(typ, fn) { listenery.set(typ, fn); },
    removeEventListener(typ) { listenery.delete(typ); },
    querySelectorAll(selektor) { return selektor === 'details[data-menu]' ? elementy : []; },
    emit(typ, event) { listenery.get(typ)?.(event); },
  };
}

describe('podlaczMenu', () => {
  it('Escape zamyka otwarty panel i oddaje fokus jego summary', () => {
    const konto = szczegoly('konto');
    konto.open = true;
    const root = korzen([konto]);
    const preventDefault = vi.fn();
    const odlacz = podlaczMenu(root);

    root.emit('keydown', { key: 'Escape', preventDefault });

    expect(konto.open).toBe(false);
    expect(konto.summary.focus).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
    odlacz();
  });

  it('otwarcie jednego panelu zamyka pozostałe', () => {
    const konto = szczegoly('konto');
    const glowne = szczegoly('glowne');
    konto.open = true;
    const root = korzen([konto, glowne]);
    podlaczMenu(root);

    glowne.open = true;
    glowne.emit('toggle');

    expect(konto.open).toBe(false);
    expect(glowne.open).toBe(true);
  });

  it('klik poza panelami zamyka je bez przechwytywania formularzy', () => {
    const konto = szczegoly('konto');
    konto.open = true;
    const root = korzen([konto]);
    const preventDefault = vi.fn();
    podlaczMenu(root);

    root.emit('click', { target: {}, preventDefault });

    expect(konto.open).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
