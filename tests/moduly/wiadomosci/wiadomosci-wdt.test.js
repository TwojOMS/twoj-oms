import { describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijFakture, zakonczFakture } from '../../../src/moduly/faktury/db/faktury.js';
import { createWiadomosci } from '../../../src/moduly/wiadomosci/services/wiadomosci.js';

// MAIL „FAKTURA" DLA ZAMOWIENIA WDT — do koperty dochodzi DRUGI zalacznik: „Potwierdzenie
// wywozu towarow" (art. 42 ust. 4), a tresc dostaje zdanie o nim (zdanie opisuje FAKT
// z koperty — regula sekcji Wiadomosci). Mail krajowy zostaje bajt w bajt jak dotad.

const CONFIG = {
  nadawca: {
    nazwa: 'Lumina Marek Zywiecki', ulica: '1 Maja 5', kod: '00-650', miasto: 'Pęki', kraj: 'PL',
  },
  proforma: { nip: '1234563218', rachunek: '34109010140000000000000000' },
};

const zmapowane = (id, nad = {}) => ({
  zrodlo_id: id, numer: String(id),
  klient: {
    first_name: 'Peter', last_name: 'Novak', company: 'Alfatrend s.r.o.',
    email: 'peter@alfatrend.sk', address_1: '1. mája 1', postcode: '01001', city: 'Žilina',
  },
  dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null,
  chce_fakture: 1, nip: 'SK1000000001', kwota_brutto: '96.48',
  status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-08-26T10:00:00',
  pozycje: [{ nazwa: 'Lampa stołowa Kałamarz 30x45cm', sku: null, ilosc: 2, cena_brutto: '40.24', vat: null }],
  ...nad,
});

function zestaw(nad = {}, { config = CONFIG } = {}) {
  const db = openOmsDb(':memory:');
  const id = zapiszZamowienie(db, 'pro', zmapowane(2701, nad), {});
  const f = rozpocznijFakture(db, id);
  zakonczFakture(db, f.id, { uuid: 'u-77', numer: 'WDT/1/08/2026', ksefStatus: null });
  const mailer = { sendMail: vi.fn().mockResolvedValue({}) };
  const infakt = { pobierzPdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-atrapa-faktury')) };
  const wiadomosci = createWiadomosci({
    db, mailer, infakt, config, teraz: () => '2026-08-26T12:00:00.000Z',
  });
  return { db, id, mailer, wiadomosci };
}

describe('mail „Faktura" przy zamówieniu WDT', () => {
  it('koperta niesie DWA załączniki: fakturę i potwierdzenie wywozu, a treść zdanie o nim', async () => {
    const { mailer, wiadomosci, id } = zestaw();
    await wiadomosci.wyslij(id, 'faktura');
    const mail = mailer.sendMail.mock.calls[0][0];
    expect(mail.attachments).toHaveLength(2);
    expect(mail.attachments[0].filename).toBe('Faktura_WDT_1_08_2026.pdf');
    expect(mail.attachments[1].filename).toBe('Potwierdzenie_wywozu_WDT_1_08_2026.pdf');
    // Drugi załącznik to PRAWDZIWY PDF składany przez panel, nie kopia faktury.
    expect(mail.attachments[1].content.subarray(0, 4).toString()).toBe('%PDF');
    expect(mail.text).toContain('Potwierdzenie wywozu');
    expect(mail.text).toContain('podpis');
    expect(mail.html).toContain('Potwierdzenie wywozu');
  });

  it('podgląd nazywa drugi załącznik — operator widzi, co pojedzie', async () => {
    const { wiadomosci, id } = zestaw();
    const p = await wiadomosci.podglad(id, 'faktura');
    expect(p.zalacznik).toBe('Faktura_WDT_1_08_2026.pdf');
  });

  it('mail faktury KRAJOWEJ: jeden załącznik, ani słowa o wywozie', async () => {
    const { mailer, wiadomosci, id } = zestaw({ nip: '1000001201' });
    await wiadomosci.wyslij(id, 'faktura');
    const mail = mailer.sendMail.mock.calls[0][0];
    expect(mail.attachments).toHaveLength(1);
    expect(mail.text).not.toContain('wywozu');
    expect(mail.html).not.toContain('wywozu');
  });

  it('brak adresu sprzedawcy w konfiguracji: odmowa Z POWODEM, mail nie wychodzi wcale', async () => {
    const { mailer, wiadomosci, id, db } = zestaw({}, {
      config: { proforma: CONFIG.proforma },
    });
    await expect(wiadomosci.wyslij(id, 'faktura')).rejects.toThrow(/sprzedawcy|adres/i);
    expect(mailer.sendMail).not.toHaveBeenCalled();
    const wpisy = db.prepare('SELECT * FROM log WHERE zamowienie_id = ?').all(id);
    expect(wpisy.some((w) => w.akcja === 'wiadomosc.nieudane-zlozenie')).toBe(true);
  });
});
