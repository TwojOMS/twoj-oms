import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { domyslneStatusy, PALETA_STATUSOW, sprawdzStatusy, kluczNowegoStatusu } from '../../src/domena/statusy-konfiguracja.js';
import { klasaStatusu, modyfikatorStatusu } from '../../src/core/web/klasa-statusu.js';
import { adresKartyZamowienia, adresPowrotuDoWiersza } from '../../src/domena/adres-karty-zamowienia.js';
import { bezpiecznyPowrotNaListe } from '../../src/domena/filtry-listy.js';

it('odnośniki karty i powrotu zachowują własny filtr, a klucz spoza formatu jest odrzucany', () => {
  const powrot = '/?status=w_do_pakowania';
  expect(bezpiecznyPowrotNaListe(powrot, [])).toBe(powrot);
  expect(adresKartyZamowienia(7, { powrot }, [])).toContain('powrot=%2F%3Fstatus%3Dw_do_pakowania');
  expect(adresPowrotuDoWiersza(powrot, 7, [])).toBe(`${powrot}#zamowienie-7`);
  expect(bezpiecznyPowrotNaListe('/?status=w_%3Cscript%3E', [])).toBe('/');
  expect(bezpiecznyPowrotNaListe(powrot, [], {})).toBe('/');
});

it('pastylka i kropka używają koloru, także po zmianie systemowego statusu', () => {
  const konfiguracja = [{ klucz: 'w_pakowanie', kolor: 'fioletowy' }, { klucz: 'nowe', kolor: 'czerwony' }];
  expect(klasaStatusu('w_pakowanie', konfiguracja)).toBe('znacznik znacznik--zwrot');
  expect(klasaStatusu('nowe', konfiguracja)).toBe('znacznik znacznik--czerwony');
  expect(modyfikatorStatusu('nowe', konfiguracja)).toBe('znacznik--czerwony');
});
it('brak konfiguracji zachowuje klasy wszystkich sześciu statusów', () => {
  expect(domyslneStatusy().map(s => klasaStatusu(s.klucz))).toEqual(['znacznik znacznik--nowe', 'znacznik znacznik--indywidualne', 'znacznik znacznik--w-realizacji', 'znacznik znacznik--wyslane', 'znacznik znacznik--zwrot', 'znacznik znacznik--anulowane']);
});
it('waliduje nazwy, paletę, limit i niezmienność systemowych kluczy', () => {
  const w = (etykieta = 'Pakowanie', n = 0) => ({ klucz: `w_status_${n}`, etykieta, kolor: 'szary', jak: 'nowe' });
  for (const nazwa of ['', ' ', 'x'.repeat(41), 'NOWE']) expect(() => sprawdzStatusy([...domyslneStatusy(), w(nazwa)])).toThrow();
  expect(() => sprawdzStatusy([...domyslneStatusy(), { ...w(), kolor: '#ffffff' }])).toThrow();
  expect(() => sprawdzStatusy(domyslneStatusy().slice(1))).toThrow();
  expect(() => sprawdzStatusy([...domyslneStatusy(), ...Array.from({ length: 21 }, (_, n) => w(`Etap ${n}`, n))])).toThrow();
  expect(sprawdzStatusy([...domyslneStatusy(), ...Array.from({ length: 20 }, (_, n) => w(`Etap ${n}`, n))])).toHaveLength(26);
  expect(kluczNowegoStatusu('Łódź — Żółć', [])).toBe('w_lodz_zolc');
  expect(kluczNowegoStatusu('Łódź — Żółć', [{ klucz: 'w_lodz_zolc' }])).toBe('w_lodz_zolc_2');
});

const css = readFileSync(new URL('../../src/core/web/widoki/layout-oms.ejs', import.meta.url), 'utf8');
const luminancja = hex => {
  const rgb = hex.match(/[a-f0-9]{2}/gi).map(v => parseInt(v, 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
};
it.each(['jasny', 'ciemny'])('wszystkie kolory palety mają kontrast tekstu co najmniej 4,5:1 — %s', motyw => {
  const blok = css.match(motyw === 'jasny' ? /:root\s*\{([\s\S]*?)\}/ : /html\[data-motyw="ciemny"\]\s*\{([\s\S]*?)\}/)[1];
  const zmienne = Object.fromEntries([...blok.matchAll(/(--[\w-]+):\s*(#[a-f0-9]{6})/gi)].map(m => [m[1], m[2]]));
  const pary = {
    nowe: ['st-nowe', 'st-nowe'], indywidualne: ['st-indyw', 'st-indyw'],
    'w-realizacji': ['uwaga', 'uwaga'], wyslane: ['ok', 'ok'], zwrot: ['st-zwrot', 'st-zwrot'],
  };
  for (const p of Object.values(PALETA_STATUSOW)) {
    const [tlo, tekst] = pary[p.klasa] ?? [`st-${p.klasa}`, `st-${p.klasa}`];
    const a = zmienne[`--${tlo}-tlo`];
    const b = p.klasa === 'anulowane' ? zmienne['--tekst-przygaszony'] : zmienne[`--${tekst}-tekst`];
    expect(a, `${p.etykieta} — tło`).toBeTruthy();
    expect(b, `${p.etykieta} — tekst`).toBeTruthy();
    const l = [luminancja(a), luminancja(b)].sort((a,b) => b-a);
    expect((l[0] + 0.05) / (l[1] + 0.05), p.etykieta).toBeGreaterThanOrEqual(4.5);
  }
});
