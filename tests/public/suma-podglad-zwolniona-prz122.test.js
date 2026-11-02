// PRZ-122.B07g — przeglądarka u firmy zwolnionej z VAT (TwojeFaktury + art. 113): numer VAT UE nabywcy to NIE WDT
// (decyzja właściciela 27.10). Formularz z `data-zwolniona="1"`: `public/suma-podglad.js` nie przestawia `data-wdt` na „1”
// po wpisaniu `DE123456789`, więc `public/cena-netto.js` liczy netto 100 przy 23% → brutto 123,00 (nie 100,00),
// a podgląd pokazuje stawkę firmy („zw”), nie „0% — WDT”. Kontrolnie: bez `data-zwolniona` — WDT jak dotąd.
// Atrapa DOM (w repo nie ma jsdom) — tylko selektory, których dotykają oba pliki. Dane zmyślone.
import { describe, it, expect } from 'vitest';
import { podepnij, kwotaFormularzaGrosze } from '../../src/public/suma-podglad.js';
import { przelicz } from '../../src/public/cena-netto.js';

const UE = 'DE123456789';

function pole(name, value = '') { return { name, value }; }

/** Wiersz tabeli: pola `poz_*` (suma-podglad) i te same obiekty dla cena-netto (`closest('tr')`). */
function wiersz(dane) {
  const pola = Object.fromEntries(Object.entries(dane).map(([k, v]) => [`[name="poz_${k}"]`, pole(`poz_${k}`, v)]));
  const suma = { textContent: '' };
  const tr = {
    suma,
    dataset: {},
    querySelector: (sel) => {
      if (sel === '[data-suma-linii]') return suma;
      if (pola[sel]) return pola[sel];
      // cena-netto.js pyta po końcówce nazwy: `input[name$="cena_netto"]`, `select[name$="vat"]`.
      const koncowka = /\$="([^"]+)"/u.exec(sel)?.[1];
      const p = koncowka ? Object.values(pola).find((x) => x.name.endsWith(koncowka)) : null;
      return p ?? null;
    },
    pole: (k) => pola[`[name="poz_${k}"]`],
  };
  for (const p of Object.values(pola)) p.closest = (s) => (s === 'tr' ? tr : null);
  return tr;
}

function strona({ vat, zwolniona, nip, wiersze, dostawa = '' }) {
  const wyjscia = {};
  const wyj = (sel) => { wyjscia[sel] ??= { textContent: '', hidden: false }; return wyjscia[sel]; };
  const dataset = { vat, wdt: '0', ...(zwolniona ? { zwolniona: '1' } : {}) };
  const formularz = {
    dataset,
    addEventListener: () => {},
    querySelector: (sel) => {
      if (sel === '[name="koszt_dostawy_brutto"]') return pole('koszt_dostawy_brutto', dostawa);
      if (sel === '[name="f_nip"]') return pole('f_nip', nip);
      if (sel === 'option[value="zw"]') return { value: 'zw' };
      return null;
    },
  };
  const tr = wiersze.map(wiersz);
  const tabela = { closest: () => formularz, querySelectorAll: () => tr };
  const dokument = { querySelector: (sel) => (sel === '[data-podglad-kwoty]' ? tabela : wyj(sel)) };
  return { dokument, wyjscia, tr, formularz };
}
const W = (o) => ({ nazwa: 'Lampa stołowa Kałamarz', sku: '', ilosc: '1', cena_netto: '', cena_brutto: '', vat: '', ...o });

/** Operator wpisuje netto w wierszu: najpierw cena-netto.js (brutto), potem suma-podglad.js (nasłuch formularza). */
function wpiszNetto(s, i, netto) {
  const tr = s.tr[i];
  tr.pole('cena_netto').value = netto;
  przelicz({ target: tr.pole('cena_netto') }, s.formularz);
  return tr.pole('cena_brutto').value;
}

describe('PRZ-122.B07g firma zwolniona (`data-zwolniona="1"`), nabywca z numerem VAT UE — nie WDT', () => {
  it('po wpisaniu DE123456789 `data-wdt` nie przełącza się na „1”', () => {
    const s = strona({ vat: 'zw', zwolniona: true, nip: UE, wiersze: [W({ vat: '23' })] });
    podepnij(s.dokument);
    expect(s.formularz.dataset.wdt).not.toBe('1');
  });

  it('wiersz 23% wpisany jako netto 100 → brutto 123,00 (nie 100,00)', () => {
    const s = strona({ vat: 'zw', zwolniona: true, nip: UE, wiersze: [W({ vat: '23' })] });
    podepnij(s.dokument);
    expect(wpiszNetto(s, 0, '100')).toBe('123.00');
  });

  it('podgląd: dostawa „zw”, bez pasa „0% — WDT”, VAT od 23% liczony', () => {
    const s = strona({ vat: 'zw', zwolniona: true, nip: UE, dostawa: '10.00', wiersze: [W({ vat: '23', cena_brutto: '123.00' })] });
    const przeliczPodglad = podepnij(s.dokument);
    przeliczPodglad();
    expect(s.wyjscia['[data-dostawa-stawka]'].textContent).toBe('zw');
    expect(s.wyjscia['[data-pv-wdt]'].hidden).toBe(true);
    expect(s.wyjscia['[data-pv-vat]'].textContent).toBe('23.00');
    expect(s.wyjscia['[data-pv-brutto]'].textContent).toBe('133.00');
    expect(s.wyjscia['[data-razem]'].textContent).toBe('133.00 zł');
  });

  it('„Razem” (`kwotaFormularzaGrosze`): wiersz 23% z samym netto 100 → 123,00, nie 100,00 (recenzja B07g)', () => {
    expect(kwotaFormularzaGrosze([W({ vat: '23', cena_netto: '100' })], '', 'zw', UE, { zwolniona: true })).toBe(12300);
    expect(kwotaFormularzaGrosze([W({ vat: '23', cena_netto: '100' })], '', 'zw', UE)).toBe(10000);
  });
});

describe('PRZ-122.B07g kontrolnie: formularz bez `data-zwolniona` — WDT jak dotąd', () => {
  it('DE123456789 → `data-wdt="1"`, netto 100 przy 23% → brutto 100,00, pas „0% — WDT” widoczny', () => {
    const s = strona({ vat: '23', zwolniona: false, nip: UE, wiersze: [W({ vat: '23' })] });
    podepnij(s.dokument);
    expect(s.formularz.dataset.wdt).toBe('1');
    expect(wpiszNetto(s, 0, '100')).toBe('100.00');
    podepnij(s.dokument);
    expect(s.wyjscia['[data-dostawa-stawka]'].textContent).toBe('0% — WDT');
    expect(s.wyjscia['[data-pv-wdt]'].hidden).toBe(false);
  });

  it('nabywca krajowy przy firmie zwolnionej — bez zmian: 23% → 123,00', () => {
    const s = strona({ vat: 'zw', zwolniona: true, nip: '1234563218', wiersze: [W({ vat: '23' })] });
    podepnij(s.dokument);
    expect(s.formularz.dataset.wdt).toBe('0');
    expect(wpiszNetto(s, 0, '100')).toBe('123.00');
  });
});
