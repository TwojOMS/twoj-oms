// PRZ-122.B07b — domknięcie uwag (1), (2), (4) z odbioru B07a (stawka „zw”):
// (1) formularz nowego zamówienia przekazuje flagę `zw` — przy domyślnej „zw” netto → brutto bez „NaN”;
// (2) podgląd w przeglądarce (`podepnij`) przy `data-vat="zw"` działa, a nie wyłącza się na `Number('zw')`;
// (4) bez „zw” na liście stawek formularza (program inny niż wbudowany) wiersz „zw” to odmowa serwera → myślnik,
//     nie kwota policzona jak 0%. Dane zmyślone.
import { describe, it, expect } from 'vitest';
import { parsujPozycjeFormularza, parsujNoweZamowienie, wstawPozycjeDoFormularza } from '../../src/domena/nowe-zamowienie.js';
import { podepnij } from '../../src/public/suma-podglad.js';

describe('(1) parsujPozycjeFormularza / parsujNoweZamowienie z flagą `zw`', () => {
  const cialo = { poz_nazwa: ['Kurs lutowania'], poz_ilosc: ['2'], poz_cena_netto: ['57,00'], poz_cena_brutto: [''], poz_vat: [''] };

  it('domyślna „zw”, wiersz z samym netto → brutto = netto (nie „NaN”), stawka „zw”', () => {
    const [p] = parsujPozycjeFormularza(cialo, { stawkaDomyslna: 'zw', zw: true });
    expect(p).toMatchObject({ cena_brutto: '57.00', brutto_linii: '114.00', vat: 'zw' });
  });

  it('wiersz z wybraną „zw” przy domyślnej 23 → przyjęty z flagą, odmowa bez niej (jak dotąd)', () => {
    const zw = { ...cialo, poz_vat: ['zw'] };
    expect(parsujPozycjeFormularza(zw, { stawkaDomyslna: '23', zw: true })[0]).toMatchObject({ cena_brutto: '57.00', vat: 'zw' });
    expect(() => parsujPozycjeFormularza(zw, { stawkaDomyslna: '23' })).toThrow(/Nieznana stawka VAT „zw”/u);
  });

  it('parsujNoweZamowienie przekazuje flagę do pozycji', () => {
    const d = parsujNoweZamowienie({ ...cialo, w_nazwa: 'Jan Testowy', dostawa: 'odbior_osobisty' }, { stawkaDomyslna: 'zw', zw: true });
    expect(d.pozycje[0]).toMatchObject({ cena_brutto: '57.00', vat: 'zw' });
  });

  it('wstawPozycjeDoFormularza przy domyślnej „zw” pokazuje netto = brutto, nie „NaN”', () => {
    const f = wstawPozycjeDoFormularza({}, { nazwa: 'Kurs', ilosc: 1, cena_brutto: '57.00' }, { stawkaDomyslna: 'zw', zw: true });
    expect(f.poz_cena_netto[0]).toBe('57.00');
    expect(f.poz_vat[0]).toBe('zw');
  });
});

// --- Atrapa DOM dla `podepnij` (w repo nie ma jsdom): tylko selektory, których dotyka public/suma-podglad.js. ---
function pole(value) { return { value }; }
function wiersz(dane) {
  const pola = Object.fromEntries(Object.entries(dane).map(([k, v]) => [`[name="poz_${k}"]`, pole(v)]));
  const suma = { textContent: '' };
  return { suma, querySelector: (sel) => (sel === '[data-suma-linii]' ? suma : pola[sel] ?? null) };
}
function strona({ vat, wiersze, dostawa = '', zwNaLiscie }) {
  const wyjscia = {};
  const wyj = (sel) => { wyjscia[sel] ??= { textContent: '', hidden: false }; return wyjscia[sel]; };
  const formularz = {
    dataset: { vat, wdt: '0' },
    addEventListener: () => {},
    querySelector: (sel) => {
      if (sel === '[name="koszt_dostawy_brutto"]') return pole(dostawa);
      if (sel === '[name="f_nip"]') return pole('');
      if (sel === 'option[value="zw"]') return zwNaLiscie ? { value: 'zw' } : null;
      return null;
    },
  };
  const tr = wiersze.map(wiersz);
  const tabela = { closest: () => formularz, querySelectorAll: () => tr };
  const dokument = { querySelector: (sel) => (sel === '[data-podglad-kwoty]' ? tabela : wyj(sel)) };
  return { dokument, wyjscia, tr };
}
const W = (o) => ({ nazwa: 'Kurs', sku: '', ilosc: '1', cena_netto: '', cena_brutto: '', vat: '', ...o });

describe('(2) podepnij przy `data-vat="zw"` (firma zwolniona, TwojeFaktury)', () => {
  it('podgląd działa: netto = brutto, VAT 0, dostawa „zw” bez „%”', () => {
    const s = strona({ vat: 'zw', zwNaLiscie: true, dostawa: '10.00', wiersze: [W({ cena_brutto: '57.00' })] });
    expect(podepnij(s.dokument)).toBeTypeOf('function');
    expect(s.wyjscia['[data-razem]'].textContent).toBe('67.00 zł');
    expect(s.wyjscia['[data-pv-netto]'].textContent).toBe('67.00');
    expect(s.wyjscia['[data-pv-vat]'].textContent).toBe('0.00');
    expect(s.wyjscia['[data-dostawa-netto]'].textContent).toBe('10.00 zł');
    expect(s.wyjscia['[data-dostawa-stawka]'].textContent).toBe('zw');
    expect(s.tr[0].suma.textContent).toBe('57.00 zł');
  });

  it('domyślna „zw”, wiersz z samym netto — brutto bez narzutu', () => {
    const s = strona({ vat: 'zw', zwNaLiscie: true, wiersze: [W({ ilosc: '2', cena_netto: '40,50' })] });
    podepnij(s.dokument);
    expect(s.wyjscia['[data-razem]'].textContent).toBe('81.00 zł');
    expect(s.wyjscia['[data-pv-vat]'].textContent).toBe('0.00');
  });
});

describe('(4) wiersz „zw” bez „zw” na liście formularza = odmowa serwera → myślnik', () => {
  it('lista bez „zw” (inFakt): wiersz „zw” nie liczy się jako 0%, podgląd pokazuje „—”', () => {
    const s = strona({ vat: '23', zwNaLiscie: false, wiersze: [W({ cena_brutto: '57.00', vat: 'zw' })] });
    podepnij(s.dokument);
    expect(s.wyjscia['[data-razem]'].textContent).toBe('—');
    expect(s.wyjscia['[data-pv-vat]'].textContent).toBe('—');
    expect(s.tr[0].suma.textContent).toBe('');
  });

  it('lista z „zw” (TwojeFaktury), domyślna 23: wiersz „zw” liczony jak serwer z flagą — VAT tylko od 23%', () => {
    const s = strona({ vat: '23', zwNaLiscie: true, wiersze: [W({ cena_brutto: '57.00', vat: 'zw' }), W({ cena_brutto: '123.00', vat: '23' })] });
    podepnij(s.dokument);
    expect(s.wyjscia['[data-razem]'].textContent).toBe('180.00 zł');
    expect(s.wyjscia['[data-pv-vat]'].textContent).toBe('23.00');
  });

  it('bez „zw” nic się nie zmienia: 23% jak dotąd', () => {
    const s = strona({ vat: '23', zwNaLiscie: false, wiersze: [W({ cena_brutto: '123.00' })] });
    podepnij(s.dokument);
    expect(s.wyjscia['[data-pv-vat]'].textContent).toBe('23.00');
    expect(s.wyjscia['[data-dostawa-stawka]'].textContent).toBe('23%');
  });
});
