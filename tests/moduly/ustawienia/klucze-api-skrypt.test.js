import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const kod = readFileSync(new URL('../../../src/public/klucze-api.js', import.meta.url), 'utf8');
function element(dane = {}) {
  const nasluch = {};
  return { hidden: true, checked: false, ...dane,
    addEventListener: (typ, fn) => { nasluch[typ] = fn; },
    wywolaj: (typ, e) => nasluch[typ](e) };
}
function ekran({ clipboard, execCommand = vi.fn(() => true) } = {}) {
  const zakresy = [element({ checked: true }), element(), element()];
  const formularz = element();
  const wszystkie = element({ form: formularz });
  const kontrolka = element();
  const kopiuj = element();
  const pole = element({ value: 'fikcyjny-klucz', focus: vi.fn(), select: vi.fn() });
  const wynik = element();
  const usun = element({ append: vi.fn(), hasAttribute: n => n === 'data-usun-klucz' });
  const odwolaj = element({ append: vi.fn(), hasAttribute: () => false });
  const confirm = vi.fn(() => false);
  const mapa = { '[data-zaznacz-wszystko]': wszystkie, '[data-wszystkie-zakresy]': kontrolka,
    '[data-kopiuj-klucz]': kopiuj, '#klucz-api-wartosc': pole, '[data-kopiowanie-wynik]': wynik };
  runInNewContext(kod, { document: {
    querySelector: s => mapa[s], querySelectorAll: s => ({
      '[data-usun-klucz], [data-odwolaj-klucz]': [usun, odwolaj],
      '[data-usun-klucz]': [usun], '[data-odwolaj-klucz]': [odwolaj],
      '.klucze-api-zakresy input[name="zakresy"]': zakresy,
    })[s] ?? [],
    createElement: () => ({}),
    execCommand,
  }, navigator: { clipboard }, window: { confirm }, setTimeout });
  return { zakresy, wszystkie, kontrolka, kopiuj, pole, wynik, usun, odwolaj, confirm, execCommand };
}
describe('Klucze API — skrypt formularza', () => {
  it('zaznacza i odznacza wszystkie, reaguje na pojedyncze zmiany i ustawia stan pośredni', () => {
    const e = ekran();
    expect(e.kontrolka.hidden).toBe(false);
    expect(e.wszystkie.checked).toBe(false);
    expect(e.wszystkie.indeterminate).toBe(true);
    e.wszystkie.checked = true;
    e.wszystkie.wywolaj('change');
    expect(e.zakresy.every(p => p.checked)).toBe(true);
    expect(e.wszystkie.indeterminate).toBe(false);
    e.zakresy[1].checked = false;
    e.zakresy[1].wywolaj('change');
    expect(e.wszystkie.checked).toBe(false);
    expect(e.wszystkie.indeterminate).toBe(true);
    e.wszystkie.wywolaj('change');
    expect(e.zakresy.every(p => !p.checked)).toBe(true);
    expect(e.wszystkie.indeterminate).toBe(false);
  });
  it('kopiuje cały klucz przez clipboard i ogłasza sukces', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const e = ekran({ clipboard: { writeText } });
    expect(e.kopiuj.hidden).toBe(false);
    await e.kopiuj.wywolaj('click');
    expect(writeText).toHaveBeenCalledWith(e.pole.value);
    expect(e.wynik.textContent).toBe('Skopiowano');
    expect(e.execCommand).not.toHaveBeenCalled();
  });
  it('po odmowie clipboard zaznacza pole i używa zapasu, nie ogłasza fałszywego sukcesu', async () => {
    const e = ekran({ clipboard: { writeText: vi.fn().mockRejectedValue(new Error('odmowa')) } });
    await e.kopiuj.wywolaj('click');
    expect(e.pole.select).toHaveBeenCalled();
    expect(e.execCommand).toHaveBeenCalledWith('copy');
    expect(e.wynik.textContent).toBe('Skopiowano');
    e.execCommand.mockReturnValue(false);
    await e.kopiuj.wywolaj('click');
    expect(e.wynik.textContent).toContain('skopiuj go ręcznie');
  });
  it('bez clipboard nadal próbuje kopiować; anulowanie confirm zatrzymuje usunięcie', async () => {
    const e = ekran();
    await e.kopiuj.wywolaj('click');
    expect(e.wynik.textContent).toBe('Skopiowano');
    const preventDefault = vi.fn();
    e.usun.wywolaj('submit', { preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(e.usun.append).not.toHaveBeenCalled();
    e.confirm.mockReturnValue(true);
    preventDefault.mockClear();
    e.usun.wywolaj('submit', { preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(e.usun.append).toHaveBeenCalledWith(expect.objectContaining({ type: 'hidden', name: 'potwierdzam', value: 'tak' }));
  });
  it('odwołanie też wymaga confirm i dokleja zgodę tylko po OK', () => {
    const e = ekran();
    const preventDefault = vi.fn();
    e.odwolaj.wywolaj('submit', { preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(e.odwolaj.append).not.toHaveBeenCalled();
    e.confirm.mockReturnValue(true);
    preventDefault.mockClear();
    e.odwolaj.wywolaj('submit', { preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(e.odwolaj.append).toHaveBeenCalledWith(expect.objectContaining({ name: 'potwierdzam', value: 'tak' }));
    expect(e.confirm).toHaveBeenLastCalledWith(expect.stringContaining('Odwołać'));
  });
});
