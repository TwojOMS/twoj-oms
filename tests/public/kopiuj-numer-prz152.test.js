// PRZ-152.G8 — przycisk „kopiuj numer" na karcie paczki. Bez JS zostaje ukryty (numer da się
// zaznaczyć ręcznie); skrypt go odsłania i kopiuje numer do schowka.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { podlaczKopiowanie } from '../../src/public/oms-nawigacja.js';

function przycisk(numer) {
  const listenery = new Map();
  return {
    hidden: true,
    textContent: 'kopiuj numer',
    dataset: { kopiujNumer: numer },
    addEventListener(typ, fn) { listenery.set(typ, fn); },
    klik() { return listenery.get('click')?.({ preventDefault() {} }); },
  };
}

const korzen = (przyciski) => ({
  querySelectorAll: (selektor) => (selektor === '[data-kopiuj-numer]' ? przyciski : []),
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('podlaczKopiowanie', () => {
  it('odsłania przycisk i kopiuje numer do schowka, z krótkim „Skopiowano"', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const b = przycisk('0000111222333U');
    podlaczKopiowanie(korzen([b]));
    expect(b.hidden).toBe(false);
    await b.klik();
    expect(writeText).toHaveBeenCalledWith('0000111222333U');
    expect(b.textContent).toBe('Skopiowano');
    vi.advanceTimersByTime(2000);
    expect(b.textContent).toBe('kopiuj numer');
  });

  // Piaskownica i instalacje w sieci lokalnej chodzą po http — tam `navigator.clipboard` nie istnieje.
  it('bez Clipboard API kopiuje przez execCommand na tymczasowym polu', async () => {
    const pole = { value: '', select: vi.fn(), remove: vi.fn(), setAttribute() {}, style: {} };
    const execCommand = vi.fn(() => true);
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('document', { execCommand, createElement: () => pole, body: { append: vi.fn() } });
    const b = przycisk('X1');
    podlaczKopiowanie(korzen([b]));
    expect(b.hidden).toBe(false);
    await b.klik();
    expect(pole.value).toBe('X1');
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(pole.remove).toHaveBeenCalled();
    expect(b.textContent).toBe('Skopiowano');
  });

  it('bez żadnej drogi do schowka przycisk zostaje ukryty (numer zaznacza się ręcznie)', () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('document', {});
    const b = przycisk('X1');
    podlaczKopiowanie(korzen([b]));
    expect(b.hidden).toBe(true);
  });
});
