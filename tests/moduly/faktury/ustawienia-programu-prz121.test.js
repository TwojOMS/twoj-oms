// PRZ-121.02 — ekran Ustawienia → Integracje → Moduł faktur (/ustawienia/integracje/program-fakturowy).
// Prawdziwy serwer (buildOmsServer) z prawdziwym modułem faktur; globalny fetch podmieniony — żadne żądanie nie wychodzi
// do inFaktu. Klucze i dane zmyślone („Pracownia Półcień”, lampy).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { wczytajKonfiguracjeIntegracji, zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { wczytajWyborProgramu } from '../../../src/oms/db/wybor-programu.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';

const ADRES = '/ustawienia/integracje/program-fakturowy';
const EKRAN_KLUCZA = '/ustawienia/integracje/infakt';
const KLUCZ_PLIKU = 'zmyslony0klucz0z0pliku0programu0prz121001';
const KLUCZ_EKRANU = 'zmyslony0klucz0z0ekranu0programu0prz121002';
const ZE_ZMIENNA = (program) => ({ INFAKT_API_KEY: KLUCZ_PLIKU, ...(program ? { OMS_PROGRAM_FAKTUROWY: program } : {}) });

let siec;
beforeEach(() => {
  siec = vi.fn(async () => new Response(JSON.stringify({ metainfo: { count: 0, total_count: 0 }, entities: [] }), { status: 200 }));
  vi.stubGlobal('fetch', siec);
});
afterEach(() => { vi.unstubAllGlobals(); });

function panel(env = {}) {
  const p = nowyPanel({ env });
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'ewa').id, ['zamowienia', 'faktury', 'ustawienia']);
  return { ...p, admin: jako(p.db, 'adam'), ewa: jako(p.db, 'ewa') };
}
const radia = (html) => [...html.matchAll(/<input type="radio"[^>]*>/gu)].map((m) => m[0]);
const formularz = (html) => /<form id="modul-faktur-formularz"[\s\S]*?<\/form>/u.exec(html)?.[0] ?? '';
const wartosc = (tag) => /value="([^"]*)"/u.exec(tag)?.[1];
const nieaktywne = (html) => radia(html).filter((t) => /\sdisabled\b/u.test(t)).map(wartosc);
const zaznaczone = (html) => radia(html).filter((t) => /\schecked\b/u.test(t)).map(wartosc);

function zamowienie(db, nr) {
  return zapiszZamowienie(db, 'pro', {
    zrodlo_id: `w-${nr}`, numer: String(nr), klient: { first_name: 'Ida' }, dostawa: {},
    metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: null,
    kwota_brutto: '249.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  }, {});
}
const T = '2026-10-05T09:00:00Z';

describe('PRZ-121.02 ekran Moduł faktur — widok', () => {
  it('PRZ-121.05c: w trybie próby z atrapą piaskownicy klucz API jest niepotrzebny', async () => {
    const { createModulFaktury } = await import('../../../src/moduly/faktury/modul.ts');
    const { MODULY } = await import('../../../src/moduly/lista.ts');
    const modul = createModulFaktury({ fabryki: { createInfaktClient: () => ({
      wystaw: async () => ({}), listaFaktur: async () => [], atrapa: true,
    }) } });
    const { app, db } = nowyPanel({ env: { OMS_TRYB: 'proba' },
      moduly: MODULY.map((m) => m.nazwa === 'faktury' ? modul : m) });
    try {
      zalozKonto(db, { login: 'polcien', imie: 'Pracownia Półcień', haslo: 'h', rola: 'administrator', admin: true });
      const r = await get(app, ADRES, jako(db, 'polcien'));
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('niepotrzebny — działa atrapa piaskownicy');
      expect(r.body).not.toContain('nie wpisany');
    } finally { await app.close(); db.close(); }
  });

  it('GET: cztery pola, nieaktywne dokładnie Fakturownia i TwojeFaktury, z opisem „wkrótce”', async () => {
    const { app, admin } = panel();
    const r = await get(app, ADRES, admin);
    expect(r.statusCode).toBe(200);
    expect(radia(r.body).map(wartosc)).toEqual(['brak', 'infakt', 'fakturownia', 'twojefaktury']);
    expect(nieaktywne(r.body)).toEqual(['fakturownia', 'twojefaktury']);
    expect(r.body).toContain('OMS sam wystawia faktury i wysyła je do KSeF, bez zewnętrznego programu');
    expect(r.body).toContain('wkrótce');
    expect(formularz(r.body)).toContain('<button class="btn btn--glowny" type="submit">Zapisz</button>');
    // Tytuł jak w menu Ustawień: H1, <title> i okruszek.
    const h1 = /<h1[^>]*>([^<]*)<\/h1>/u.exec(r.body)?.[1];
    expect(h1).toBe('Moduł faktur');
    expect(r.body).toContain(`<title>${h1}</title>`);
    expect(r.body).toMatch(new RegExp(`class="oms-breadcrumb">[\\s\\S]*?<strong>${h1}</strong>`));
  });

  it('bez wyboru i bez inFaktu: „Teraz działa: Brak”; z kluczem z pliku: inFakt, zaznaczony inFakt', async () => {
    const pusty = panel();
    const a = await get(pusty.app, ADRES, pusty.admin);
    expect(a.body).toMatch(/Teraz działa[\s\S]*?<strong>Brak<\/strong>/u);
    expect(zaznaczone(a.body)).toEqual(['brak']);
    const zInfaktem = panel(ZE_ZMIENNA());
    const b = await get(zInfaktem.app, ADRES, zInfaktem.admin);
    expect(b.body).toMatch(/Teraz działa[\s\S]*?<strong>inFakt<\/strong>/u);
    expect(zaznaczone(b.body)).toEqual(['infakt']);
    expect(b.body).toContain('Klucz API inFaktu: w pliku konfiguracji');
    expect(b.body).toContain(`href="${EKRAN_KLUCZA}"`);
  });

  it('klucz API nigdy w HTML — ani z pliku, ani zapisany w Ustawieniach', async () => {
    const { app, admin, db } = panel(ZE_ZMIENNA());
    zapiszKonfiguracjeIntegracji(db, 'infakt', { ustawienia: {}, sekrety: { apiKey: KLUCZ_EKRANU } });
    const r = await get(app, ADRES, admin);
    expect(r.statusCode).toBe(200);
    for (const k of [KLUCZ_PLIKU, KLUCZ_EKRANU, 'zmyslony0klucz']) expect(r.body.includes(k), k).toBe(false);
    const po = await post(app, ADRES, admin, { program: 'brak' });
    expect((await get(app, po.headers.location, admin)).body.includes('zmyslony0klucz')).toBe(false);
  });

  it('zła wartość w zapisie: uwaga na górze ekranu', async () => {
    const { app, admin, db } = panel();
    zapiszKonfiguracjeIntegracji(db, 'program_fakturowy', { ustawienia: { program: 'fakturownia' }, sekrety: {} });
    const r = await get(app, ADRES, admin);
    expect(r.body).toContain('Zapisany moduł faktur „fakturownia” nie działa w tej wersji OMS-u — faktury są wyłączone. Wybierz moduł ponownie.');
  });

  it('lista integracji ma odnośnik do ekranu w sekcji Faktury', async () => {
    const { app, admin } = panel();
    const r = await get(app, '/ustawienia/integracje', admin);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(`href="${ADRES}"`);
  });
});

describe('PRZ-121.02 ekran Moduł faktur — zapis', () => {
  it('admin zapisuje „Brak”: 303, wiersz z kontem, ekran mówi o restarcie i o tym, co działa do tego czasu', async () => {
    const { app, admin, db } = panel(ZE_ZMIENNA());
    const r = await post(app, ADRES, admin, { program: 'brak' });
    expect(r.statusCode, r.body).toBe(303);
    expect(r.headers.location.startsWith(ADRES)).toBe(true);
    const zapis = wczytajKonfiguracjeIntegracji(db, 'program_fakturowy');
    expect(zapis.ustawienia).toEqual({ program: 'brak' });
    expect(zapis.sekrety).toEqual({});
    expect(zapis.kontoLogin).toBe('adam');
    const ekran = await get(app, r.headers.location, admin);
    expect(ekran.body).toContain('Zapisano wybór modułu faktur.');
    expect(ekran.body).toContain('Zapisany moduł faktur „Brak” zadziała po ponownym uruchomieniu OMS-u — do tego czasu działa „inFakt”.');
    expect(zaznaczone(ekran.body)).toEqual(['brak']);
    expect(ekran.body).toMatch(/Teraz działa[\s\S]*?<strong>inFakt<\/strong>/u);
  });

  it('zapis tego samego, co działa: bez zdania o restarcie', async () => {
    const { app, admin } = panel(ZE_ZMIENNA());
    const r = await post(app, ADRES, admin, { program: 'infakt' });
    expect(r.statusCode).toBe(303);
    const ekran = await get(app, r.headers.location, admin);
    expect(ekran.body).not.toContain('ponownym uruchomieniu');
  });

  it('operator z uprawnieniem „ustawienia” widzi ekran tylko do odczytu; zapis 403, wiersz niezapisany', async () => {
    const { app, ewa, db } = panel(ZE_ZMIENNA());
    const r = await get(app, ADRES, ewa);
    expect(r.statusCode).toBe(200);
    expect(nieaktywne(r.body)).toEqual(['brak', 'infakt', 'fakturownia', 'twojefaktury']);
    expect(formularz(r.body)).not.toMatch(/type="submit"/u);
    expect(r.body).toContain('Zmienia administrator.');
    const odmowa = await post(app, ADRES, ewa, { program: 'brak' });
    expect(odmowa.statusCode).toBe(403);
    expect(wczytajWyborProgramu(db)).toBeNull();
  });

  it.each(['fakturownia', 'twojefaktury', 'nieistniejacy', ''])('wybór „%s”: 400, wiersz niezapisany, ekran zostaje', async (program) => {
    const { app, admin, db } = panel(ZE_ZMIENNA());
    const r = await post(app, ADRES, admin, { program });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Nie zapisano');
    expect(r.body).toContain('<h1>Moduł faktur</h1>');
    expect(wczytajWyborProgramu(db)).toBeNull();
  });

  it('wybór z pliku (OMS_PROGRAM_FAKTUROWY): pola nieaktywne, zdanie o pliku, zapis 409, wiersz niezapisany', async () => {
    const { app, admin, db } = panel(ZE_ZMIENNA('infakt'));
    const r = await get(app, ADRES, admin);
    expect(r.statusCode).toBe(200);
    expect(nieaktywne(r.body)).toEqual(['brak', 'infakt', 'fakturownia', 'twojefaktury']);
    expect(zaznaczone(r.body)).toEqual(['infakt']);
    expect(r.body).toContain('Ustawione w pliku konfiguracji (OMS_PROGRAM_FAKTUROWY) — tam to zmienisz.');
    expect(formularz(r.body)).not.toMatch(/type="submit"/u);
    const odmowa = await post(app, ADRES, admin, { program: 'brak' });
    expect(odmowa.statusCode).toBe(409);
    expect(odmowa.body).toContain('OMS_PROGRAM_FAKTUROWY');
    expect(wczytajWyborProgramu(db)).toBeNull();
  });
});

describe('PRZ-121.02 ostrzeżenie przy przełączeniu z inFaktu na „Brak”', () => {
  it('liczy dokumenty nowe i stare, zamówień i okresów: 2 z program/dokument_id + 1 z samym infakt_uuid = 3', async () => {
    const { app, admin, db } = panel(ZE_ZMIENNA());
    const wstaw = (nr, kolumny, wartosci) => db.prepare(`INSERT INTO faktury (zamowienie_id, ${kolumny}, numer, utworzona_at) VALUES (?, ${wartosci.map(() => '?').join(', ')}, ?, ?)`)
      .run(zamowienie(db, nr), ...wartosci, `FV ${nr}`, T);
    wstaw(5101, 'program, dokument_id', ['infakt', 'D-1']);            // nowy zapis
    wstaw(5102, 'infakt_uuid', ['U-STARY']);                            // wiersz starego obrazu
    wstaw(5103, 'program', ['infakt']);                                 // rezerwacja bez dokumentu — nie liczy się
    wstaw(5105, 'program', ['infakt']);                                 // druga rezerwacja — też się nie liczy
    wstaw(5104, 'program, dokument_id', ['inny-program', 'X-1']);       // dokument innego programu — nie liczy się
    db.prepare("INSERT INTO okresy_rozliczeniowe (klient_klucz, rok, miesiac, program, dokument_id, utworzony_at) VALUES ('nip:5250000000', 2026, 9, 'infakt', 'D-OKRES', ?)").run(T);
    const r = await get(app, ADRES, admin);
    expect(r.body).toContain('W OMS-ie są 3 faktury wystawione w inFakcie. Po przełączeniu OMS nie pobierze ich PDF-ów ani nie wyśle do KSeF — zostają w inFakcie.');
  });

  it('bez wystawionych dokumentów albo przy „Brak” w działaniu — bez ostrzeżenia', async () => {
    const bezDokumentow = panel(ZE_ZMIENNA());
    expect((await get(bezDokumentow.app, ADRES, bezDokumentow.admin)).body).not.toContain('Po przełączeniu OMS nie pobierze');
    const bezProgramu = panel();
    bezProgramu.db.prepare("INSERT INTO okresy_rozliczeniowe (klient_klucz, rok, miesiac, program, dokument_id, utworzony_at) VALUES ('nip:5250000000', 2026, 9, 'infakt', 'D-OKRES', ?)").run(T);
    expect((await get(bezProgramu.app, ADRES, bezProgramu.admin)).body).not.toContain('Po przełączeniu OMS nie pobierze');
  });

  it('odmiana liczby: 1 faktura, 2–4 faktury, reszta faktur (także 12–14 i 312)', async () => {
    const { zdanieOPrzelaczeniu } = await import('../../../src/moduly/faktury/trasy/ustawienia-programu.js');
    expect(zdanieOPrzelaczeniu(1, 'inFakcie')).toBe('W OMS-ie jest 1 faktura wystawiona w inFakcie. Po przełączeniu OMS nie pobierze jej PDF-a ani nie wyśle do KSeF — zostaje w inFakcie.');
    for (const [n, fraza] of [[2, 'są 2 faktury wystawione'], [4, 'są 4 faktury wystawione'], [22, 'są 22 faktury wystawione'],
      [5, 'jest 5 faktur wystawionych'], [12, 'jest 12 faktur wystawionych'], [14, 'jest 14 faktur wystawionych'], [312, 'jest 312 faktur wystawionych']]) {
      expect(zdanieOPrzelaczeniu(n, 'inFakcie'), String(n)).toContain(`W OMS-ie ${fraza} w inFakcie. Po przełączeniu OMS nie pobierze ich PDF-ów`);
    }
  });
});

describe('PRZ-121.02 ekran inFaktu przy wybranym „Brak”', () => {
  const NOWE = 'inFakt nie jest wybrany jako moduł faktur — klucz zostaje zapisany, OMS go nie używa.';
  it('nowe zdanie zamiast zdania o restarcie; bez wyboru „Brak” jego nie ma', async () => {
    const { app, admin } = panel();
    await post(app, EKRAN_KLUCZA, admin, { apiKey: KLUCZ_EKRANU });
    const przed = await get(app, EKRAN_KLUCZA, admin);
    expect(przed.body).toContain('po ponownym uruchomieniu OMS-u');
    expect(przed.body).not.toContain(NOWE);
    expect((await post(app, ADRES, admin, { program: 'brak' })).statusCode).toBe(303);
    const po = await get(app, EKRAN_KLUCZA, admin);
    expect(po.statusCode).toBe(200);
    expect(po.body).toContain(NOWE);
    expect(po.body).not.toContain('włączą się po ponownym uruchomieniu OMS-u');
    expect(po.body.includes(KLUCZ_EKRANU)).toBe(false);
  });
});
