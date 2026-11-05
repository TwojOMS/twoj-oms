import { it, expect } from 'vitest';
import { planZapisuPozycji } from '../../src/domena/usuniecie-pozycji.js';
import { nalozNadpisaniaPozycji, parsujHurtPozycji, parsujNowaPozycje, parsujEdycjePozycji, roznicePozycji, ustawWMapie } from '../../src/domena/pozycje-reczne.js';
import { odczytajNadpisania } from '../../src/domena/dane-reczne.js';
import { wysylkaZeSklepu, parsujEdycjeWysylki, rozniceWysylki } from '../../src/domena/wysylka-kwota.js';
import { nettoWiersza } from '../../src/domena/tabela-pozycji.js';

const z = { koszt_dostawy_brutto: '10.00', pozycje: nalozNadpisaniaPozycji([
  { zrodlo_id: 2, nazwa: 'Towar', ilosc: 1, cena_brutto: '123.00', cena_netto: '100.00' },
  { id: 7, zrodlo: 'reczna', nazwa: 'Usługa', sku: 'US-X', ilosc: 1, cena_brutto: '50.00', vat: '8' },
], null) };
const body = (wiersze) => Object.fromEntries(['klucz', 'nazwa', 'ilosc', 'cena_brutto', 'sku', 'cena_netto', 'vat']
  .map((k) => [k, wiersze.map((w) => w[k] ?? '')]));
const nowy = { klucz: '', nazwa: 'Nowy', ilosc: '2', cena_netto: '100', sku: 'NOW-X' };
it('pomija pusty nowy wiersz z ilością i domyślnym VAT', () => {
  expect(planZapisuPozycji(z, body([{ ilosc: '1', vat: '23' }])).nowe).toEqual([]);
});
it('nowy z netto ma cenę, sumę linii i SKU', () => {
  expect(planZapisuPozycji(z, body([nowy])).nowe).toEqual([
    { nazwa: 'Nowy', sku: 'NOW-X', ilosc: 2, cena_brutto: '123.00', brutto_linii: '246.00', vat: '23' },
  ]);
});
it('usuwa istniejące i pomija wskazany nowy przed walidacją', () => {
  const formularz = body([
    { klucz: 's2', nazwa: 'Towar', sku: '', ilosc: '1', cena_brutto: '123.00', cena_netto: '100.00', vat: '' },
    { klucz: 'r7', nazwa: 'Usługa', sku: '', ilosc: '1', cena_brutto: '50.00', cena_netto: '46.30', vat: '8' },
  ]);
  const bezSklepowej = planZapisuPozycji(z, { ...formularz, usun: 's2' });
  expect(bezSklepowej.mapa).toEqual({ s2: { usunieta: true } });
  expect(bezSklepowej.reczneZmiany.map((p) => p.id)).toEqual([7]);
  const bezRecznej = planZapisuPozycji(z, { ...formularz, usun: 'r7' });
  expect(bezRecznej.mapa).toEqual({});
  expect(bezRecznej.reczneUsuniete).toEqual([7]);
  expect(bezRecznej.reczneZmiany).toEqual([]);
  expect(planZapisuPozycji(z, { ...body([{ nazwa: 'Niedokończony' }, nowy]), usun_nowy: '0' }).nowe).toHaveLength(1);
  expect(() => planZapisuPozycji(z, { ...body([nowy]), usun: 'wysylka' })).toThrow(/wysyłki/);
});
it('formularz wysłany bez zmian nie zmienia mapy', () => {
  const mapa = { s2: { cena_brutto: '1.04' } };
  const json = JSON.stringify(mapa);
  const zam = { pozycje_reczne_json: json, pozycje: nalozNadpisaniaPozycji([
    { zrodlo_id: 2, nazwa: 'Towar', ilosc: 1, cena_brutto: '2.00', cena_netto: null },
    { id: 7, zrodlo: 'reczna', nazwa: 'Usługa', sku: 'US-X', ilosc: 1, cena_brutto: '1.01', vat: '8' },
  ], json) };
  const [sklepowa, reczna] = zam.pozycje;
  expect(nettoWiersza(sklepowa, '23')).toBe('0.85');
  expect(nettoWiersza(reczna, '8')).toBe('0.94');
  const formularz = body([
    { klucz: 's2', nazwa: sklepowa.nazwa, sku: '', ilosc: '1', cena_brutto: sklepowa.cena_brutto,
      cena_netto: nettoWiersza(sklepowa, '23'), vat: '' },
    { klucz: 'r7', nazwa: reczna.nazwa, sku: '', ilosc: '1', cena_brutto: reczna.cena_brutto,
      cena_netto: nettoWiersza(reczna, '8'), vat: '8' },
  ]);
  const wynik = planZapisuPozycji(zam, formularz);
  expect(wynik.mapa).toEqual(mapa);
  expect(wynik.reczneZmiany).toEqual([{ id: 7, pozycja: {
    nazwa: 'Usługa', sku: 'US-X', ilosc: 1, cena_brutto: '1.01', brutto_linii: '1.01', vat: '8',
  } }]);
});
it('netto bez JS liczy stawką wiersza, WDT i zw', () => {
  const w = { klucz: 's2', nazwa: 'Towar', ilosc: '1', cena_brutto: '123', cena_netto: '200' };
  expect(planZapisuPozycji(z, body([w]), { stawkaDomyslna: '8' }).mapa.s2.cena_brutto).toBe('216.00');
  expect(planZapisuPozycji(z, body([w]), { wdt: true }).mapa.s2.cena_brutto).toBe('200.00');
  expect(planZapisuPozycji(z, body([w]), { stawkaDomyslna: 'zw', zw: true }).mapa.s2.cena_brutto).toBe('200.00');
  expect(nettoWiersza(z.pozycje[0], '23')).toBe('100.00');
  expect(nettoWiersza(z.pozycje[1], '8')).toBe('46.30');
});
it('stary formularz daje ten sam wynik co dzisiejsza pętla s/r/wysyłka/obcy', () => {
  const stare = { klucz: ['s2', 'r7', 'wysylka', 's999'], nazwa: ['Zmieniony', 'Usługa', '', ''],
    ilosc: ['2', '3', '1', ''], cena_brutto: ['120', '60', '12', ''] };
  let mapa = odczytajNadpisania(z.pozycje_reczne_json);
  const reczneZmiany = [], zmienione = [];
  for (const w of parsujHurtPozycji(stare)) {
    if (w.klucz === 'wysylka') {
      const sklep = wysylkaZeSklepu(z);
      const n = rozniceWysylki(sklep, parsujEdycjeWysylki(w, sklep));
      mapa = ustawWMapie(mapa, 'wysylka', n);
      if (Object.keys(n).length) zmienione.push('Wysyłka');
      continue;
    }
    const p = z.pozycje.find((x) => x.klucz === w.klucz);
    if (!p) continue;
    if (p.reczna) {
      const { vat, ...pozycja } = parsujNowaPozycje({ ...w, sku: p.sku });
      reczneZmiany.push({ id: p.id, pozycja });
      zmienione.push(p.nazwa);
      continue;
    }
    const n = roznicePozycji(p.sklep, parsujEdycjePozycji(w, p.sklep));
    mapa = ustawWMapie(mapa, p.klucz, n);
    if (Object.keys(n).length) zmienione.push(p.sklep.nazwa);
  }
  const przed = JSON.stringify(z);
  expect(planZapisuPozycji(z, stare)).toEqual({ nowe: [], reczneZmiany, reczneUsuniete: [], mapa, zmienione, usunieteNazwy: [] });
  expect(JSON.stringify(z)).toBe(przed);
});
it('odmawia zapisanej zw bez obsługi programu, zachowuje stary VAT i SKU', () => {
  const w = body([{ klucz: 'r7', nazwa: 'Usługa', ilosc: '1', cena_brutto: '50', sku: 'OBCE' }]);
  expect(planZapisuPozycji(z, w).reczneZmiany[0].pozycja).toMatchObject({ sku: 'US-X' });
  expect(planZapisuPozycji(z, w).reczneZmiany[0].pozycja).not.toHaveProperty('vat');
  expect(() => planZapisuPozycji({ ...z, pozycje: [{ ...z.pozycje[1], vat: 'zw' }] }, w)).toThrow(/program/);
});
it('zmiana netto ręcznej bez zmiany VAT używa jej stawki 8%, a wybór 5% używa nowej', () => {
  const w = { klucz: 'r7', nazwa: 'Usługa', ilosc: '2', cena_brutto: '50', cena_netto: '100' };
  expect(planZapisuPozycji(z, body([w])).reczneZmiany[0].pozycja)
    .toMatchObject({ cena_brutto: '108.00', brutto_linii: '216.00' });
  expect(planZapisuPozycji(z, body([{ ...w, vat: '5' }])).reczneZmiany[0].pozycja)
    .toMatchObject({ cena_brutto: '105.00', vat: '5' });
});
it('stary formularz zachowuje darmowy towar i wysyłkę oraz istniejącą mapę', () => {
  const zam = { koszt_dostawy_brutto: '0.00', pozycje_reczne_json: '{"s9":{"usunieta":true}}',
    pozycje: nalozNadpisaniaPozycji([{ zrodlo_id: 2, nazwa: 'Gratis', ilosc: 1, cena_brutto: '0.00' }]) };
  const stare = { klucz: ['s2', 'wysylka'], nazwa: ['Gratis', ''], ilosc: ['1', '1'], cena_brutto: ['0', '0'] };
  expect(planZapisuPozycji(zam, stare).mapa).toEqual({ s9: { usunieta: true } });
});
