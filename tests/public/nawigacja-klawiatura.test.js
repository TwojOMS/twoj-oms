import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { podlaczMenu, SELEKTOR_MENU } from '../../src/public/oms-nawigacja.js';

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
    contains(cel) { return cel === this || cel === summary || cel?.wewnatrz === this; },
    emit(typ, event = {}) { listenery.get(typ)?.({ target: this, ...event }); },
  };
}

function korzen(elementy) {
  const listenery = new Map();
  return {
    addEventListener(typ, fn) { listenery.set(typ, fn); },
    removeEventListener(typ) { listenery.delete(typ); },
    querySelectorAll(selektor) { return selektor === SELEKTOR_MENU ? elementy : []; },
    emit(typ, event) { listenery.get(typ)?.(event); },
  };
}

// Cel kliknięcia w pozycję menu: `closest` odpowiada tylko na selektor pozycji wydruków.
const pozycja = (panel) => ({
  wewnatrz: panel,
  closest: (selektor) => (selektor.includes('.wydruki-menu a') ? {} : null),
});

afterEach(() => { vi.useRealTimers(); });

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

  it('klik w pozycję menu wydruków nie jest przechwytywany, a menu zamyka się po obsłudze kliknięcia', () => {
    vi.useFakeTimers();
    const wydruki = szczegoly('wydruki');
    wydruki.open = true;
    const root = korzen([wydruki]);
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    podlaczMenu(root);

    root.emit('click', { target: pozycja(wydruki), preventDefault, stopPropagation });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
    expect(wydruki.open).toBe(true); // jeszcze w trakcie kliknięcia: link/przycisk się wykona
    vi.runAllTimers();
    expect(wydruki.open).toBe(false);
  });

  it('klik w samo summary nie zamyka menu (otwieranie i zamykanie przez „Wydruki” zostaje po stronie przeglądarki)', () => {
    vi.useFakeTimers();
    const wydruki = szczegoly('wydruki');
    wydruki.open = true;
    const root = korzen([wydruki]);
    podlaczMenu(root);

    root.emit('click', { target: wydruki.summary });
    vi.runAllTimers();

    expect(wydruki.open).toBe(true);
  });

  it('otwarcie wydruków zamyka inne otwarte menu i odwrotnie', () => {
    const wydruki = szczegoly('wydruki');
    const konto = szczegoly('konto');
    const root = korzen([wydruki, konto]);
    podlaczMenu(root);

    wydruki.open = true;
    wydruki.emit('toggle');
    konto.open = true;
    konto.emit('toggle');

    expect(wydruki.open).toBe(false);
    expect(konto.open).toBe(true);
  });

  it('selektor obejmuje menu wydruków i data-menu, ale nie każdy <details>', () => {
    expect(SELEKTOR_MENU.split(',').map((x) => x.trim())).toEqual(['details[data-menu]', 'details.wydruki']);
  });

  it.each([
    'src/moduly/zamowienia/widoki/zamowienie.ejs',
    'src/moduly/zamowienia/widoki/lista.ejs',
  ])('widok %s oznacza menu wydruków klasą, którą łapie selektor', (plik) => {
    expect(readFileSync(plik, 'utf8')).toMatch(/<details class="wydruki[ "]/);
  });
});
