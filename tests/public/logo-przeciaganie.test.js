import { describe, it, expect, vi } from 'vitest';
import { podlaczStrefe, sprawdzPlik, MAKS_BAJTOW } from '../../src/public/logo-przeciaganie.js';

// PRZ-108.03b: przeciąganie pliku w sekcji Logo (Ustawienia → Firma). Plik, który naprawdę jedzie do przeglądarki,
// na atrapach elementów (repo nie ma biblioteki DOM). Zasada: upuszczony plik trafia do TEGO SAMEGO
// <input type="file" name="logo"> (przez DataTransfer), więc formularz wysyła go jak plik wybrany z dysku;
// serwer i tak sprawdza typ i rozmiar — przeglądarka tylko mówi o błędzie od razu.

const plik = (nazwa = 'znak.png', rozmiar = 1000, typ = 'image/png') => ({ name: nazwa, size: rozmiar, type: typ });

function klasy() {
  const zbior = new Set();
  return { add: (k) => zbior.add(k), remove: (k) => zbior.delete(k), contains: (k) => zbior.has(k), toggle: (k, on) => (on ? zbior.add(k) : zbior.delete(k)) };
}
function strefa() {
  const sluchacze = {};
  const wejscie = { files: [], value: 'x', _ustawione: null, dispatch: [], addEventListener(t, f) { (this.sl ??= {})[t] = f; } };
  const stan = { textContent: '', dataset: {}, classList: klasy() };
  const podglad = { hidden: true, src: '', alt: '', addEventListener(t, f) { (this.sl ??= {})[t] = f; } };
  const el = {
    dataset: {}, classList: klasy(),
    addEventListener(t, f) { sluchacze[t] = f; },
    contains: (cel) => cel?.wewnatrz === true,
    querySelector: (s) => (s.includes('type="file"') || s.includes('input') ? wejscie : s.includes('stan') ? stan : s.includes('podglad') ? podglad : null),
  };
  wejscie.setCustomValidity = (t) => { wejscie.walidacja = t; };
  return { el, wejscie, stan, podglad, wyslij: (typ, zdarzenie = {}) => sluchacze[typ]?.({ preventDefault: vi.fn(), ...zdarzenie }) };
}
function srodowisko() {
  const dt = { items: { dodane: [], add(f) { this.dodane.push(f); } }, get files() { return [...this.items.dodane]; } };
  return { DataTransfer: function DataTransfer() { return dt; }, URL: { createObjectURL: vi.fn(() => 'blob:podglad-1'), revokeObjectURL: vi.fn() }, dt };
}
const upuszczenie = (pliki, typy = ['Files']) => ({ dataTransfer: { files: pliki, types: typy, dropEffect: '' } });

describe('sprawdzPlik', () => {
  it('PNG do 256 KB włącznie jest dobry', () => {
    expect(sprawdzPlik(plik('a.png', 1))).toBeNull();
    expect(sprawdzPlik(plik('a.png', MAKS_BAJTOW))).toBeNull();
    expect(MAKS_BAJTOW).toBe(256 * 1024);
  });
  it('bajt ponad limit i inny typ dostają komunikat po polsku', () => {
    expect(sprawdzPlik(plik('a.png', MAKS_BAJTOW + 1))).toMatch(/większy niż 256 KB/);
    expect(sprawdzPlik(plik('a.svg', 100, 'image/svg+xml'))).toMatch(/PNG/);
    expect(sprawdzPlik(plik('a.jpg', 100, 'image/jpeg'))).toMatch(/PNG/);
  });
  it('system bez typu MIME: decyduje rozszerzenie .png (wielkość liter bez znaczenia)', () => {
    expect(sprawdzPlik(plik('ZNAK.PNG', 100, ''))).toBeNull();
    expect(sprawdzPlik(plik('znak.txt', 100, ''))).toMatch(/PNG/);
  });
  it('brak pliku', () => { expect(sprawdzPlik(undefined)).toMatch(/Wybierz/); });
});

describe('podlaczStrefe', () => {
  it('upuszczony PNG trafia do pola pliku przez DataTransfer, widać nazwę i podgląd', () => {
    const s = strefa(); const env = srodowisko();
    podlaczStrefe(s.el, env);
    const f = plik('moje-logo.png', 2048);
    s.wyslij('drop', upuszczenie([f]));
    expect(env.dt.items.dodane).toEqual([f]);
    expect(s.wejscie.files).toEqual([f]);
    expect(s.stan.textContent).toContain('moje-logo.png');
    expect(s.stan.textContent).toContain('2 KB');
    expect(s.podglad.hidden).toBe(false);
    expect(s.podglad.src).toBe('blob:podglad-1');
    expect(s.el.dataset.stan).toBe('wybrany');
  });
  it('upuszczenie zatrzymuje domyślną akcję przeglądarki (inaczej otworzyłaby plik zamiast go wybrać)', () => {
    const s = strefa(); podlaczStrefe(s.el, srodowisko());
    const preventDefault = vi.fn();
    s.wyslij('drop', { ...upuszczenie([plik()]), preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    const nad = vi.fn();
    s.wyslij('dragover', { ...upuszczenie([], ['Files']), preventDefault: nad });
    expect(nad).toHaveBeenCalled();
  });
  it('podświetla strefę przy przeciąganiu pliku nad nią i gasi po opuszczeniu i po upuszczeniu', () => {
    const s = strefa(); podlaczStrefe(s.el, srodowisko());
    s.wyslij('dragenter', upuszczenie([], ['Files']));
    expect(s.el.classList.contains('logo-strefa--nad')).toBe(true);
    s.wyslij('dragleave', { relatedTarget: { wewnatrz: true } }); // przejście na element wewnątrz strefy nie gasi
    expect(s.el.classList.contains('logo-strefa--nad')).toBe(true);
    s.wyslij('dragleave', { relatedTarget: null });
    expect(s.el.classList.contains('logo-strefa--nad')).toBe(false);
    s.wyslij('dragenter', upuszczenie([], ['Files']));
    s.wyslij('drop', upuszczenie([plik()]));
    expect(s.el.classList.contains('logo-strefa--nad')).toBe(false);
  });
  it('przeciąganie tekstu (nie plików) nie podświetla strefy', () => {
    const s = strefa(); podlaczStrefe(s.el, srodowisko());
    s.wyslij('dragenter', upuszczenie([], ['text/plain']));
    expect(s.el.classList.contains('logo-strefa--nad')).toBe(false);
  });
  it.each([
    ['plik inny niż PNG', [plik('a.svg', 100, 'image/svg+xml')], /PNG/],
    ['plik większy niż 256 KB', [plik('a.png', MAKS_BAJTOW + 1)], /256 KB/],
    ['kilka plików naraz', [plik('a.png'), plik('b.png')], /jeden plik/i],
  ])('%s: komunikat od razu, pole zostaje puste, bez podglądu', (_n, pliki, wzor) => {
    const s = strefa(); const env = srodowisko();
    podlaczStrefe(s.el, env);
    s.wyslij('drop', upuszczenie(pliki));
    expect(s.stan.textContent).toMatch(wzor);
    expect(s.el.dataset.stan).toBe('blad');
    expect(env.dt.items.dodane).toEqual([]);
    expect(s.wejscie.value).toBe('');
    expect(s.podglad.hidden).toBe(true);
    expect(env.URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('plik wybrany z dysku (zdarzenie change) przechodzi tę samą kontrolę i ten sam podgląd', () => {
    const s = strefa(); const env = srodowisko();
    podlaczStrefe(s.el, env);
    s.wejscie.files = [plik('z-dysku.png', 500)];
    s.wejscie.sl.change();
    expect(s.stan.textContent).toContain('z-dysku.png');
    expect(s.podglad.hidden).toBe(false);
    s.wejscie.files = [plik('z-dysku.gif', 500, 'image/gif')];
    s.wejscie.sl.change();
    expect(s.el.dataset.stan).toBe('blad');
    expect(s.wejscie.value).toBe('');
    expect(s.podglad.hidden).toBe(true);
  });
  it('kolejny wybór zwalnia poprzedni adres podglądu', () => {
    const s = strefa(); const env = srodowisko();
    podlaczStrefe(s.el, env);
    s.wyslij('drop', upuszczenie([plik('a.png')]));
    s.wyslij('drop', upuszczenie([plik('b.png')]));
    expect(env.URL.revokeObjectURL).toHaveBeenCalledWith('blob:podglad-1');
  });
  it('plik, którego przeglądarka nie umie narysować, dostaje ostrzeżenie zamiast pustego podglądu', () => {
    const s = strefa(); podlaczStrefe(s.el, srodowisko());
    s.wyslij('drop', upuszczenie([plik('uszkodzony.png')]));
    s.podglad.sl.error();
    expect(s.stan.textContent).toMatch(/nie wygląda na obraz/);
    expect(s.podglad.hidden).toBe(true);
  });
});
