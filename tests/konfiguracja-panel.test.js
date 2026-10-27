import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { ZMIENNE_PANEL } from '../scripts/zmienne-panel.mjs';
import { generujTabele } from '../scripts/zmienne-tabela.mjs';

const czytaj = plik => fs.readFileSync(new URL(`../${plik}`, import.meta.url), 'utf8');
const manifest = JSON.parse(czytaj('docs/konfiguracja.json'));
// Świadectwa zapisu: trasa POST i pliki wiążące pola formularza z konfiguracją.
// Część tras używa nazw env dopiero w importowanym źródle konfiguracji.
const ekrany = {
  'Integracje → inFakt': ['src/moduly/faktury/trasy/ustawienia-infakt.js', 'src/domena/konfiguracja-infakt.js'],
  'Integracje → Moduł faktur': ['src/moduly/faktury/trasy/ustawienia-programu.js', 'src/domena/wybor-programu.js'],
  'Integracje → GUS': ['src/moduly/zamowienia/ustawienia-gus.js', 'src/domena/konfiguracja-gus.js'],
  'Integracje → KSeF': ['src/moduly/koszty/trasy/ustawienia-ksef.js', 'src/domena/konfiguracja-ksef-kosztow.js'],
  'Integracje → Kurierzy → DPD': ['src/moduly/wysylka/trasy/ustawienia-dpd.js', 'src/moduly/wysylka/kurierzy.ts'],
  'Integracje → Kurierzy → InPost': ['src/moduly/wysylka/trasy/ustawienia-inpost.js', 'src/domena/konfiguracja-inpost.js'],
  Firma: ['src/moduly/faktury/trasy/ustawienia-firma.js', 'src/core/adres-firmy.ts'],
  'Firma → Logo': ['src/moduly/ustawienia/trasy/logo.js', 'src/core/web/modul.ts'],
  'Integracje → Poczta wychodząca': ['src/moduly/ustawienia/trasy/poczta.js', 'src/moduly/wiadomosci/konfiguracja.ts'],
  'Integracje → Poczta wychodząca → Adres panelu': ['src/moduly/ustawienia/trasy/poczta.js'],
  'Integracje → Poczta wychodząca → Podpis maili': ['src/moduly/ustawienia/trasy/poczta.js'],
  'Analizy i finanse → Finanse → Kompletność danych': ['src/moduly/raporty/trasy/pokrycie.js', 'src/moduly/raporty/pokrycie.js'],
};

describe('odpowiedniki zmiennych w panelu', () => {
  it.each(Object.entries(ZMIENNE_PANEL))('%s ma istniejący ekran i trasę zapisu z nazwą klucza', (nazwa, ekran) => {
    const pliki = ekrany[ekran.replace(/ \(.*\)$/, '')];
    expect(pliki, `brak dowodu zapisu dla ${nazwa}: ${ekran}`).toBeDefined();
    expect(czytaj(pliki[0])).toMatch(/\b(?:app|scoped)\.post\(/);
    expect(pliki.map(czytaj).join('\n')).toMatch(new RegExp(`\\b${nazwa}\\b`));
  });

  it.each([
    ['OMS_RAPORTY_PODLOGA_KOSZTOW', 'Analizy i finanse → Finanse → Kompletność danych'],
    ['OMS_RAPORTY_PODLOGA_ZWROTOW', 'Analizy i finanse → Finanse → Kompletność danych'],
    ['OMS_STATYSTYKI_PIERWSZY_DZIEN', 'Analizy i finanse → Finanse → Kompletność danych'],
    ['OMS_LOGO_PLIK', 'Ustawienia → Firma → Logo'],
    ['OMS_LOGO_ALT', 'Ustawienia → Firma → Logo', 'tylko administrator; plik wygrywa, gdy ustawia też OMS_LOGO_PLIK; bez restartu'],
  ])('%s wskazuje prawdziwą ścieżkę menu i ograniczenia zapisu', (nazwa, ekran, uwagi = 'tylko administrator; plik wygrywa; bez restartu') => {
    const wiersz = generujTabele(manifest).split('\n').find(w => w.startsWith(`| <code>${nazwa}</code> |`));
    expect(wiersz).toContain(`| Tak — ${ekran} (${uwagi}) |`);
  });

  it.each(['META_TOKEN', 'META_KONTA', 'GA4_KLUCZ'])('%s pozostaje plikową konfiguracją kart kampanii', nazwa => {
    expect(ZMIENNE_PANEL).not.toHaveProperty(nazwa);
    expect(czytaj('src/moduly/marketing/konfiguracja.ts')).toContain(nazwa);
    expect(czytaj('src/moduly/marketing/widoki/kampania.ejs')).toContain(nazwa);
    const wiersz = generujTabele(manifest).split('\n').find(w => w.startsWith(`| <code>${nazwa}</code> |`));
    expect(wiersz).toMatch(/\| Nie \|$/);
  });
});
