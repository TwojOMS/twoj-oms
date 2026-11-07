// PRZ-135.07b (D5, D6): kurier z `konfigurator.kroki` dostaje wspólny widok kroków pod swoją ścieżką, a mapowanie
// Woo dopuszcza pobranie przy metodach kurierów na własnej umowie z `pobranie !== 'brak'` (z rejestru, nie z listy).
import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import fastifyView from '@fastify/view';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { OpisKuriera } from '../../../src/core/kontrakty.ts';
import { MODULY_KURIEROW } from '../../../src/domena/moduly-kurierow.ts';
import { katalogiWidokow } from '../../../src/core/web/widoki.js';
import { registerKrokiKurierowRoutes } from '../../../src/moduly/wysylka/modul.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { migracjaKanalowSprzedazy } from '../../../src/moduly/kanaly/migracje/0001-kanaly-sprzedazy.ts';
import { migracjaTypuKanaluISklepow } from '../../../src/moduly/kanaly/migracje/0003-kanaly-typ-sklepy.ts';
import { createRepozytoriumKanalow } from '../../../src/moduly/kanaly/repozytorium-kanalow.ts';
import { createSklepyWoo } from '../../../src/moduly/kanaly/services/sklepy-woo.ts';

const ejs = createRequire(import.meta.url)('ejs');

const SCIEZKA = '/ustawienia/integracje/polcien-ekspres';
const POLCIEN: OpisKuriera = {
  klucz: 'polcien_ekspres', nazwa: 'Półcień Ekspres', logo: '/integracje/polcien.svg', idKatalogu: 'polcien_ekspres',
  opisKatalogu: 'Nadaj przesyłki przez Półcień Ekspres.', umowa: 'wlasna', przewoznicy: ['dpd'],
  metody: [{ klucz: 'polcien_kurier', etykieta: 'Półcień Ekspres', formularz: 'dpd', punktOdbioru: false }],
  umiejetnosci: { pobranie: 'brak', nadanieAsynchroniczne: false, sledzenie: 'wlasne', etykieta: { zpl: false, zplPrzyNadaniu: false } },
  pobieranieEtykiety: false, kluczeEnv: [],
  konfigurator: { sciezka: SCIEZKA, etykieta: 'Półcień Ekspres', zdanie: 'login i hasło API, adres nadania.', kroki: [
    { id: 'konto', numer: 1, tytul: 'Konto w Półcień Ekspres', instrukcja: ['Zaloguj się w panelu Półcień Ekspres.'],
      formularz: { akcja: ':kanal/konto', przycisk: 'Zapisz konto', pola: [
        { id: 'login', etykieta: 'Login', rodzaj: 'tekst', wymagane: true },
        { id: 'haslo', etykieta: 'Hasło API', rodzaj: 'sekret', wymagane: true },
      ] } },
    { id: 'nadanie', numer: 2, tytul: 'Miejsce nadania',
      formularz: { akcja: ':kanal/nadanie', przycisk: 'Zapisz miejsce', pola: [
        { id: 'punkt', etykieta: 'Punkt nadania', rodzaj: 'tekst', wymagane: false },
      ] } },
  ] },
  piaskownica: { atrapa: 'deploy/proba/atrapy/polcien.mjs', komunikat: 'Piaskownica: nic nie poszło do Półcień Ekspres.' },
};

async function aplikacja(rejestr?: Record<string, OpisKuriera>) {
  const app = Fastify();
  await app.register(fastifyView, { engine: { ejs }, root: fileURLToPath(new URL('../../../src/', import.meta.url)),
    options: { views: katalogiWidokow() } });
  registerKrokiKurierowRoutes(app, rejestr);
  await app.ready();
  return app;
}

describe('wspólny konfigurator kroków kuriera', () => {
  it('zmyślony kurier z dwoma krokami dostaje widok kroków pod swoją ścieżką', async () => {
    const app = await aplikacja({ polcien_ekspres: POLCIEN });
    const odp = await app.inject({ method: 'GET', url: SCIEZKA });
    expect(odp.statusCode).toBe(200);
    const html = odp.body;
    expect(html).toContain('<h2 class="naglowek-formularza">Półcień Ekspres</h2>');
    expect(html).toContain('class="stepper"');
    expect(html).toMatch(/<strong>1\. Konto w Półcień Ekspres<\/strong>/);
    expect(html).toContain('2. Miejsce nadania');
    expect(html).toContain('aria-current="step"');
    expect(html).toContain(`action="${SCIEZKA}/polcien_ekspres/konto"`);
    expect(html).toContain('Zaloguj się w panelu Półcień Ekspres.');
    expect(html).toMatch(/<input[^>]*name="haslo" type="password" autocomplete="off"/);
    expect(html).toContain('Zapisz konto');
    expect(html).not.toContain('Zapisz miejsce');
    await app.close();
  });

  it('kurierzy z rejestru produkcyjnego nie mają kroków — trasa nie powstaje (DPD i InPost mają własne formularze)', async () => {
    expect(Object.values(MODULY_KURIEROW).filter(o => (o.konfigurator as OpisKuriera['konfigurator']).kroki?.length)).toEqual([]);
    const app = await aplikacja();
    expect(app.hasRoute({ method: 'GET', url: MODULY_KURIEROW.dpd.konfigurator.sciezka })).toBe(false);
    expect(app.hasRoute({ method: 'GET', url: MODULY_KURIEROW.inpost.konfigurator.sciezka })).toBe(false);
    expect((await app.inject({ method: 'GET', url: SCIEZKA })).statusCode).toBe(404);
    await app.close();
  });
});

describe('pobranie w mapowaniu Woo z rejestru kurierów', () => {
  const bazy: ReturnType<typeof openOmsDb>[] = [];
  afterEach(() => { for (const db of bazy.splice(0)) db.close(); });
  const aktor = { id: 1, login: 'admin' };
  function szkic() {
    const db = openOmsDb(); bazy.push(db);
    migracjaKanalowSprzedazy.wykonaj(db); migracjaTypuKanaluISklepow.wykonaj(db);
    const teraz = () => new Date('2026-11-01T12:00:00Z');
    const repozytorium = createRepozytoriumKanalow({ db, definicjeEnv: [], konfiguracjaEnv: {}, teraz });
    const serwis = createSklepyWoo({ db, repozytorium, envSklepy: [], teraz, tryb: 'produkcja',
      klient: () => ({ sprawdzPolaczenie: async () => ({ ok: true }), pobierzMetodyWysylki: async () => [], pobierzBramkiPlatnosci: async () => [] }) });
    const w = serwis.utworzSzkic({ nazwa: 'Pracownia Półcień', adres: 'https://sklep-polcien.test', ck: 'ck_polcien', cs: 'cs_polcien', od: '2026-10-31' }, aktor) as any;
    expect(w.ok).toBe(true);
    return { serwis, klucz: w.dane.klucz as string, wersja: w.dane.wersja as number };
  }
  const TEKST = 'Pobranie można zaznaczyć tylko przy kurierze DPD albo paczkomacie InPost.';

  it('pobranie przy paczkomacie InPost (pobranie: adapter) i przy DPD (umowa) wolno zapisać', () => {
    const { serwis, klucz, wersja } = szkic();
    const w = serwis.zapiszMapowanie(klucz, { instancje: { '1': { metoda: 'dpd', pobranie: true }, '2': { metoda: 'inpost_paczkomat', pobranie: true } },
      bramkiPobrania: ['cod'] }, wersja, aktor);
    expect(w).toMatchObject({ ok: true });
  });

  it('pobranie przy metodzie WzA (umowa platformy) i przy metodzie bez kuriera — ta sama odmowa, ten sam tekst', () => {
    const { serwis, klucz, wersja } = szkic();
    for (const metoda of ['allegro_dpd', 'allegro_paczkomat', 'nieznana']) {
      expect(serwis.zapiszMapowanie(klucz, { instancje: { '1': { metoda, pobranie: true } }, bramkiPobrania: ['cod'] }, wersja, aktor))
        .toMatchObject({ ok: false, kod: 'walidacja', komunikat: TEKST });
    }
  });
});
