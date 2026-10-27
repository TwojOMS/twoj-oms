// PRZ-118.05 — moduł faktur składa ProgramFakturowy: usługa `programFakturowy` obok `infakt`, strażnik kontraktu przy
// składaniu (sprawdzProgramFakturowy) i strażnik budżetu czuwaczy liczony z `opis.limity` WYBRANEGO programu.
// Zero sieci: globalny fetch podmieniony; klucze, NIP-y i program testowy zmyślone.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { createModulFaktury, ODSTEP_FAKTUR_MS } from '../../../src/moduly/faktury/modul.ts';
import { zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { NAJDLUZSZY_PRZEBIEG_MS, najdluzszyPrzebiegMs } from '../../../src/moduly/faktury/services/czuwacz-ksef.js';
import {
  NAJDLUZSZY_PRZEBIEG_ARCHIWUM_SPRZEDAZY_MS, najdluzszyPrzebiegArchiwumSprzedazyMs,
} from '../../../src/moduly/faktury/services/czuwacz-archiwum-sprzedazy.js';
import { programInfakt } from '../../../src/integracje/programy/infakt.ts';
import { METODY_OBOWIAZKOWE } from '../../../src/integracje/program-fakturowy.ts';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { modulyPiaskownicy } from '../../../deploy/proba/atrapy/index.mjs';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';

const KATALOG = mkdtempSync(join(tmpdir(), 'prz-118-05-'));
const ENV = { OMS_PROFORMY_KATALOG: KATALOG, OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000' };
const PROBA = { ...ENV, OMS_TRYB: 'proba' };
const KLUCZ_PLIKU = 'zmyslony-klucz-pliku-prz118-000000000001';
const KLUCZ_EKRANU_1 = 'zmyslony-klucz-ekranu-prz118-00000000001';
const KLUCZ_EKRANU_2 = 'zmyslony-klucz-ekranu-prz118-00000000002';

type Uslugi = Record<string, any>;
function zbuduj(modul: ReturnType<typeof createModulFaktury>, env: Record<string, string>, { klucz }: { klucz?: string } = {}) {
  const db = openOmsDb();
  if (klucz) zapiszKonfiguracjeIntegracji(db, 'infakt', { ustawienia: {}, sekrety: { apiKey: klucz } });
  const obce: Record<string, unknown> = { 'kanaly.klienciKanalow': {}, 'kanaly.config': { definicje: [], sklepy: {} } };
  const usluga = <T>(m: string, n: string) => {
    const k = `${m}.${n}`; if (!Object.hasOwn(obce, k)) throw new Error(k); return obce[k] as T;
  };
  const sprobuj = () => modul.zbuduj({ db, konfiguracja: modul.konfiguracja(env), teraz: () => new Date('2026-10-27T10:00:00Z'),
    log: () => {}, usluga } as any) as { uslugi: Uslugi };
  return { db, sprobuj };
}

/** Program testowy spoza inFaktu (zmyślony „Rachmistrz Półcienia”) — wchodzi szwem `fabryki.programFakturowy`. */
function programTestowy({ limity = {}, regulaVat = 'wierszami' }: { limity?: Record<string, number>; regulaVat?: string } = {}) {
  const metody = Object.fromEntries(METODY_OBOWIAZKOWE.map((m) => [m, async () => null]));
  return { ...metody, opis: {
    id: 'rachmistrz', nazwa: { mianownik: 'Rachmistrz', dopelniacz: 'Rachmistrza', miejscownik: 'Rachmistrzu', narzednik: 'Rachmistrzem' },
    regulaVat, zdolnosci: [], wystawienieWysylaDoKsef: false,
    limity: { zadanieMs: 30000, najdluzszaListaMs: 120000, stronaListy: 25, sufitStron: 40, rownolegleStron: 4, ...limity },
    adres: 'https://rachmistrz.invalid', ekran: '/ustawienia/integracje/rachmistrz' } };
}
const vies = { sprawdz: async () => ({ wynik: 'wazny' }) };

let siec: ReturnType<typeof vi.fn>;
function bezSieci() {
  siec = vi.fn(async () => new Response(JSON.stringify({ metainfo: { count: 0, total_count: 0 }, entities: [] }),
    { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', siec);
}
const kluczZadania = (i: number) => new Headers((siec.mock.calls[i][1] as RequestInit).headers).get('x-infakt-apikey');
afterEach(() => { vi.unstubAllGlobals(); });

describe('PRZ-118.05 budżet czuwaczy z limitów programu', () => {
  it('dla limitów inFaktu funkcje budżetu dają dokładnie dzisiejsze stałe', () => {
    const { limity } = programInfakt({}).opis;
    expect(najdluzszyPrzebiegMs(limity)).toBe(NAJDLUZSZY_PRZEBIEG_MS);
    expect(najdluzszyPrzebiegArchiwumSprzedazyMs(limity)).toBe(NAJDLUZSZY_PRZEBIEG_ARCHIWUM_SPRZEDAZY_MS);
    // Funkcje naprawdę czytają limity (nie oddają stałej): +1 ms zadania = +LIMIT_PRZEBIEGU ms przebiegu KSeF.
    expect(najdluzszyPrzebiegMs({ ...limity, zadanieMs: limity.zadanieMs + 1 }) - NAJDLUZSZY_PRZEBIEG_MS).toBe(50);
    expect(najdluzszyPrzebiegArchiwumSprzedazyMs({ ...limity, najdluzszaListaMs: limity.najdluzszaListaMs + 7 })
      - NAJDLUZSZY_PRZEBIEG_ARCHIWUM_SPRZEDAZY_MS).toBe(7);
  });
});

describe('PRZ-118.05 moduł faktur składa ProgramFakturowy', () => {
  it('(1) inFakt z pliku: usługa programFakturowy z opis.id „infakt” owija TEGO SAMEGO klienta co usługa infakt', async () => {
    bezSieci();
    const { db, sprobuj } = zbuduj(createModulFaktury(), { ...ENV, INFAKT_API_KEY: KLUCZ_PLIKU });
    const { uslugi } = sprobuj();
    const program = uslugi.programFakturowy;
    expect(program.opis.id).toBe('infakt');
    expect(program.opis.nazwa.miejscownik).toBe('inFakcie');
    // `infakt` zostaje surowym klientem (usługi i trasy 05 wołają jeszcze znajdzKlientaPoNip / zalozKlienta).
    expect(typeof uslugi.infakt.znajdzKlientaPoNip).toBe('function');
    expect(program.znajdzKlientaPoNip).toBeUndefined();
    // Ten sam klient pod spodem: wywołanie programu trafia w metodę obiektu usługi `infakt`.
    const lista = vi.spyOn(uslugi.infakt, 'listaFaktur').mockResolvedValue(['z-klienta']);
    await expect(program.listaFaktur({ od: '2026-10-01' })).resolves.toEqual(['z-klienta']);
    expect(lista).toHaveBeenCalledWith({ od: '2026-10-01' });
    db.close();
  });

  it('(2) bez inFaktu: programFakturowy i infakt to null', () => {
    const { db, sprobuj } = zbuduj(createModulFaktury(), ENV);
    const { uslugi } = sprobuj();
    expect(uslugi.programFakturowy).toBeNull();
    expect(uslugi.infakt).toBeNull();
    db.close();
  });

  it('(3a) inFakt z Ustawień: program owija pośrednika — zmiana klucza po starcie działa bez restartu', async () => {
    bezSieci();
    const { db, sprobuj } = zbuduj(createModulFaktury(), ENV, { klucz: KLUCZ_EKRANU_1 });
    const program = sprobuj().uslugi.programFakturowy;
    expect(program.opis.id).toBe('infakt');
    await program.listaFaktur({});
    zapiszKonfiguracjeIntegracji(db, 'infakt', { ustawienia: {}, sekrety: { apiKey: KLUCZ_EKRANU_2 } });
    await program.listaFaktur({});
    expect(siec).toHaveBeenCalledTimes(2);
    expect(kluczZadania(0) === KLUCZ_EKRANU_1).toBe(true);
    expect(kluczZadania(1) === KLUCZ_EKRANU_2).toBe(true);
    db.close();
  });

  it('(3b) piaskownica: z kluczem z ekranu bez atrapy — program odmawia „Piaskownica”; z atrapą — program na atrapie', async () => {
    bezSieci();
    const bez = zbuduj(createModulFaktury(), PROBA, { klucz: KLUCZ_EKRANU_1 });
    const program = bez.sprobuj().uslugi.programFakturowy;
    expect(program.opis.id).toBe('infakt');
    await expect(program.listaFaktur({})).rejects.toThrow('Piaskownica');
    bez.db.close();

    const env = { ...ENV_DEMO, OMS_TRYB: 'proba', OMS_PROFORMY_KATALOG: KATALOG };
    const faktury = modulyPiaskownicy(env).find((m: { nazwa: string }) => m.nazwa === 'faktury') as ReturnType<typeof createModulFaktury>;
    const z = zbuduj(faktury, env);
    const { uslugi } = z.sprobuj();
    expect(uslugi.infakt.atrapa).toBe(true);
    expect(uslugi.programFakturowy.opis.id).toBe('infakt');
    expect(Array.isArray(await uslugi.programFakturowy.listaFaktur({ od: '2026-10-01', do: '2026-10-31' }))).toBe(true);
    expect(siec).not.toHaveBeenCalled();
    z.db.close();
  });

  it('program z fabryki: to on jest usługą programFakturowy (i aliasem infakt), gdy przechodzi strażników', () => {
    const p = programTestowy();
    const { db, sprobuj } = zbuduj(createModulFaktury({ fabryki: { programFakturowy: () => p, createVies: () => vies } }), PROBA);
    const { uslugi } = sprobuj();
    expect(uslugi.programFakturowy).toBe(p);
    expect(uslugi.infakt).toBe(p);
    db.close();
  });

  it('(4) budżet czuwacza KSeF z limitów programu nie mieści się między tyknięciami → odmowa startu', () => {
    // 50 × 70 s + 50 × 5 s = 62 min 30 s ≥ 60 min; zadanie 70 s < próg zawieszonej faktury (5 min), więc kontrakt przechodzi.
    const p = programTestowy({ limity: { zadanieMs: 70000 } });
    expect(najdluzszyPrzebiegMs(p.opis.limity)).toBeGreaterThanOrEqual(ODSTEP_FAKTUR_MS);
    const { db, sprobuj } = zbuduj(createModulFaktury({ fabryki: { programFakturowy: () => p, createVies: () => vies } }), PROBA);
    expect(sprobuj).toThrow(/Budżet czuwacza KSeF.*Rachmistrz/);
    db.close();
  });

  it('(4) budżet czuwacza archiwum z limitów programu nie mieści się → odmowa startu', () => {
    const p = programTestowy({ limity: { najdluzszaListaMs: 3000000 } });
    expect(najdluzszyPrzebiegMs(p.opis.limity)).toBeLessThan(ODSTEP_FAKTUR_MS);
    const { db, sprobuj } = zbuduj(createModulFaktury({ fabryki: { programFakturowy: () => p, createVies: () => vies } }), PROBA);
    expect(sprobuj).toThrow(/Budżet czuwacza archiwum sprzedaży.*Rachmistrz/);
    db.close();
  });

  it('(5) program z regulaVat „odSumy” → odmowa startu z powodem', () => {
    const p = programTestowy({ regulaVat: 'odSumy' });
    const { db, sprobuj } = zbuduj(createModulFaktury({ fabryki: { programFakturowy: () => p, createVies: () => vies } }), PROBA);
    expect(sprobuj).toThrow(/Rachmistrz.*regulaVat „odSumy” nieobsługiwana/);
    db.close();
  });

  it('⛔ szew fabryki.programFakturowy poza trybem próby: odmowa budowy modułu', () => {
    const p = programTestowy();
    for (const tryb of [undefined, '', 'produkcja']) {
      const env = { ...ENV, ...(tryb === undefined ? {} : { OMS_TRYB: tryb }) };
      const { db, sprobuj } = zbuduj(createModulFaktury({ fabryki: { programFakturowy: () => p } }), env);
      expect(sprobuj, String(tryb)).toThrow('OMS_TRYB=proba');
      db.close();
    }
  });

  it('⛔ szew programu razem z atrapą klienta inFaktu: odmowa (jedno źródło programu)', () => {
    const p = programTestowy();
    const { db, sprobuj } = zbuduj(createModulFaktury({ fabryki: { programFakturowy: () => p, createInfaktClient: () => ({}) } }), PROBA);
    expect(sprobuj).toThrow(/programFakturowy.*createInfaktClient|createInfaktClient.*programFakturowy/);
    db.close();
  });
});

describe('PRZ-118.05 alias infakt i nadpisanie w kompozycji', () => {
  it('nadpisanie „faktury.infakt” w zbudujOms dociera do usluga(faktury, infakt) jak dotąd', async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('bez sieci'); }));
    const mock = { listaFaktur: vi.fn(async () => []) };
    const env = { OMS_DB_PATH: ':memory:', OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
      OMS_USER: 'operator', OMS_PASS: 'test', OMS_PROFORMY_KATALOG: KATALOG, OMS_ETYKIETY_KATALOG: KATALOG };
    const a = await zbudujOms({ env, nadpisania: { 'faktury.infakt': mock } });
    try {
      expect(a.usluga('faktury', 'infakt')).toBe(mock);
      // Bez inFaktu w konfiguracji moduł nie składa programu — nadpisanie aliasu nie tworzy go za plecami konsumentów.
      expect(a.usluga('faktury', 'programFakturowy')).toBeNull();
    } finally { await a.app.close(); a.db.close(); }
  });
});
