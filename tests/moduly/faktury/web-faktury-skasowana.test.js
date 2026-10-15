import { describe, it, expect, beforeEach } from 'vitest';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';

// ODNOTOWANIE „SKASOWAŁEM TĘ FAKTURĘ W inFAKCIE" — PO PRZEPROWADZCE Z KARTY NA /faktury
// (prośba właściciela 2026-09-01: „na co dzień jest to nieużywane — chyba ani razu nie
// skorzystałem z tego").
//
// ⚠️⚠️ NAJWAŻNIEJSZA RZECZ W TYM PLIKU: lista kandydatów idzie Z BAZY PANELU, nigdy z inFaktu.
// Zakładka /faktury pokazuje dokumenty pobrane z inFaktu NA ŻYWO, a faktura tam skasowana
// z tamtej listy ZNIKA — akcja postawiona przy wierszu z inFaktu byłaby niedostępna dokładnie
// w jedynej sytuacji, w której jest potrzebna. Dlatego atrapa `fakturyWidok` poniżej oddaje
// PUSTE listy: sekcja ma się pokazać mimo to.

const AUTH = { authorization: `Basic ${Buffer.from('t:h').toString('base64')}` };
const AUTH_POST = { ...AUTH, origin: 'http://localhost' };

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

const serwer = () => buildOmsServer({
  db,
  config: { auth: { user: 't', pass: 'h' } },
  // inFakt milczy — sekcja stoi na bazie panelu i ma działać także wtedy.
  fakturyWidok: { dokumenty: async () => [], nieoplacone: async () => [], proformy: () => [] },
});

const zmapowane = (numer) => ({
  zrodlo_id: `src-${numer}`, numer: String(numer), klient: { email: 'k@k.pl' }, dostawa: {},
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: '1234563218',
  kwota_brutto: '100.00', status_woo: 'processing', oplacone_at: '2026-09-01T09:00:00',
  anulowane: 0, utworzone_at: '2026-09-01T08:00:00', pozycje: [],
});

// Faktura WYSTAWIONA i bez żadnego śladu w KSeF — dokładnie stan, w którym wolno odnotować
// skasowanie (te same przesłanki, co bariera `fakturaSkasowanaWInfakcie`).
function fakturaPanelu(id, nad = {}) {
  const w = {
    ksef_status: null, ksef_numer: null, allegro_wyslana_at: null,
    numer: 'FV/63/2026', uuid: 'uuid-63', utworzona: '2026-09-01T10:00:00.000Z', ...nad,
  };
  db.prepare(
    'INSERT INTO faktury (zamowienie_id, ksef_status, ksef_numer, allegro_wyslana_at, numer,'
    + ' infakt_uuid, utworzona_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, w.ksef_status, w.ksef_numer, w.allegro_wyslana_at, w.numer, w.uuid, w.utworzona);
}

const zamowienieZFaktura = (numer, nad = {}) => {
  const id = zapiszZamowienie(db, 'pro', zmapowane(numer), {});
  fakturaPanelu(id, nad);
  return id;
};

const faktury = async (url = '/faktury?miesiac=2026-09') => {
  const app = serwer();
  await app.ready();
  return app.inject({ method: 'GET', url, headers: AUTH });
};

describe('/faktury — sekcja „Faktura skasowana w inFakcie"', () => {
  it('pokazuje fakturę panelu, choć inFakt nie oddał ani jednego dokumentu', async () => {
    const id = zamowienieZFaktura(3001);
    const r = await faktury();
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Faktura skasowana w inFakcie');
    expect(r.body).toContain('FV/63/2026');
    expect(r.body).toContain(`/zamowienia/${id}/faktura/skasowana`);
    // Nazwa akcji sugeruje, że panel kasuje — ekran ma to wprost prostować.
    expect(r.body).toMatch(/NICZEGO nie kasuje/);
  });

  // ⚠️ DOKUMENTU W KSeF SIĘ NIE KASUJE, TYLKO KORYGUJE. Obie kolumny są dowodem obecności
  // w KSeF: `ksef_status` z chwili wystawienia i `ksef_numer` od czuwacza — pominięcie
  // którejkolwiek wpuszczałoby na listę dokument, którego bariera i tak nie przepuści.
  it('NIE pokazuje faktury, która jest w KSeF (żadną z dwóch kolumn)', async () => {
    zamowienieZFaktura(3002, { ksef_numer: '1234563218-20260901-5EB04B000005-18' });
    zamowienieZFaktura(3003, { ksef_status: 'sent', numer: 'FV/64/2026' });
    const r = await faktury();
    expect(r.body).not.toContain('Faktura skasowana w inFakcie');
  });

  // ⚠️ DOKUMENT U KUPUJĄCEGO W ALLEGRO: skasowanie go w inFakcie NIE zabiera mu faktury
  // z rąk, więc zwolnienie zamówienia dałoby kupującemu drugi dokument na ten sam towar.
  it('NIE pokazuje faktury wysłanej już kupującemu na Allegro', async () => {
    zamowienieZFaktura(3004, { allegro_wyslana_at: '2026-09-01T11:00:00Z' });
    const r = await faktury();
    expect(r.body).not.toContain('Faktura skasowana w inFakcie');
  });

  // Rezerwacja bez numeru dokumentu to nie jest „faktura, którą dało się skasować w inFakcie"
  // — na to jest osobne wyjście („Sprawdziłem w inFakcie — faktury nie ma, odblokuj").
  it('NIE pokazuje rezerwacji bez numeru dokumentu', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(3005), {});
    db.prepare("INSERT INTO faktury (zamowienie_id, ksef_status, utworzona_at) VALUES (?, 'w_toku', '2026-09-01T10:00:00.000Z')").run(id);
    const r = await faktury();
    expect(r.body).not.toContain('Faktura skasowana w inFakcie');
  });

  it('trzyma się wybranego miesiąca', async () => {
    zamowienieZFaktura(3006, { utworzona: '2026-08-15T10:00:00.000Z' });
    expect((await faktury('/faktury?miesiac=2026-09')).body).not.toContain('FV/63/2026');
    expect((await faktury('/faktury?miesiac=2026-08')).body).toContain('FV/63/2026');
  });
});

describe('POST /zamowienia/:id/faktura/skasowana — powrót tam, skąd kliknięto', () => {
  it('z zakładki Faktury wraca na zakładkę, a nie na kartę zamówienia', async () => {
    const id = zamowienieZFaktura(3007);
    const app = serwer();
    await app.ready();
    const r = await app.inject({
      method: 'POST',
      url: `/zamowienia/${id}/faktura/skasowana`,
      headers: AUTH_POST,
      payload: { powrot: '/faktury?miesiac=2026-09&pole=invoice_date' },
    });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/faktury?miesiac=2026-09&pole=invoice_date');
    // …i rezerwacja NAPRAWDĘ zniknęła, czyli zamówienie jest zwolnione do wystawienia.
    expect(db.prepare('SELECT * FROM faktury WHERE zamowienie_id = ?').get(id)).toBeUndefined();
  });

  it('bez `powrot` dalej wraca na kartę zamówienia', async () => {
    const id = zamowienieZFaktura(3008);
    const app = serwer();
    await app.ready();
    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/faktura/skasowana`, headers: AUTH_POST,
    });
    expect(r.headers.location).toBe(`/zamowienia/${id}`);
  });

  // ⚠️⚠️ `powrot` PRZYCHODZI Z ŻĄDANIA, więc jest daną od użytkownika, a nie ustawieniem
  // panelu. Bez bramki `^\/[^/]` adres `//zly.example` albo `https://zly.example` trafiłby
  // wprost do nagłówka `Location` — czyli panel odsyłałby operatora na obcy serwer po
  // operacji, którą właśnie wykonał na swoich danych.
  it('adres spoza panelu jest IGNOROWANY — wraca na kartę', async () => {
    for (const zly of ['//zly.example/phish', 'https://zly.example', 'javascript:alert(1)', '']) {
      const id = zamowienieZFaktura(4000 + zly.length);
      const app = serwer();
      await app.ready();
      const r = await app.inject({
        method: 'POST',
        url: `/zamowienia/${id}/faktura/skasowana`,
        headers: AUTH_POST,
        payload: { powrot: zly },
      });
      expect(r.headers.location).toBe(`/zamowienia/${id}`);
    }
  });
});
