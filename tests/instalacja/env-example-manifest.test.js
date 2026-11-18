import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const czytaj = (plik) => fs.readFileSync(new URL(`../../${plik}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const manifest = JSON.parse(czytaj('docs/konfiguracja.json'));
const env = czytaj('.env.example');

// Zmienne produktu celowo poza .env.example; każda z jednym słowem powodu.
const WYJATKI = {
  OMS_DEMO_LOGIN: 'demo',
  OMS_DEMO_HASLO: 'demo',
  DEMO_RESET_CO_MIN: 'demo',
  DEMO_RESET_PLANOWY: 'demo',
  OMS_PROBA_KSEF_TEST_API: 'piaskownica',
  OMS_PROBA_KSEF_TEST_TOKEN: 'piaskownica',
  OMS_PROBA_ALLEGRO_SANDBOX: 'piaskownica',
  OMS_HISTORIA_KLASYFIKACJA: 'historia',
  OMS_TWOJEFAKTURY: 'moduł-poza-kopią',
};

const wystepuje = (nazwa) => new RegExp(`^#? ?${nazwa}=`, 'm').test(env);

describe('.env.example a manifest konfiguracji', () => {
  it('zawiera każdą niedynamiczną zmienną produktu z manifestu albo jawny wyjątek', () => {
    const produktowe = manifest.zmienne
      .filter((z) => z.zakres === 'produkt' && /^[A-Z][A-Za-z0-9_]*$/.test(z.nazwa))
      .map((z) => z.nazwa);
    expect(produktowe.length).toBeGreaterThan(90);
    const brakujace = produktowe.filter((nazwa) => !(nazwa in WYJATKI) && !wystepuje(nazwa));
    expect(brakujace).toEqual([]);
  });

  it('lista wyjątków nie gnije: nie stoją w .env.example i są w manifeście', () => {
    const nazwyManifestu = new Set(manifest.zmienne.map((z) => z.nazwa));
    for (const nazwa of Object.keys(WYJATKI)) {
      expect(wystepuje(nazwa), `${nazwa} jest w .env.example`).toBe(false);
      expect(nazwyManifestu.has(nazwa), `${nazwa} nie ma w manifeście`).toBe(true);
    }
  });

  it('nie zawiera śladów roboczych (KANDYDAT, numerów zadań)', () => {
    expect(env).not.toMatch(/KANDYDAT/);
    expect(env).not.toMatch(/PRZ-\d/);
  });
});
