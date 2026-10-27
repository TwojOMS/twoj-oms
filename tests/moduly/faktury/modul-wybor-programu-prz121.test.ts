// PRZ-121.01 — moduł faktur składa program według wyboru modułu faktur (OMS_PROGRAM_FAKTUROWY → zapis
// „program_fakturowy” → inFakt, gdy gotowy → „brak”). Przy jawnym „brak” nie powstaje klient inFaktu ani program
// z żadnego źródła (plik, Ustawienia, atrapa piaskownicy, szew programu); bez wyboru — jak przed zmianą.
// Zero sieci: globalny fetch podmieniony; klucze i NIP-y zmyślone („Pracownia Półcień”).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { createModulFaktury, wczytajFaktury } from '../../../src/moduly/faktury/modul.ts';
import { zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { zapiszWyborProgramu } from '../../../src/oms/db/wybor-programu.js';
import { METODY_OBOWIAZKOWE } from '../../../src/integracje/program-fakturowy.ts';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';

const KATALOG = mkdtempSync(join(tmpdir(), 'prz-121-01-'));
const ENV = { OMS_PROFORMY_KATALOG: KATALOG, OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000' };
const PROBA = { ...ENV, OMS_TRYB: 'proba' };
const KLUCZ_PLIKU = 'zmyslony-klucz-pliku-prz121-0000000000001';
const KLUCZ_EKRANU = 'zmyslony-klucz-ekranu-prz121-000000000001';
const STARE_ZDANIE = 'Fakturowanie inFakt nie jest skonfigurowane.';
const ZDANIE_USTAWIEN = 'Faktury w OMS-ie są wyłączone — w Ustawienia → Integracje → Moduł faktur wybrano „Brak”.';
const ZDANIE_PLIKU = 'Faktury w OMS-ie są wyłączone — w pliku konfiguracji jest OMS_PROGRAM_FAKTUROWY=brak.';
// Usługi, które bez programu fakturowego są `null` (jak dziś bez inFaktu).
const ZALEZNE = ['infakt', 'programFakturowy', 'vies', 'faktura', 'fakturaHurtem', 'fakturyWidok', 'wysylkaKsef', 'automatKsef',
  'fakturaAllegro', 'doczytanieKsef', 'czuwaczKsef', 'czuwaczArchiwumSprzedazy', 'paczkaDlaBiura'];

type Uslugi = Record<string, any>;
type Zbudowany = { uslugi: Uslugi; zegary: { nazwa: string }[]; zdrowie: () => { alarmy: string[]; uwagi: string[] } };
function zbuduj(modul: ReturnType<typeof createModulFaktury>, env: Record<string, string>,
  { klucz, wybor }: { klucz?: string; wybor?: string } = {}) {
  const db = openOmsDb();
  if (klucz) zapiszKonfiguracjeIntegracji(db, 'infakt', { ustawienia: {}, sekrety: { apiKey: klucz } });
  if (wybor) zapiszKonfiguracjeIntegracji(db, 'program_fakturowy', { ustawienia: { program: wybor }, sekrety: {} });
  // Kanał (zmyślony) — żeby czuwacz KSeF i faktura Allegro miały z czego powstać, gdy jest program.
  const obce: Record<string, unknown> = { 'kanaly.klienciKanalow': { lampy: {} }, 'kanaly.config': { definicje: [], sklepy: {} } };
  const usluga = <T>(m: string, n: string) => {
    const k = `${m}.${n}`; if (!Object.hasOwn(obce, k)) throw new Error(k); return obce[k] as T;
  };
  const sprobuj = () => modul.zbuduj({ db, konfiguracja: modul.konfiguracja(env), teraz: () => new Date('2026-10-27T10:00:00Z'),
    log: () => {}, usluga } as any) as unknown as Zbudowany;
  return { db, sprobuj };
}

function programTestowy() {
  const metody = Object.fromEntries(METODY_OBOWIAZKOWE.map((m) => [m, async () => null]));
  return { ...metody, opis: {
    id: 'rachmistrz', nazwa: { mianownik: 'Rachmistrz', dopelniacz: 'Rachmistrza', miejscownik: 'Rachmistrzu', narzednik: 'Rachmistrzem' },
    regulaVat: 'wierszami', zdolnosci: [], wystawienieWysylaDoKsef: false,
    limity: { zadanieMs: 30000, najdluzszaListaMs: 120000, stronaListy: 25, sufitStron: 40, rownolegleStron: 4 },
    adres: 'https://rachmistrz.invalid', ekran: '/ustawienia/integracje/rachmistrz' } };
}

let siec: ReturnType<typeof vi.fn>;
function bezSieci() {
  siec = vi.fn(async () => new Response(JSON.stringify({ metainfo: { count: 0, total_count: 0 }, entities: [] }),
    { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', siec);
}
afterEach(() => { vi.unstubAllGlobals(); });

function bezProgramu(z: Zbudowany) {
  for (const n of ZALEZNE) expect(z.uslugi[n], n).toBeNull();
  expect(z.zegary.map((x) => x.nazwa)).toEqual([]);
  expect(z.uslugi.celeLacznosci()).toEqual({ infakt: null });
  // Proforma zostaje (to nie faktura sprzedaży z programu).
  expect(z.uslugi.proforma).not.toBeNull();
}

describe('PRZ-121.01 moduł faktur według wyboru modułu', () => {
  it('(1) INFAKT_API_KEY, nic nie wybrano → inFakt, źródło „domyslny”; czuwacze i automat KSeF jak dziś', () => {
    const { db, sprobuj } = zbuduj(createModulFaktury(), { ...ENV, INFAKT_API_KEY: KLUCZ_PLIKU });
    const z = sprobuj();
    expect(z.uslugi.programFakturowy.opis.id).toBe('infakt');
    expect(z.uslugi.wyborProgramu).toMatchObject({ program: 'infakt', zrodlo: 'domyslny', uwaga: null });
    expect(z.uslugi.wyborProgramu.czekaNaRestart()).toBe(false);
    expect(z.uslugi.konfiguracjaInfaktu.wyborProgramu).toBe(z.uslugi.wyborProgramu);
    expect(z.zegary.map((x) => x.nazwa)).toEqual(['czuwaczKsef', 'automatKsef']);
    expect(z.uslugi.celeLacznosci().infakt).not.toBeNull();
    db.close();
  });

  it('(2) to samo + OMS_PROGRAM_FAKTUROWY=brak → żadnej usługi z programu, zero zegarów faktur, zero sieci', async () => {
    bezSieci();
    const { db, sprobuj } = zbuduj(createModulFaktury(), { ...ENV, INFAKT_API_KEY: KLUCZ_PLIKU, OMS_PROGRAM_FAKTUROWY: 'brak' });
    const z = sprobuj();
    bezProgramu(z);
    expect(z.uslugi.wyborProgramu).toMatchObject({ program: 'brak', zrodlo: 'plik', uwaga: null });
    await expect(z.uslugi.konfiguracjaInfaktu.sprawdzPolaczenie()).rejects.toThrow(ZDANIE_PLIKU);
    expect(siec).not.toHaveBeenCalled();
    db.close();
  });

  it('(3) klucz z Ustawień + wiersz „brak” → to samo; wymagaRestartu() fałsz; klucz nie wychodzi', async () => {
    bezSieci();
    const { db, sprobuj } = zbuduj(createModulFaktury(), ENV, { klucz: KLUCZ_EKRANU, wybor: 'brak' });
    const z = sprobuj();
    bezProgramu(z);
    expect(z.uslugi.wyborProgramu).toMatchObject({ program: 'brak', zrodlo: 'ustawienia' });
    expect(z.uslugi.konfiguracjaInfaktu.wymagaRestartu()).toBe(false);
    await expect(z.uslugi.konfiguracjaInfaktu.sprawdzPolaczenie()).rejects.toThrow(ZDANIE_USTAWIEN);
    expect(siec).not.toHaveBeenCalled();
    db.close();
  });

  it('(3b) nic nie wybrano, bez inFaktu, klucz wpisany po starcie → wymagaRestartu() jak dziś (prawda)', () => {
    const { db, sprobuj } = zbuduj(createModulFaktury(), ENV);
    const z = sprobuj();
    expect(z.uslugi.wyborProgramu).toMatchObject({ program: 'brak', zrodlo: 'domyslny' });
    expect(z.uslugi.konfiguracjaInfaktu.wymagaRestartu()).toBe(false);
    zapiszKonfiguracjeIntegracji(db, 'infakt', { ustawienia: {}, sekrety: { apiKey: KLUCZ_EKRANU } });
    expect(z.uslugi.konfiguracjaInfaktu.wymagaRestartu()).toBe(true);
    // Pierwszy klucz bez wyboru: Zdrowie jak dotąd (bez uwagi o restarcie — ten przypadek ma swój ekran).
    expect(z.zdrowie().uwagi).toEqual([STARE_ZDANIE]);
    zapiszWyborProgramu(db, 'brak');
    expect(z.uslugi.konfiguracjaInfaktu.wymagaRestartu()).toBe(false);
    db.close();
  });

  it('(3c) „brak” zapisany PO starcie, klucz wpisany po nim → sprawdzPolaczenie odmawia, fetch niewołany', async () => {
    bezSieci();
    const { db, sprobuj } = zbuduj(createModulFaktury(), ENV);
    const z = sprobuj();
    zapiszWyborProgramu(db, 'brak');
    zapiszKonfiguracjeIntegracji(db, 'infakt', { ustawienia: {}, sekrety: { apiKey: KLUCZ_EKRANU } });
    await expect(z.uslugi.konfiguracjaInfaktu.sprawdzPolaczenie()).rejects.toThrow(`${ZDANIE_USTAWIEN} Nic nie poszło do programu.`);
    expect(siec).not.toHaveBeenCalled();
    db.close();
  });

  it('(3d) inFakt z Ustawień działa od startu, potem zapis „brak” → sprawdzPolaczenie odmawia, fetch niewołany', async () => {
    bezSieci();
    const { db, sprobuj } = zbuduj(createModulFaktury(), ENV, { klucz: KLUCZ_EKRANU });
    const z = sprobuj();
    expect(z.uslugi.programFakturowy.opis.id).toBe('infakt');
    zapiszWyborProgramu(db, 'brak');
    await expect(z.uslugi.konfiguracjaInfaktu.sprawdzPolaczenie()).rejects.toThrow(ZDANIE_USTAWIEN);
    expect(siec).not.toHaveBeenCalled();
    db.close();
  });

  it('(3f) start z „brak” w Ustawieniach, potem zapis „infakt” i klucza → sprawdzPolaczenie mówi o restarcie, fetch niewołany', async () => {
    bezSieci();
    const { db, sprobuj } = zbuduj(createModulFaktury(), ENV, { wybor: 'brak' });
    const z = sprobuj();
    zapiszWyborProgramu(db, 'infakt');
    zapiszKonfiguracjeIntegracji(db, 'infakt', { ustawienia: {}, sekrety: { apiKey: KLUCZ_EKRANU } });
    await expect(z.uslugi.konfiguracjaInfaktu.sprawdzPolaczenie()).rejects.toThrow(
      'Zapisany moduł faktur „inFakt” zadziała po ponownym uruchomieniu OMS-u — do tego czasu faktury są wyłączone. Nic nie poszło do programu.');
    expect(siec).not.toHaveBeenCalled();
    db.close();
  });

  it('(3e) start bez inFaktu, zapis „infakt” bez klucza → Zdrowie mówi o brakującym kluczu, nie o restarcie; z kluczem — o restarcie', () => {
    const { db, sprobuj } = zbuduj(createModulFaktury(), ENV);
    const z = sprobuj();
    zapiszWyborProgramu(db, 'infakt');
    expect(z.zdrowie().uwagi).toEqual([STARE_ZDANIE,
      'Zapisany moduł faktur „inFakt” nie ma klucza API — wpisz go w Ustawienia → Integracje → inFakt (/ustawienia/integracje/infakt); faktury ruszą po ponownym uruchomieniu OMS-u.']);
    zapiszKonfiguracjeIntegracji(db, 'infakt', { ustawienia: {}, sekrety: { apiKey: KLUCZ_EKRANU } });
    expect(z.zdrowie().uwagi).toEqual([STARE_ZDANIE,
      'Zapisany moduł faktur „inFakt” zadziała po ponownym uruchomieniu OMS-u — do tego czasu faktury są wyłączone.']);
    db.close();
  });

  it('(4) plik „infakt” + wiersz „brak” → inFakt (plik wygrywa)', () => {
    const { db, sprobuj } = zbuduj(createModulFaktury(), { ...ENV, INFAKT_API_KEY: KLUCZ_PLIKU, OMS_PROGRAM_FAKTUROWY: ' InFakt ' },
      { wybor: 'brak' });
    const z = sprobuj();
    expect(z.uslugi.programFakturowy.opis.id).toBe('infakt');
    expect(z.uslugi.wyborProgramu).toMatchObject({ program: 'infakt', zrodlo: 'plik' });
    expect(z.uslugi.wyborProgramu.czekaNaRestart()).toBe(false);
    expect(z.uslugi.automatKsef).not.toBeNull();
    db.close();
  });

  it('(5) próba z atrapami + wiersz „brak” → fabryki atrap niewołane; bez wiersza — wołane', () => {
    const fabryki = () => ({ createInfaktClient: vi.fn(() => ({ atrapa: true, sprawdzPolaczenie: async () => ({}) })),
      createVies: vi.fn(() => ({ sprawdz: async () => ({ wynik: 'wazny' }) })) });
    const f = fabryki();
    const z = zbuduj(createModulFaktury({ fabryki: f }), PROBA, { wybor: 'brak' });
    bezProgramu(z.sprobuj());
    expect(f.createInfaktClient).not.toHaveBeenCalled();
    expect(f.createVies).not.toHaveBeenCalled();
    z.db.close();

    const g = fabryki();
    const kontrola = zbuduj(createModulFaktury({ fabryki: g }), PROBA);
    expect(kontrola.sprobuj().uslugi.infakt.atrapa).toBe(true);
    expect(g.createInfaktClient).toHaveBeenCalledTimes(1);
    kontrola.db.close();
  });

  it('(5b) szew programu (próba) + „brak” z pliku → fabryka programu niewołana', () => {
    const programFakturowy = vi.fn(() => programTestowy());
    const z = zbuduj(createModulFaktury({ fabryki: { programFakturowy } }), { ...PROBA, OMS_PROGRAM_FAKTUROWY: 'brak' });
    bezProgramu(z.sprobuj());
    expect(programFakturowy).not.toHaveBeenCalled();
    z.db.close();
  });

  it('(6) zła wartość w pliku → wczytajFaktury rzuca zdaniem z nazwą zmiennej', () => {
    for (const v of ['infkat', 'fakturownia', 'twojefaktury']) {
      expect(() => wczytajFaktury({ ...ENV, INFAKT_API_KEY: KLUCZ_PLIKU, OMS_PROGRAM_FAKTUROWY: v } as any), v)
        .toThrow(/^OMS_PROGRAM_FAKTUROWY: /);
    }
    expect(wczytajFaktury({ ...ENV, OMS_PROGRAM_FAKTUROWY: '' } as any)).toMatchObject({ programZPliku: null });
  });

  it('(6b) zły zapis („fakturownia” po wycofaniu wydania) → „brak” + uwaga, bez programu, panel wstaje', () => {
    const { db, sprobuj } = zbuduj(createModulFaktury(), { ...ENV, INFAKT_API_KEY: KLUCZ_PLIKU }, { wybor: 'fakturownia' });
    const z = sprobuj();
    bezProgramu(z);
    const uwaga = 'Zapisany moduł faktur „fakturownia” nie działa w tej wersji OMS-u — faktury są wyłączone. Wybierz moduł ponownie.';
    expect(z.uslugi.wyborProgramu).toMatchObject({ program: 'brak', zrodlo: 'ustawienia', uwaga });
    expect(z.zdrowie().uwagi).toEqual([uwaga]);
    db.close();
  });

  it('(7) inFakt działa, potem zapis „brak” → czeka na restart, automat KSeF staje od razu, faktura do restartu działa', async () => {
    bezSieci();
    const { db, sprobuj } = zbuduj(createModulFaktury(), { ...ENV, INFAKT_API_KEY: KLUCZ_PLIKU });
    const z = sprobuj();
    const w = z.uslugi.wyborProgramu;
    const przed = await z.uslugi.automatKsef.przebieg();
    expect(przed.powod).not.toMatch(/odłączony/);
    expect(w.czekaNaRestart()).toBe(false);

    zapiszWyborProgramu(db, 'brak', { konto: { id: 1, login: 'pracownia' } });
    expect(w.program).toBe('infakt');
    expect(w.teraz()).toMatchObject({ program: 'brak', zrodlo: 'ustawienia' });
    expect(w.czekaNaRestart()).toBe(true);
    expect(await z.uslugi.automatKsef.przebieg()).toMatchObject({ pominiety: true });
    expect((await z.uslugi.automatKsef.przebieg()).powod).toMatch(/odłączony/);
    // Ręczne wystawianie i lista do restartu działają (ekran to mówi).
    expect(z.uslugi.faktura).not.toBeNull();
    await z.uslugi.programFakturowy.listaFaktur({});
    expect(siec).toHaveBeenCalledTimes(1);
    expect(z.uslugi.celeLacznosci()).toEqual({ infakt: null });
    expect(z.zdrowie().uwagi).toContain('Zapisany moduł faktur „Brak” zadziała po ponownym uruchomieniu OMS-u — do tego czasu działa „inFakt”. Automatyczna wysyłka do KSeF już stoi.');

    zapiszWyborProgramu(db, 'infakt');
    expect(w.czekaNaRestart()).toBe(false);
    expect((await z.uslugi.automatKsef.przebieg()).powod ?? '').not.toMatch(/odłączony/);
    db.close();
  });

  it('(8) Zdrowie: jawny „brak” → nowe zdanie; bez wyboru i bez inFaktu → stare znak w znak; z inFaktem → nic', () => {
    const plik = zbuduj(createModulFaktury(), { ...ENV, OMS_PROGRAM_FAKTUROWY: 'brak' });
    expect(plik.sprobuj().zdrowie().uwagi).toEqual([ZDANIE_PLIKU]);
    plik.db.close();
    const ustawienia = zbuduj(createModulFaktury(), { ...ENV, INFAKT_API_KEY: KLUCZ_PLIKU }, { wybor: 'brak' });
    expect(ustawienia.sprobuj().zdrowie().uwagi).toEqual([ZDANIE_USTAWIEN]);
    ustawienia.db.close();
    const nic = zbuduj(createModulFaktury(), ENV);
    expect(nic.sprobuj().zdrowie().uwagi).toEqual([STARE_ZDANIE]);
    nic.db.close();
    // inFakt wybrany w Ustawieniach, ale bez klucza — stary tekst, nie „wyłączone”.
    const bezKlucza = zbuduj(createModulFaktury(), ENV, { wybor: 'infakt' });
    expect(bezKlucza.sprobuj().zdrowie().uwagi).toEqual([STARE_ZDANIE]);
    bezKlucza.db.close();
    const zInfaktem = zbuduj(createModulFaktury(), { ...ENV, INFAKT_API_KEY: KLUCZ_PLIKU });
    expect(zInfaktem.sprobuj().zdrowie().uwagi).toEqual([]);
    zInfaktem.db.close();
  });
});

describe('PRZ-121.01 /health przy „brak” — jak bez wyboru', () => {
  const ENV_OMS = { OMS_DB_PATH: ':memory:', OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
    OMS_USER: 'operator', OMS_PASS: 'test', OMS_PROFORMY_KATALOG: KATALOG, OMS_ETYKIETY_KATALOG: KATALOG };
  async function zdrowie(env: Record<string, string>) {
    const a = await zbudujOms({ env, teraz: () => new Date('2026-10-27T10:00:00Z') });
    try {
      const r = await a.app.inject('/health');
      return { kod: r.statusCode, ok: r.json().ok, alarmy: r.json().alarmy, uwagiModulow: a.zdrowie().uwagi, programFakturowy: a.usluga('faktury', 'programFakturowy') };
    } finally { await a.app.close(); a.db.close(); }
  }
  it('kod HTTP, ok i alarmy jak z inFaktem bez wyboru; zdanie trafia do uwag', async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('bez sieci'); }));
    const dzis = await zdrowie({ ...ENV_OMS, INFAKT_API_KEY: KLUCZ_PLIKU });
    const brak = await zdrowie({ ...ENV_OMS, INFAKT_API_KEY: KLUCZ_PLIKU, OMS_PROGRAM_FAKTUROWY: 'brak' });
    expect(dzis.kod).toBe(200);
    expect(brak.kod).toBe(dzis.kod);
    expect(brak.ok).toBe(dzis.ok);
    expect(brak.ok).toBe(true);
    expect(brak.alarmy).toEqual(dzis.alarmy);
    expect(brak.programFakturowy).toBeNull();
    expect(brak.uwagiModulow).toContain(ZDANIE_PLIKU);
    expect(dzis.uwagiModulow).not.toContain(STARE_ZDANIE);
  });
});
