import { describe, it, expect, vi } from 'vitest';
import { obsluzEnter, usunWiersz, dodajWiersz, SELEKTOR_WIERSZA } from '../../src/public/pozycje-wiersze.js';

// PRZ-103: skrypt ekranu „Nowe zamówienie” — plik, który naprawdę jedzie do przeglądarki,
// na atrapach elementów (repo nie ma biblioteki DOM). Zachowanie na żywej stronie sprawdzone
// osobno w przeglądarce (lokalne demo).

const enter = (target, nad = {}) => ({ key: 'Enter', target, preventDefault: vi.fn(), ...nad });

describe('Enter w „Dodaj z magazynu” nie zakłada zamówienia', () => {
  it('w polu szukania: blokuje wysłanie formularza i szuka żywym fragmentem (htmx)', () => {
    const pole = { name: 'magazyn', closest: () => null, dispatchEvent: vi.fn(), form: null };
    const z = enter(pole);
    expect(obsluzEnter(z, { htmx: {} })).toBe(true);
    expect(z.preventDefault).toHaveBeenCalledOnce();
    expect(pole.dispatchEvent).toHaveBeenCalledOnce();
    expect(pole.dispatchEvent.mock.calls[0][0].type).toBe('search');
  });

  it('bez htmx: klika „Szukaj” (pełny formularz pod adres szukania)', () => {
    const szukaj = { click: vi.fn() };
    const pole = {
      name: 'magazyn', closest: () => null, dispatchEvent: vi.fn(),
      form: { querySelector: (s) => (s === '[data-szukaj-magazyn]' ? szukaj : null) },
    };
    const z = enter(pole);
    obsluzEnter(z, {});
    expect(z.preventDefault).toHaveBeenCalledOnce();
    expect(szukaj.click).toHaveBeenCalledOnce();
    expect(pole.dispatchEvent).not.toHaveBeenCalled();
  });

  it('w polu ilości przy wyniku: klika „Dodaj” TEGO wiersza', () => {
    const dodaj = { click: vi.fn() };
    const wiersz = { querySelector: (s) => (s === 'button[name="wybrany"]' ? dodaj : null) };
    const pole = { name: 'mag_ilosc', closest: (s) => (s === 'tr' ? wiersz : null) };
    const z = enter(pole);
    expect(obsluzEnter(z)).toBe(true);
    expect(z.preventDefault).toHaveBeenCalledOnce();
    expect(dodaj.click).toHaveBeenCalledOnce();
  });

  // Enter w danych klienta ZAKŁADA zamówienie — to zachowanie ekranu od 01.08 i zostaje.
  it.each([['w_nazwa'], ['poz_nazwa'], ['f_nip']])('pole %s: Enter zostaje przeglądarce', (name) => {
    const z = enter({ name, closest: () => null });
    expect(obsluzEnter(z)).toBe(false);
    expect(z.preventDefault).not.toHaveBeenCalled();
  });

  it('inny klawisz i Enter w trakcie składania znaku (IME) nie są ruszane', () => {
    const pole = { name: 'magazyn', closest: () => null, dispatchEvent: vi.fn() };
    expect(obsluzEnter({ key: 'a', target: pole, preventDefault: vi.fn() }, { htmx: {} })).toBe(false);
    expect(obsluzEnter(enter(pole, { isComposing: true }), { htmx: {} })).toBe(false);
    expect(pole.dispatchEvent).not.toHaveBeenCalled();
  });
});

// Atrapa tabeli: wiersz ma pola i przycisk „×”, tbody umie dodać/usunąć/skopiować wiersz.
function tabela(liczba) {
  const tbody = { wiersze: [] };
  const wiersz = (wartosc) => {
    const pola = [{ name: 'poz_nazwa', value: wartosc }, { name: 'poz_produkt_id', value: `ukryte-${wartosc}` }, { name: 'poz_ilosc', value: '3' }];
    const przycisk = { value: '', setAttribute(k, v) { this[k] = v; } };
    const suma = { textContent: '9,99 zł' };
    const tr = {
      parentNode: tbody, pola, przycisk, suma,
      querySelectorAll: (s) => (s === 'input' ? pola : []),
      querySelector: (s) => (s === '[data-usun-wiersz]' ? przycisk : s === '[data-suma-linii]' ? suma : null),
      remove() { tbody.wiersze.splice(tbody.wiersze.indexOf(tr), 1); },
      cloneNode: () => wiersz(pola[0].value),
    };
    return tr;
  };
  for (let i = 0; i < liczba; i += 1) tbody.wiersze.push(wiersz(`w${i}`));
  tbody.querySelectorAll = (s) => (s === SELEKTOR_WIERSZA ? [...tbody.wiersze] : []);
  tbody.appendChild = (tr) => { tbody.wiersze.push(tr); };
  return tbody;
}

describe('wiersze pozycji', () => {
  it('„×” usuwa wiersz i numeruje pozostałe od nowa', () => {
    const t = tabela(3);
    usunWiersz(t.wiersze[0]);
    expect(t.wiersze.map((w) => w.pola[0].value)).toEqual(['w1', 'w2']);
    expect(t.wiersze.map((w) => w.przycisk.value)).toEqual(['0', '1']);
    expect(t.wiersze[1].przycisk['aria-label']).toBe('Usuń wiersz 2');
  });

  // PRZ-106: ilość wraca do 1 — tak wygląda nowy wiersz, a wiersz z samą ilością jest pusty.
  it('ostatni wiersz nie znika, tylko się czyści — razem z ukrytymi polami i sumą linii; ilość = 1', () => {
    const t = tabela(1);
    usunWiersz(t.wiersze[0]);
    expect(t.wiersze).toHaveLength(1);
    expect(t.wiersze[0].pola.map((p) => p.value)).toEqual(['', '', '1']);
    expect(t.wiersze[0].suma.textContent).toBe('');
  });

  it('„+ Dodaj wiersz” dokłada PUSTY wiersz z ilością 1 — bez produktu, ceny i ilości skopiowanych z ostatniego', () => {
    const t = tabela(2);
    const nowy = dodajWiersz(t);
    expect(t.wiersze).toHaveLength(3);
    expect(nowy.pola.map((p) => p.value)).toEqual(['', '', '1']);
    expect(nowy.przycisk.value).toBe('2');
    expect(t.wiersze[1].pola[0].value).toBe('w1');
  });
});

// PRZ-105: nowy (wyczyszczony) wiersz dostaje stawkę DOMYŚLNĄ formularza, nie stawkę sklonowanego wiersza.
describe('wyczyscWiersz — lista stawek wraca do domyślnej (PRZ-105)', () => {
  it('select poz_vat = data-vat formularza; inputy czyszczone, ilość 1', async () => {
    const { wyczyscWiersz } = await import('../../src/public/pozycje-wiersze.js');
    const lista = { name: 'poz_vat', value: '5' };
    const pola = [{ name: 'poz_ilosc', value: '3' }, { name: 'poz_cena_netto', value: '9' }];
    const tr = {
      dataset: { zrodlo: 'netto' },
      querySelectorAll: (s) => (s === 'input' ? pola : s === 'select[name="poz_vat"]' ? [lista] : []),
      querySelector: () => null,
      closest: (s) => (s === 'form' ? { dataset: { vat: '8' } } : null),
    };
    wyczyscWiersz(tr);
    expect(lista.value).toBe('8');
    // Znacznik „ostatnio wpisane pole” (public/cena-netto.js) nie przechodzi na nowy wiersz.
    expect(tr.dataset.zrodlo).toBeUndefined();
    expect(pola.map((p) => p.value)).toEqual(['1', '']);
  });
});
