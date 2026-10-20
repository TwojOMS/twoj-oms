// PRZ-102.20 — rachunek w mailu „Faktura” (atrapa poczty, atrapa inFaktu): czytany z bieżącej konfiguracji przy każdym
// mailu (plik → Ustawienia → Firma → brak), nie raz przy starcie. Z rachunkiem w pliku mail jest bajt w bajt taki jak
// przed zmianą (skład bez źródła rachunku = droga sprzed PRZ-102.20). Dane zmyślone; nic nie wychodzi.
import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { createWiadomosci } from '../../../src/moduly/wiadomosci/services/wiadomosci.js';
import { zapiszRachunekFirmy, zrodloRachunkuFirmy } from '../../../src/oms/db/rachunek-firmy.js';

const PLIK = '34109010140000000000000000';
const PANEL = '09109010140000000000000062';
const zamowienie = () => ({
  zrodlo_id: 6020, numer: 'FV-RACH-020',
  klient: { first_name: 'Jan', last_name: 'Testowy', email: 'klient@fikcja.invalid', company: 'Nabywca Testowy' },
  dostawa: { first_name: 'Jan', last_name: 'Testowy', address_1: 'Odbiorcza 4', postcode: '00-950', city: 'Nibylandia' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: null,
  kwota_brutto: '990.00', koszt_dostawy_brutto: '0.00', koszt_dostawy_netto: '0.00',
  status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-10-01T09:15:00', termin_platnosci: '14',
  pozycje: [{ zrodlo_id: 7001, nazwa: 'Lampa', sku: 'LAMPA-1', ilosc: 10, cena_brutto: '99.00', cena_netto: '80.49',
    brutto_linii: '990.00', netto_linii: '804.88', vat: null }],
});
const ADRES = { nazwa: 'Pracownia Zmyślona', ulica: 'Wymyślona 12', kod: '00-950', miasto: 'Nibylandia', kraj: 'PL', phone: '', email: '' };

function faktura(config) {
  const db = openOmsDb(':memory:');
  const wyslane = [];
  const w = createWiadomosci({ db, mailer: { sendMail: async (m) => { wyslane.push(m); } },
    infakt: { pobierzPdf: async () => Buffer.from('%PDF-atrapa') }, config: { adresFirmy: () => ADRES, ...config(db) },
    teraz: () => '2026-10-02T10:00:00.000Z' });
  const id = zapiszZamowienie(db, 'reczne', zamowienie(), {});
  db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)')
    .run(id, 'fikcyjna-faktura', 'FV/20/2026', '2026-10-01');
  return { db, w, id, wyslane, zamknij: () => db.close() };
}

describe('PRZ-102.20 mail „Faktura” a rachunek firmy', () => {
  it('bez rachunku w pliku: rachunek z panelu, zmiana działa od następnego maila (bez restartu)', async () => {
    const f = faktura((db) => ({ proforma: { rachunek: null }, rachunekFirmy: zrodloRachunkuFirmy({ db, zPliku: { rachunek: null, bank: null } }).biezacy }));
    try {
      await f.w.wyslij(f.id, 'faktura');
      expect(f.wyslane[0].text).not.toContain('Rachunek:');
      zapiszRachunekFirmy(f.db, { rachunek: PANEL, bank: 'Bank Przykładowy' });
      await f.w.wyslij(f.id, 'faktura');
      expect(f.wyslane[1].text).toContain(`Rachunek: ${PANEL}`);
      expect(f.wyslane[1].html).toContain(PANEL);
      zapiszRachunekFirmy(f.db, { rachunek: PLIK, bank: '' });
      await f.w.wyslij(f.id, 'faktura');
      expect(f.wyslane[2].text).toContain(`Rachunek: ${PLIK}`);
    } finally { f.zamknij(); }
  });

  it('rachunek w pliku: mail bajt w bajt jak przed zmianą, także gdy w bazie stoi inny rachunek', async () => {
    const dzis = faktura(() => ({ proforma: { rachunek: PLIK, bank: 'Bank z Pliku' } }));
    const teraz = faktura((db) => {
      zapiszRachunekFirmy(db, { rachunek: PANEL, bank: 'Bank z Panelu' });
      return { proforma: { rachunek: PLIK, bank: 'Bank z Pliku' },
        rachunekFirmy: zrodloRachunkuFirmy({ db, zPliku: { rachunek: PLIK, bank: 'Bank z Pliku' } }).biezacy };
    });
    try {
      await dzis.w.wyslij(dzis.id, 'faktura');
      await teraz.w.wyslij(teraz.id, 'faktura');
      const [a, b] = [dzis.wyslane[0], teraz.wyslane[0]];
      expect(b.text).toContain(`Rachunek: ${PLIK}`);
      expect(b.text).toBe(a.text);
      expect(b.html).toBe(a.html);
      expect(b.subject).toBe(a.subject);
    } finally { dzis.zamknij(); teraz.zamknij(); }
  });
});
