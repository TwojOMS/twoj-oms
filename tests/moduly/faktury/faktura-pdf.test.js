import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { createInfaktClient } from '../../../src/oms/infakt/client.js';
import { createFaktura } from '../../../src/moduly/faktury/services/faktura.js';

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };
const PDF = Buffer.from('%PDF-1.4 udawany dokument');

const zmapowane = (id) => ({
  zrodlo_id: id, numer: String(id), klient: { first_name: 'Jan', last_name: 'Kowalski', email: 'j@k.pl' },
  dostawa: { city: 'Pęki' }, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: '6762432557',
  kwota_brutto: '123.00', koszt_dostawy_brutto: '0.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  metoda_platnosci: 'Przelew tradycyjny', utworzone_at: '2026-07-31T09:00:00',
  pozycje: [{ nazwa: 'STOP', sku: 'S1', ilosc: 1, cena_brutto: '123.00', brutto_linii: '123.00', vat: null }],
});

const wystawiona = (db, id, { uuid = 'u-1', numer = '65/07/2026' } = {}) => db.prepare(
  'INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, ksef_status, utworzona_at)'
  + " VALUES (?, ?, ?, NULL, '2026-07-31T10:00:00')",
).run(id, uuid, numer);

// ---------------------------------------------------------------------------------
// A. KLIENT inFAKTU — ksztalt zadania sprawdzony na ZYWYM dokumencie, nie z dokumentacji.
// ---------------------------------------------------------------------------------
describe('infakt.pobierzPdf', () => {
  const klient = (fetchImpl) => createInfaktClient({ apiKey: 'k', fetchImpl });
  const odp = (bajty, ok = true, status = 200) => ({
    ok, status, arrayBuffer: async () => bajty.buffer.slice(bajty.byteOffset, bajty.byteOffset + bajty.byteLength),
  });

  // ⚠️ `.pdf` na koncu adresu oddaje 406 („wybierz rozszerzenie .json"), a `/pdf.json` bez
  // `document_type` — 422. Ta linia koduje jedyny ksztalt, ktory dziala.
  it('strzela w /pdf.json z document_type=original', async () => {
    const f = vi.fn().mockResolvedValue(odp(PDF));
    await klient(f).pobierzPdf('abc-123');
    const url = f.mock.calls[0][0];
    expect(url).toContain('/v3/invoices/abc-123/pdf.json');
    expect(url).toContain('document_type=original');
  });

  it('nie prosi o JSON — dokument ma przyjść jako surowe bajty', async () => {
    const f = vi.fn().mockResolvedValue(odp(PDF));
    await klient(f).pobierzPdf('abc-123');
    expect(f.mock.calls[0][1].headers.Accept).toBeUndefined();
  });

  it('oddaje bajty dokumentu', async () => {
    const bajty = await klient(vi.fn().mockResolvedValue(odp(PDF))).pobierzPdf('abc-123');
    expect(bajty.subarray(0, 4).toString()).toBe('%PDF');
  });

  // Zapisanie JSON-a z bledem pod nazwa .pdf dalby plik, ktory otwiera sie dopiero
  // u operatora przy drukarce — czyli w najgorszym momencie.
  it('odpowiedź, która NIE jest PDF-em, jest odrzucana mimo statusu 200', async () => {
    const smiec = Buffer.from('{"error":"cos poszlo nie tak"}');
    await expect(klient(vi.fn().mockResolvedValue(odp(smiec))).pobierzPdf('abc-123'))
      .rejects.toThrow(/nie jest PDF/);
  });

  it('błąd inFaktu niesie status i powód', async () => {
    const bl = Buffer.from('{"error":"Nie znaleziono"}');
    await expect(klient(vi.fn().mockResolvedValue(odp(bl, false, 404))).pobierzPdf('abc-123'))
      .rejects.toThrow(/404/);
  });

  it('brak uuid to odmowa PRZED dotknięciem sieci', async () => {
    const f = vi.fn();
    // Komunikat mówi „dokument", nie „faktura": tą samą drogą jadą KOREKTY (pobierzPdfKorekty).
    await expect(klient(f).pobierzPdf(null)).rejects.toThrow(/nie ma numeru/);
    expect(f).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------
// B. USLUGA — prawdziwe createFaktura, nie atrapa: to ona czyta wiersz faktury i odmawia.
// ---------------------------------------------------------------------------------
describe('faktura.pdf (usługa)', () => {
  let db, infakt, uslugaFaktury;
  beforeEach(() => {
    db = openOmsDb(':memory:');
    infakt = { pobierzPdf: vi.fn().mockResolvedValue(PDF), znajdzKlientaPoNip: vi.fn(), zalozKlienta: vi.fn(), wystaw: vi.fn() };
    uslugaFaktury = createFaktura({ db, infakt });
  });

  it('woła inFakt UUID-em z wiersza faktury i oddaje numer do nazwy pliku', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(3401), {});
    wystawiona(db, id, { uuid: 'u-prawdziwy', numer: '65/07/2026' });
    const w = await uslugaFaktury.pdf(id);
    expect(infakt.pobierzPdf).toHaveBeenCalledWith('u-prawdziwy');
    expect(w.numer).toBe('65/07/2026');
  });

  it('zamówienie bez faktury → odmowa bez dotykania inFaktu', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(3402), {});
    await expect(uslugaFaktury.pdf(id)).rejects.toThrow(/nie ma jeszcze faktury/);
    expect(infakt.pobierzPdf).not.toHaveBeenCalled();
  });

  // Rezerwacja („w_toku") ma wiersz faktury, ale jeszcze BEZ uuid — dokumentu w inFakcie
  // moze w ogole nie byc. Strzal z pustym uuid dalby bezsensowny blad z API.
  it('faktura zawieszona w połowie wystawiania → odmowa, nie strzał z pustym uuid', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(3403), {});
    db.prepare(
      "INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, ksef_status, utworzona_at)"
      + " VALUES (?, NULL, NULL, 'w_toku', '2026-07-31T10:00:00')",
    ).run(id);
    await expect(uslugaFaktury.pdf(id)).rejects.toThrow(/nie została do końca wystawiona/);
    expect(infakt.pobierzPdf).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------
// C. TRASA
// ---------------------------------------------------------------------------------
describe('GET /zamowienia/:id/faktura/pdf', () => {
  let db, app, infakt;
  beforeEach(async () => {
    db = openOmsDb(':memory:');
    infakt = { pobierzPdf: vi.fn().mockResolvedValue(PDF) };
    const faktura = {
      wystaw: vi.fn(),
      pdf: async (id) => {
        const f = db.prepare('SELECT * FROM faktury WHERE zamowienie_id = ?').get(id);
        if (!f) throw Object.assign(new Error('To zamówienie nie ma jeszcze faktury.'), { dlaOperatora: true });
        return { bajty: await infakt.pobierzPdf(f.infakt_uuid), numer: f.numer };
      },
    };
    app = buildOmsServer({ db, config, poller, faktura });
    await app.ready();
  });
  const pobierz = (id) => app.inject({ method: 'GET', url: `/zamowienia/${id}/faktura/pdf`, headers: naglowek });

  it('oddaje PDF jako załącznik', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(3301), {});
    wystawiona(db, id);
    const r = await pobierz(id);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.headers['content-disposition']).toContain('attachment');
    expect(r.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  // ⚠️ Numer faktury ma ukosniki, a plik jedzie na Windowsa prosto do drukarki.
  it('ukośniki z numeru faktury nie trafiają do nazwy pliku', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(3302), {});
    wystawiona(db, id, { numer: '65/07/2026' });
    const r = await pobierz(id);
    const nazwa = /filename="([^"]+)"/.exec(r.headers['content-disposition'])[1];
    expect(nazwa).not.toContain('/');
    expect(nazwa.endsWith('.pdf')).toBe(true);
  });

  it('zamówienie bez faktury → czytelna odmowa, nie 500', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(3303), {});
    const r = await pobierz(id);
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('nie ma jeszcze faktury');
  });

  it('nieznane zamówienie → 404', async () => {
    expect((await pobierz(9999)).statusCode).toBe(404);
  });

  it('bez podpiętego inFaktu → 503, a nie wywrotka', async () => {
    const db2 = openOmsDb(':memory:');
    const app2 = buildOmsServer({ db: db2, config, poller });
    await app2.ready();
    const id = zapiszZamowienie(db2, 'pro', zmapowane(3304), {});
    const r = await app2.inject({ method: 'GET', url: `/zamowienia/${id}/faktura/pdf`, headers: naglowek });
    expect(r.statusCode).toBe(503);
  });

  it('karta pokazuje przycisk pobrania przy wystawionej fakturze', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(3305), {});
    wystawiona(db, id);
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toContain(`/zamowienia/${id}/faktura/pdf`);
  });

  it('bez faktury przycisku nie ma', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(3306), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).not.toContain('/faktura/pdf');
  });
});
