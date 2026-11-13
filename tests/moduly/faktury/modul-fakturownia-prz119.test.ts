// PRZ-119.05 — moduł faktur składa Fakturownię WYŁĄCZNIE z jawnego wyboru (plik OMS_PROGRAM_FAKTUROWY albo zapis
// „program_fakturowy”): klient z pliku (FAKTUROWNIA_API_TOKEN + FAKTUROWNIA_DOMENA), z zapisu ekranu (wiersz „fakturownia”)
// albo atrapa piaskownicy. Instalacja z samym kluczem inFaktu zostaje przy inFakcie; zapis Fakturowni bez wyboru
// niczego nie przełącza. Zero sieci: globalny fetch podmieniony; tokeny, domeny i NIP-y zmyślone („Pracownia Półcień”).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { createModulFaktury, wczytajFaktury } from '../../../src/moduly/faktury/modul.ts';
import { zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';

const KATALOG = mkdtempSync(join(tmpdir(), 'prz-119-05-'));
const ENV = { OMS_PROFORMY_KATALOG: KATALOG, OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000' };
const TOKEN = 'zmyslony-token-polcien-0001';
const DOMENA = 'pracownia-polcien';
const Z_PLIKU = { ...ENV, OMS_PROGRAM_FAKTUROWY: 'fakturownia', FAKTUROWNIA_API_TOKEN: TOKEN, FAKTUROWNIA_DOMENA: DOMENA };
const STARE_ZDANIE = 'Fakturowanie inFakt nie jest skonfigurowane.';

type Uslugi = Record<string, any>;
type Zbudowany = { uslugi: Uslugi; zdrowie: () => { alarmy: string[]; uwagi: string[] } };
function zbuduj(modul: ReturnType<typeof createModulFaktury>, env: Record<string, string>,
  { wybor, fakturownia, infakt }: { wybor?: string; fakturownia?: boolean; infakt?: string } = {}) {
  const db = openOmsDb();
  if (wybor) zapiszKonfiguracjeIntegracji(db, 'program_fakturowy', { ustawienia: { program: wybor }, sekrety: {} });
  if (fakturownia) zapiszKonfiguracjeIntegracji(db, 'fakturownia', { ustawienia: { domena: DOMENA }, sekrety: { token: TOKEN } });
  if (infakt) zapiszKonfiguracjeIntegracji(db, 'infakt', { ustawienia: {}, sekrety: { apiKey: infakt } });
  const obce: Record<string, unknown> = { 'kanaly.klienciKanalow': { lampy: {} }, 'kanaly.config': { definicje: [], sklepy: {} } };
  const usluga = <T>(m: string, n: string) => {
    const k = `${m}.${n}`; if (!Object.hasOwn(obce, k)) throw new Error(k); return obce[k] as T;
  };
  const sprobuj = () => modul.zbuduj({ db, konfiguracja: modul.konfiguracja(env), teraz: () => new Date('2026-11-12T10:00:00Z'),
    log: () => {}, usluga } as any) as unknown as Zbudowany;
  return { db, sprobuj };
}

let siec: ReturnType<typeof vi.fn>;
beforeEach(() => {
  siec = vi.fn(async () => { throw new Error('PRZ-119.05: sieć zabroniona w teście'); });
  vi.stubGlobal('fetch', siec);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('PRZ-119.05 plik konfiguracji', () => {
  it('token bez domeny (i odwrotnie) = odmowa startu z nazwą brakującej zmiennej, bez wartości', () => {
    const bezDomeny = () => wczytajFaktury({ ...ENV, FAKTUROWNIA_API_TOKEN: TOKEN });
    expect(bezDomeny).toThrow(/FAKTUROWNIA_DOMENA/);
    expect(bezDomeny).not.toThrow(new RegExp(TOKEN));
    expect(() => wczytajFaktury({ ...ENV, FAKTUROWNIA_DOMENA: DOMENA })).toThrow(/FAKTUROWNIA_API_TOKEN/);
    expect(wczytajFaktury(ENV).fakturownia).toBeNull();
  });

  it('domena spoza wzoru (adres zamiast domeny) = odmowa startu z nazwą zmiennej, nie błąd klienta przy składaniu', () => {
    for (const zla of ['https://pracownia-polcien.fakturownia.pl', 'Pracownia-Polcien', 'polcien.fakturownia.pl']) {
      expect(() => wczytajFaktury({ ...ENV, FAKTUROWNIA_API_TOKEN: TOKEN, FAKTUROWNIA_DOMENA: zla }), zla)
        .toThrow(/^FAKTUROWNIA_DOMENA: /);
    }
    expect(wczytajFaktury({ ...ENV, FAKTUROWNIA_API_TOKEN: TOKEN, FAKTUROWNIA_DOMENA: ` ${DOMENA} ` }).fakturownia)
      .toEqual({ token: TOKEN, domena: DOMENA });
  });

  it('OMS_PROGRAM_FAKTUROWY=fakturownia + token i domena w pliku → program Fakturowni, czuwacz KSeF, zero sieci', () => {
    const { db, sprobuj } = zbuduj(createModulFaktury(), Z_PLIKU);
    try {
      const { uslugi, zdrowie } = sprobuj();
      expect(uslugi.programFakturowy.opis.id).toBe('fakturownia');
      expect(uslugi.infakt).toBe(uslugi.programFakturowy);
      for (const n of ['faktura', 'fakturyWidok', 'wysylkaKsef', 'czuwaczKsef', 'doczytanieKsef']) expect(uslugi[n], n).toBeTruthy();
      expect(uslugi.czuwaczArchiwumSprzedazy).toBeNull();
      expect(uslugi.wyborProgramu).toMatchObject({ program: 'fakturownia', zrodlo: 'plik' });
      expect(uslugi.wyborProgramu.gotowy()).toBe(true);
      expect(zdrowie().uwagi).not.toContain(STARE_ZDANIE);
      expect(siec).not.toHaveBeenCalled();
    } finally { db.close(); }
  });
});

describe('PRZ-119.05 zapis z Ustawień', () => {
  it('wybór „fakturownia” + domena i token z ekranu → program Fakturowni (pośrednik, bez sieci przy składaniu)', () => {
    const { db, sprobuj } = zbuduj(createModulFaktury(), ENV, { wybor: 'fakturownia', fakturownia: true });
    try {
      const { uslugi } = sprobuj();
      expect(uslugi.programFakturowy.opis.id).toBe('fakturownia');
      expect(uslugi.wyborProgramu).toMatchObject({ program: 'fakturownia', zrodlo: 'ustawienia' });
      expect(uslugi.wyborProgramu.gotowy()).toBe(true);
      expect(siec).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it('ekran inFaktu przy wyborze Fakturowni: „sprawdź połączenie” = odmowa 400 bez żądania, zdanie mówi o Fakturowni', async () => {
    const { db, sprobuj } = zbuduj(createModulFaktury(), ENV, { wybor: 'fakturownia', fakturownia: true, infakt: 'zmyslony-klucz-polcien' });
    try {
      const blad = await sprobuj().uslugi.konfiguracjaInfaktu.sprawdzPolaczenie().catch((e: any) => e);
      expect(blad).toMatchObject({ status: 400 });
      expect(blad.message).toMatch(/^Moduł faktur to teraz Fakturownia/);
      expect(blad.message).not.toMatch(/infakt/i);
      expect(siec).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it('wybór „fakturownia” bez domeny i tokenu → bez programu, gotowy() fałsz, Zdrowie mówi o Fakturowni', () => {
    const { db, sprobuj } = zbuduj(createModulFaktury(), ENV, { wybor: 'fakturownia', infakt: 'zmyslony-klucz-infaktu-0001' });
    try {
      const { uslugi, zdrowie } = sprobuj();
      expect(uslugi.programFakturowy).toBeNull();
      expect(uslugi.infakt).toBeNull();
      expect(uslugi.wyborProgramu.gotowy()).toBe(false);
      const uwagi = zdrowie().uwagi;
      expect(uwagi).not.toContain(STARE_ZDANIE);
      expect(uwagi.join(' ')).toContain('Fakturownia nie jest skonfigurowana');
      expect(siec).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it('zapis Fakturowni BEZ wyboru: z kluczem inFaktu działa inFakt, bez niego — nic (Fakturownia nigdy domyślnie)', () => {
    const zInfaktem = zbuduj(createModulFaktury(), { ...ENV, INFAKT_API_KEY: 'zmyslony-klucz-pliku-polcien-0001' }, { fakturownia: true });
    try { expect(zInfaktem.sprobuj().uslugi.programFakturowy.opis.id).toBe('infakt'); } finally { zInfaktem.db.close(); }
    const sam = zbuduj(createModulFaktury(), ENV, { fakturownia: true });
    try {
      const { uslugi } = sam.sprobuj();
      expect(uslugi.programFakturowy).toBeNull();
      expect(uslugi.wyborProgramu).toMatchObject({ program: 'brak', zrodlo: 'domyslny' });
    } finally { sam.db.close(); }
    expect(siec).not.toHaveBeenCalled();
  });

  it('Pracownia Świetlik z samym INFAKT_API_KEY (bez wyboru, token Fakturowni też w pliku) → inFakt', () => {
    const { db, sprobuj } = zbuduj(createModulFaktury(), { ...ENV, INFAKT_API_KEY: 'zmyslony-klucz-swietlik-0001',
      FAKTUROWNIA_API_TOKEN: TOKEN, FAKTUROWNIA_DOMENA: DOMENA });
    try { expect(sprobuj().uslugi.programFakturowy.opis.id).toBe('infakt'); } finally { db.close(); }
  });
});

describe('PRZ-119.05 piaskownica', () => {
  const PROBA = { ...ENV, OMS_TRYB: 'proba', OMS_PROGRAM_FAKTUROWY: 'fakturownia' };

  it('z atrapą `createFakturowniaClient` → program Fakturowni na atrapie; token z ekranu idzie do atrapy', async () => {
    const atrapa = vi.fn(({ token }: { token: string }) => ({
      sprawdzPolaczenie: async () => ({ ok: true, token }),
    }));
    // Piaskownica podaje obie fabryki (inFakt i Fakturownia) — przy wyborze Fakturowni inFakt nie powstaje.
    const createInfaktClient = vi.fn(() => ({ atrapa: true }));
    const { db, sprobuj } = zbuduj(createModulFaktury({ fabryki: { createFakturowniaClient: atrapa, createInfaktClient } }), PROBA,
      { fakturownia: true });
    try {
      const { uslugi } = sprobuj();
      expect(uslugi.programFakturowy.opis.id).toBe('fakturownia');
      expect(createInfaktClient).not.toHaveBeenCalled();
      expect(uslugi.wyborProgramu.gotowy()).toBe(true);
      expect(await uslugi.programFakturowy.sprawdzPolaczenie()).toMatchObject({ token: TOKEN });
      expect(siec).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it('atrapa bez zapisu z ekranu → token „demo” (demo działa od razu)', async () => {
    const atrapa = vi.fn(({ token }: { token: string }) => ({ sprawdzPolaczenie: async () => ({ token }) }));
    const { db, sprobuj } = zbuduj(createModulFaktury({ fabryki: { createFakturowniaClient: atrapa } }), PROBA);
    try {
      expect(await sprobuj().uslugi.programFakturowy.sprawdzPolaczenie()).toMatchObject({ token: 'demo' });
    } finally { db.close(); }
  });

  it('próba bez atrapy, zapis z ekranu → odmowa 400 zamiast prawdziwej Fakturowni', async () => {
    const { db, sprobuj } = zbuduj(createModulFaktury(), PROBA, { fakturownia: true });
    try {
      const { uslugi } = sprobuj();
      await expect(uslugi.programFakturowy.sprawdzPolaczenie()).rejects.toMatchObject({ status: 400 });
      expect(siec).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it('atrapa Fakturowni poza próbą → odmowa startu', () => {
    const { db, sprobuj } = zbuduj(createModulFaktury({ fabryki: { createFakturowniaClient: () => ({}) } }), Z_PLIKU);
    try { expect(sprobuj).toThrow(/createFakturowniaClient/); } finally { db.close(); }
  });
});

describe('PRZ-119.05 dokument inFaktu przy Fakturowni', () => {
  it('PDF faktury zamówienia z dokumentem inFaktu → 409 bezProgramu, bez żądania', async () => {
    const { db, sprobuj } = zbuduj(createModulFaktury(), Z_PLIKU);
    try {
      const { uslugi } = sprobuj();
      const id = zapiszZamowienie(db, 'allegro_polcien', {
        zrodlo_id: 'PC-1', numer: 'PC-701', klient: { company: 'Pracownia Półcień sp. z o.o.' }, dostawa: {},
        metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: '5250000009', kwota_brutto: '123.00',
        koszt_dostawy_brutto: '0.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
        utworzone_at: '2026-11-10T08:00:00Z', pozycje: [],
      }, {});
      db.prepare(`INSERT INTO faktury (zamowienie_id, program, dokument_id, infakt_uuid, numer, utworzona_at)
        VALUES (?,?,?,?,?,?)`).run(id, 'infakt', 'inf-0001', 'inf-0001', '1/11/2026', '2026-11-10T09:00:00Z');
      await expect(uslugi.faktura.pdf(id)).rejects.toMatchObject({ status: 409, bezProgramu: true });
      expect(siec).not.toHaveBeenCalled();
    } finally { db.close(); }
  });
});
