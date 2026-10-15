import { potwierdzOdmoweHistorycznegoSchema } from '../../pomoc/baseline-historyczne.js';
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import {
  zapiszZamowienie, pobierzZamowienie, dodajPozycjeReczna, zapiszNadpisaniaPozycji,
} from '../../../src/oms/db/zamowienia.js';
import { dodajWplateReczna } from '../../../src/oms/db/platnosci.js';
import { parsujNowaPozycje } from '../../../src/domena/pozycje-reczne.js';
import { mapujZamowienie } from '../../../src/domena/mapowanie.js';
import { createFaktura } from '../../../src/moduly/faktury/services/faktura.js';
import { stanFaktury } from '../../../src/domena/faktura-stan.js';

const zmapowane = (nad = {}) => ({
  zrodlo_id: 1301, numer: '1301',
  klient: { first_name: 'Jan', last_name: 'Kowalski', company: 'ACME', email: 'j@k.pl', address_1: 'Polna 1', postcode: '00-650', city: 'Pęki' },
  dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null,
  chce_fakture: 1, nip: '1000001201', kwota_brutto: '123.00', koszt_dostawy_brutto: '0.00',
  status_woo: 'processing',
  oplacone_at: '2026-07-29T13:00:00', anulowane: 0, utworzone_at: '2026-07-29T13:19:52',
  pozycje: [{ nazwa: 'STOP', sku: 'PRO-STOP-001', ilosc: 2, cena_brutto: '61.50', vat: null }],
  ...nad,
});

function zestaw(nad = {}, atrapy = {}) {
  const db = openOmsDb(':memory:');
  const infakt = {
    znajdzKlientaPoNip: atrapy.znajdz ?? vi.fn().mockResolvedValue(null),
    zalozKlienta: atrapy.zaloz ?? vi.fn().mockResolvedValue(555),
    wystaw: atrapy.wystaw ?? vi.fn().mockResolvedValue({ uuid: 'u1', numer: 'FV/1/2026', ksefStatus: 'sent' }),
    // Krok PO nieodwracalnym — patrz ostatni describe w tym pliku.
    oznaczZaplacona: atrapy.oznacz ?? vi.fn().mockResolvedValue({ referencja: 'ref-1' }),
  };
  const id = zapiszZamowienie(db, 'pro', zmapowane(nad), {});
  return { db, infakt, id, faktura: createFaktura({ db, infakt }) };
}

const bladApi = (komunikat, status) => Object.assign(new Error(komunikat), { dlaOperatora: true, status });
const wiersz = (db, id) => db.prepare('SELECT * FROM faktury WHERE zamowienie_id = ?').get(id);
const log = (db, id) => db.prepare('SELECT * FROM log WHERE zamowienie_id = ? ORDER BY id').all(id);

describe('faktura — nabywca z kartoteki', () => {
  // Faktura wskazuje klienta IDENTYFIKATOREM. Danych nabywcy nie da sie podac wprost:
  // POST /invoices.json oddaje `client_id: "Prosze wybrac klienta"` nawet z pelnym adresem.
  it('używa klienta z kartoteki i NIE zakłada duplikatu', async () => {
    const znajdz = vi.fn().mockResolvedValue(7);
    const { infakt, faktura, id } = zestaw({}, { znajdz });
    await faktura.wystaw(id);
    expect(znajdz).toHaveBeenCalledWith('1000001201');
    expect(infakt.zalozKlienta).not.toHaveBeenCalled();
    expect(infakt.wystaw.mock.calls[0][0].client_id).toBe(7);
  });

  it('zakłada klienta, gdy kartoteka go nie ma, i używa nowego id', async () => {
    const { infakt, faktura, id } = zestaw();
    await faktura.wystaw(id);
    expect(infakt.zalozKlienta).toHaveBeenCalledTimes(1);
    expect(infakt.wystaw.mock.calls[0][0].client_id).toBe(555);
  });

  // I5. Wpis zalozony BEZ NIP-u to (a) faktura dla firmy bez NIP-u na dokumencie,
  // (b) wpis, ktorego `q[nip_eq]` nigdy nie znajdzie — czyli nowy duplikat przy KAZDYM
  // kolejnym zamowieniu tego klienta. Dokladnie ta awaria, ktorej caly trzystopniowy
  // obieg ma zapobiegac, a nikt jej nie sprawdzal.
  it('NIP zamówienia trafia do zakładanego wpisu w kartotece', async () => {
    const { infakt, faktura, id } = zestaw();
    await faktura.wystaw(id);
    expect(infakt.zalozKlienta.mock.calls[0][0].nip).toBe('1000001201');
  });

  // Bez NIP-u nie ma po czym szukac. Dopasowanie po nazwie podpieloby fakture
  // pod CUDZY wpis — a tego, w odroznieniu od duplikatu, nie da sie cofnac.
  it('bez NIP-u nie szuka wcale, tylko zakłada wpis', async () => {
    const { infakt, faktura, id } = zestaw({ nip: null });
    await faktura.wystaw(id);
    expect(infakt.znajdzKlientaPoNip).not.toHaveBeenCalled();
    expect(infakt.zalozKlienta).toHaveBeenCalledTimes(1);
    expect(infakt.zalozKlienta.mock.calls[0][0].nip).toBeNull();
  });

  it('przekazuje adres jednym stringiem do street', async () => {
    const { infakt, faktura, id } = zestaw();
    await faktura.wystaw(id);
    const k = infakt.zalozKlienta.mock.calls[0][0];
    expect(k.street).toBe('Polna 1');
    expect(k.postal_code).toBe('00-650');
    expect(k.city).toBe('Pęki');
  });

  // Zamówienie 1275 z briefu: sklep na pro.szkicownia.pl rozbija adres na billing.address_1
  // (ulica) i billing.address_2 (numer budynku) — faktura wychodziłaby bez numeru budynku
  // nabywcy, mimo że dokument ma być dowodem księgowym z poprawnym adresem.
  it('adres nabywcy z rozbitym address_1/address_2 (zamówienie 1275) trafia do street Z numerem', async () => {
    const rozbity = { klient: { first_name: 'Jan', last_name: 'Kowalski', company: 'ACME', email: 'j@k.pl', address_1: 'Lipowa', address_2: '91', postcode: '00-650', city: 'Pęki' } };
    const { infakt, faktura, id } = zestaw(rozbity);
    await faktura.wystaw(id);
    const k = infakt.zalozKlienta.mock.calls[0][0];
    expect(k.street).toBe('Lipowa 91');
  });

  // inFakt wymaga company_name TAKZE dla osoby prywatnej (422 "Prosze podac nazwe firmy").
  // Kod ma to wypelnic sam, a nie oddawac ten komunikat operatorowi.
  it('bez firmy wstawia imię i nazwisko w company_name', async () => {
    const bezFirmy = { klient: { first_name: 'Jan', last_name: 'Kowalski', address_1: 'Polna 1', postcode: '00-650', city: 'Pęki' } };
    const { infakt, faktura, id } = zestaw(bezFirmy);
    await faktura.wystaw(id);
    expect(infakt.zalozKlienta.mock.calls[0][0].company_name).toBe('Jan Kowalski');
  });

  it('nieudane założenie klienta NIE wystawia faktury', async () => {
    const zaloz = vi.fn().mockRejectedValue(bladApi('inFakt odrzucił założenie klienta (422): Proszę podać nazwę firmy.', 422));
    const { infakt, faktura, id } = zestaw({}, { zaloz });
    await expect(faktura.wystaw(id)).rejects.toThrow(/nazwę firmy/);
    expect(infakt.wystaw).not.toHaveBeenCalled();
  });
});

describe('faktura — kwoty', () => {
  // C3a. `gross_price` pozycji to SUMA LINII, nie cena za sztuke — sprawdzone na prawdziwej
  // fakturze z konta (quantity=18, unit_net_price=2602, net_price=46829, gross_price=57600).
  // Wysylanie tu ceny jednostkowej PRZY jednoczesnym `quantity` zanizalo dokument
  // *quantity*-krotnie: 61,50 zamiast 123,00 zl.
  it('gross_price pozycji to suma linii (cena × ilość), nie cena jednostkowa', async () => {
    const { infakt, faktura, id } = zestaw();
    await faktura.wystaw(id);
    const p = infakt.wystaw.mock.calls[0][0];
    // 61,50 zl x 2 szt. = 123,00 zl = 12300 groszy. Wartosc policzona jawnie, nie przepisana.
    expect(p.services[0]).toEqual({ name: 'STOP', quantity: 2, gross_price: 12300, tax_symbol: '23' });
  });

  // Stawka jest zaszyta na 23%. Mutacja na '0' przechodzila dotad na zielono.
  it('stawka VAT pozycji to 23', async () => {
    const { infakt, faktura, id } = zestaw();
    await faktura.wystaw(id);
    expect(infakt.wystaw.mock.calls[0][0].services.every((s) => s.tax_symbol === '23')).toBe(true);
  });

  // C3b. Koszt dostawy jest czescia `total` zamowienia, ale NIE ma go w `line_items` —
  // bez osobnej pozycji faktura byla zanizona o wysylke przy kazdym platnym transporcie.
  it('dokłada pozycję dostawy, gdy wysyłka kosztuje', async () => {
    const { infakt, faktura, id } = zestaw({ kwota_brutto: '141.45', koszt_dostawy_brutto: '18.45' });
    await faktura.wystaw(id);
    const s = infakt.wystaw.mock.calls[0][0].services;
    expect(s).toHaveLength(2);
    expect(s[1]).toEqual({ name: 'Dostawa', quantity: 1, gross_price: 1845, tax_symbol: '23' });
  });

  it('darmowa dostawa nie dokłada pustej pozycji', async () => {
    const { infakt, faktura, id } = zestaw({ koszt_dostawy_brutto: '0.00' });
    await faktura.wystaw(id);
    expect(infakt.wystaw.mock.calls[0][0].services).toHaveLength(1);
  });

  it('brak kolumny kosztu dostawy (stara baza) nie wywraca wystawienia', async () => {
    const { infakt, faktura, id } = zestaw({ koszt_dostawy_brutto: null });
    await faktura.wystaw(id);
    expect(infakt.wystaw.mock.calls[0][0].services).toHaveLength(1);
  });

  // Test powyzej NICZEGO tu nie pilnuje: uzywa zamowienia z ZEROWA dostawa, wiec przechodzi
  // takze wtedy, gdy koszt przepadl. Prawdziwy przypadek to zamowienie sprzed dolozenia
  // kolumny z PLATNA dostawa: bez uzupelnienia z `surowe_json` przy otwarciu bazy odbija sie
  // ono od bariery arytmetycznej i NIGDY nie dostanie faktury z panelu — poller go nie
  // odswiezy, bo pobiera tylko to, co zmienilo sie po kursorze.
  it('zamówienie sprzed dołożenia kolumny, z PŁATNĄ dostawą, daje się zafakturować po restarcie', async () => {
    // Wyjątek zatwierdzony przez właściciela 2026-09-30: odmowa niezgodnego baseline + prawidłowe reopen.
    potwierdzOdmoweHistorycznegoSchema(["ALTER TABLE zamowienia DROP COLUMN koszt_dostawy_brutto"], ['koszt_dostawy_brutto']);
    const plik = join(mkdtempSync(join(tmpdir(), 'oms-faktura-')), 'oms.sqlite');
    const surowe = { id: 1301, shipping_total: '15.00', shipping_tax: '3.45' };

    const stara = openOmsDb(plik);
    zapiszZamowienie(stara, 'pro', zmapowane({ kwota_brutto: '141.45', koszt_dostawy_brutto: '18.45' }), surowe);
    // Poprawny baseline ma kolumnę i koszt; reopen zachowuje kwotę dokumentu.
    stara.close();

    const db = openOmsDb(plik);
    const infakt = {
      znajdzKlientaPoNip: vi.fn().mockResolvedValue(7),
      zalozKlienta: vi.fn(),
      wystaw: vi.fn().mockResolvedValue({ uuid: 'u1', numer: 'FV/1/2026', ksefStatus: 'sent' }),
    };
    const id = db.prepare('SELECT id FROM zamowienia').get().id;
    await createFaktura({ db, infakt }).wystaw(id);

    const s = infakt.wystaw.mock.calls[0][0].services;
    expect(s).toHaveLength(2);
    expect(s[1]).toEqual({ name: 'Dostawa', quantity: 1, gross_price: 1845, tax_symbol: '23' });
    db.close();
  });

  // ===== I2: gross_price bierze sie z BRUTTA LINII, nie z odtwarzania ceny jednostkowej =====
  //
  // Woo oddaje sume linii dokladnie. Panel dzielil ja przez ilosc, zaokraglal do groszy
  // i mnozyl z powrotem — sam produkowal rozjazd, o ktory sam sie potem odbijal na barierze.
  // Odmowa byla DETERMINISTYCZNA: ponowienie nie pomagalo, operator klikal w kolko ten sam
  // komunikat. Sklep B2B z rabatami trafia na to regularnie.
  //
  // Testy ida CALA PRAWDZIWA SCIEZKA (mapujZamowienie -> zapiszZamowienie -> wystaw),
  // bo blad mieszkal wlasnie na styku tych trzech kawalkow, a nie w zadnym z nich osobno.
  describe('suma linii nie dzieląca się równo przez ilość', () => {
    const zeSklepu = (nad) => ({
      id: 1301, number: '1301', status: 'processing', date_created: '2026-07-29T13:19:52',
      billing: { first_name: 'Jan', last_name: 'Kowalski', company: 'ACME', email: 'j@k.pl' },
      shipping: {}, shipping_lines: [{ method_id: 'flat_rate', instance_id: '1' }],
      shipping_total: '0.00', shipping_tax: '0.00',
      meta_data: [{ key: '_billing_faktura', value: '1' }, { key: '_billing_nip', value: '1000001201' }],
      ...nad,
    });

    async function przezPanel(surowe) {
      const db = openOmsDb(':memory:');
      const infakt = {
        znajdzKlientaPoNip: vi.fn().mockResolvedValue(7),
        zalozKlienta: vi.fn(),
        wystaw: vi.fn().mockResolvedValue({ uuid: 'u1', numer: 'FV/1/2026', ksefStatus: 'sent' }),
      };
      const id = zapiszZamowienie(db, 'pro', mapujZamowienie(surowe, { instancje: { 1: { metoda: 'dpd' } }, poPozycji: [] }), surowe);
      await createFaktura({ db, infakt }).wystaw(id);
      return { db, infakt, id };
    }

    // Przypadek zmierzony na prawdziwej sciezce: 3 szt., linia 81,30 + VAT 18,70 = 100,00
    // (rabat 10%). Stary panel: 33,33 x 3 = 99,99 -> „Suma pozycji (99.99) nie zgadza sie
    // z kwota zamowienia (100.00)".
    it('3 szt. za 100,00 zł z rabatem — faktura wychodzi, gross_price to 10000 gr', async () => {
      const { infakt } = await przezPanel(zeSklepu({
        total: '100.00',
        line_items: [{ name: 'STOP', sku: 'A', quantity: 3, total: '81.30', total_tax: '18.70' }],
      }));
      const s = infakt.wystaw.mock.calls[0][0].services;
      expect(s).toEqual([{ name: 'STOP', quantity: 3, gross_price: 10000, tax_symbol: '23' }]);
    });

    // Drugi zmierzony przypadek: 7 szt., 123,45 + 28,39 = 151,84 (stary panel: 151,83).
    it('7 szt. za 151,84 zł — faktura wychodzi, gross_price to 15184 gr', async () => {
      const { infakt } = await przezPanel(zeSklepu({
        total: '151.84',
        line_items: [{ name: 'STOP', sku: 'A', quantity: 7, total: '123.45', total_tax: '28.39' }],
      }));
      expect(infakt.wystaw.mock.calls[0][0].services[0].gross_price).toBe(15184);
    });

    // Kontrola pozytywna z briefu: 2 szt. po 61,50 bez rabatu przechodzilo TAKZE przed
    // poprawka. Ma przechodzic dalej i dawac dokladnie te sama kwote.
    it('2 szt. po 61,50 zł bez rabatu — bez zmiany, 12300 gr', async () => {
      const { infakt } = await przezPanel(zeSklepu({
        total: '123.00',
        line_items: [{ name: 'STOP', sku: 'A', quantity: 2, total: '100.00', total_tax: '23.00' }],
      }));
      expect(infakt.wystaw.mock.calls[0][0].services[0].gross_price).toBe(12300);
    });

    // Cena jednostkowa dalej ma sluzyc widokowi — zaokraglona, i to jest w porzadku,
    // dopoki nie bierze udzialu w liczeniu dokumentu.
    it('cena jednostkowa w bazie zostaje zaokrąglona — dla widoku, nie dla faktury', async () => {
      const { db, id } = await przezPanel(zeSklepu({
        total: '100.00',
        line_items: [{ name: 'STOP', sku: 'A', quantity: 3, total: '81.30', total_tax: '18.70' }],
      }));
      const p = pobierzZamowienie(db, id).pozycje[0];
      expect(p.cena_brutto).toBe('33.33');
      expect(p.brutto_linii).toBe('100.00');
    });

    // Bariera ZOSTAJE. Przestala strzelac do wlasnych zaokraglen, ale prawdziwa rozbieznosc
    // (sklep oddal linie, ktore nie sumuja sie do kwoty zamowienia) ma dalej zatrzymywac
    // nieodwracalny dokument.
    it('bariera nadal odmawia, gdy linie ze sklepu NAPRAWDĘ nie sumują się do kwoty', async () => {
      const db = openOmsDb(':memory:');
      const infakt = {
        znajdzKlientaPoNip: vi.fn().mockResolvedValue(7), zalozKlienta: vi.fn(), wystaw: vi.fn(),
      };
      const surowe = zeSklepu({
        total: '150.00',
        line_items: [{ name: 'STOP', sku: 'A', quantity: 3, total: '81.30', total_tax: '18.70' }],
      });
      const id = zapiszZamowienie(db, 'pro', mapujZamowienie(surowe, { instancje: { 1: { metoda: 'dpd' } }, poPozycji: [] }), surowe);
      await expect(createFaktura({ db, infakt }).wystaw(id)).rejects.toThrow(/100\.00.*150\.00/s);
      expect(infakt.wystaw).not.toHaveBeenCalled();
    });

    // Wiersz sprzed dolozenia kolumny (brutto_linii = NULL), ktorego migracja nie miala
    // z czego uzupelnic: ma zadzialac po staremu, a nie wysypac sie na pustej kwocie.
    it('pozycja bez brutta linii wraca do starego liczenia, zamiast paść', async () => {
      const db = openOmsDb(':memory:');
      const infakt = {
        znajdzKlientaPoNip: vi.fn().mockResolvedValue(7), zalozKlienta: vi.fn(),
        wystaw: vi.fn().mockResolvedValue({ uuid: 'u1', numer: 'FV/1/2026', ksefStatus: 'sent' }),
      };
      const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
      expect(pobierzZamowienie(db, id).pozycje[0].brutto_linii).toBeNull();
      await createFaktura({ db, infakt }).wystaw(id);
      expect(infakt.wystaw.mock.calls[0][0].services[0].gross_price).toBe(12300);
    });

    // Migracja: zamowienie zapisane PRZED dolozeniem kolumny, z linia nie dzielaca sie rowno.
    // Poller go nie odswiezy (pobiera tylko po kursorze), wiec bez uzupelnienia z surowe_json
    // odbijaloby sie od bariery na zawsze — dokladnie ta sama pulapka, co przy koszcie dostawy.
    it('zamówienie sprzed dołożenia kolumny daje się zafakturować po restarcie', async () => {
    // Wyjątek zatwierdzony przez właściciela 2026-09-30: odmowa niezgodnego baseline + prawidłowe reopen.
    potwierdzOdmoweHistorycznegoSchema(["ALTER TABLE pozycje DROP COLUMN brutto_linii"], ['brutto_linii']);
      const plik = join(mkdtempSync(join(tmpdir(), 'oms-brutto-')), 'oms.sqlite');
      const surowe = zeSklepu({
        total: '100.00',
        line_items: [{ name: 'STOP', sku: 'A', quantity: 3, total: '81.30', total_tax: '18.70' }],
      });

      const stara = openOmsDb(plik);
      zapiszZamowienie(stara, 'pro', mapujZamowienie(surowe, { instancje: { 1: { metoda: 'dpd' } }, poPozycji: [] }), surowe);
      stara.close();

      const db = openOmsDb(plik);
      const infakt = {
        znajdzKlientaPoNip: vi.fn().mockResolvedValue(7), zalozKlienta: vi.fn(),
        wystaw: vi.fn().mockResolvedValue({ uuid: 'u1', numer: 'FV/1/2026', ksefStatus: 'sent' }),
      };
      const id = db.prepare('SELECT id FROM zamowienia').get().id;
      await createFaktura({ db, infakt }).wystaw(id);
      expect(infakt.wystaw.mock.calls[0][0].services[0].gross_price).toBe(10000);
      db.close();
    });
  });

  // Wlasciciel wystawia faktury w ciagu dnia i sam wysyla je do KSeF zbiorczo, wieczorem —
  // panel MA TYLKO wystawiac. `send_to_ksef: true` bylo tu USTAWIANE NA TWARDO, wiec kazda
  // faktura z panelu leciala do KSeF automatycznie, mimo ze nikt o to nie prosil. Panel nie
  // ma prawa wywolywac wysylki w zadnej formie — stad brak wlasciwosci, nie jej wartosc.
  it('NIE prosi inFaktu o wysyłkę do KSeF — wysyłkę robi właściciel ręcznie, wieczorem', async () => {
    const { infakt, faktura, id } = zestaw();
    await faktura.wystaw(id);
    expect(infakt.wystaw.mock.calls[0][0]).not.toHaveProperty('send_to_ksef');
  });
});

// TERMIN PŁATNOŚCI. Bez niego dokument dostawał termin z USTAWIEŃ KONTA inFakt — ten sam
// dla wszystkich, niezależnie od tego, co uzgodniono z klientem. To sklep B2B: termin jest
// tam elementem umowy.
describe('faktura — termin płatności i data wystawienia', () => {
  // Zachowanie sprzed tej zmiany. Wywołania bez terminu (i wszystkie inne miejsca w panelu)
  // mają nie dokładać do dokumentu ani jednego pola, którego wcześniej tam nie było.
  it('BEZ argumentu terminu payload nie niesie ŻADNEJ daty — dokładnie jak dotąd', async () => {
    const { infakt, faktura, id } = zestaw();
    await faktura.wystaw(id);
    const p = infakt.wystaw.mock.calls[0][0];
    expect(p).not.toHaveProperty('invoice_date');
    expect(p).not.toHaveProperty('payment_date');
  });

  it('termin N dni trafia do payloadu jako invoice_date i payment_date', async () => {
    const { infakt, faktura, id } = zestaw();
    await faktura.wystaw(id, { dataWystawienia: '2026-08-03', termin: '14' });
    const p = infakt.wystaw.mock.calls[0][0];
    expect(p.invoice_date).toBe('2026-08-03');
    expect(p.payment_date).toBe('2026-08-17');
  });

  it('„przy odbiorze" wysyła payment_date RÓWNE dacie wystawienia', async () => {
    const { infakt, faktura, id } = zestaw();
    await faktura.wystaw(id, { dataWystawienia: '2026-08-03', termin: 'przy_odbiorze' });
    const p = infakt.wystaw.mock.calls[0][0];
    expect(p.invoice_date).toBe('2026-08-03');
    expect(p.payment_date).toBe('2026-08-03');
  });

  // ⚠️ DRUGI, OSOBNY STAN — nie to samo, co termin zerowy. Faktura ma wyjść bez terminu
  // zapłaty w dokumencie; nieopłacona jest z samego faktu utworzenia (inFakt tworzy każdą
  // fakturę w statusie `draft`, a opłacenie to osobne wywołanie, którego panel nie robi).
  it('„bez terminu" NIE wysyła payment_date w ogóle, ale datę wystawienia tak', async () => {
    const { infakt, faktura, id } = zestaw();
    await faktura.wystaw(id, { dataWystawienia: '2026-08-03', termin: 'bez_terminu' });
    const p = infakt.wystaw.mock.calls[0][0];
    expect(p.invoice_date).toBe('2026-08-03');
    expect(p).not.toHaveProperty('payment_date');
  });

  it('daty NIE psują reszty payloadu — nabywca i pozycje idą bez zmian', async () => {
    const { infakt, faktura, id } = zestaw();
    await faktura.wystaw(id, { dataWystawienia: '2026-08-03', termin: '7' });
    const p = infakt.wystaw.mock.calls[0][0];
    expect(p.client_id).toBe(555);
    expect(p.services).toHaveLength(1);
    expect(p).not.toHaveProperty('send_to_ksef');
  });

  // Literówka w polu terminu ma odbić się od formularza, a nie zostawić w tabeli sieroty
  // blokującej fakturę do końca świata.
  it('śmieć w terminie → odmowa, inFakt nietknięty i BEZ rezerwacji w tabeli', async () => {
    const { db, infakt, faktura, id } = zestaw();
    await expect(faktura.wystaw(id, { dataWystawienia: '2026-08-03', termin: '-3' }))
      .rejects.toThrow(/Termin płatności/);
    expect(infakt.wystaw).not.toHaveBeenCalled();
    expect(infakt.znajdzKlientaPoNip).not.toHaveBeenCalled();
    expect(wiersz(db, id)).toBeUndefined();
  });

  it('nieistniejąca data wystawienia → odmowa przed dotknięciem inFaktu', async () => {
    const { db, infakt, faktura, id } = zestaw();
    await expect(faktura.wystaw(id, { dataWystawienia: '2026-02-30', termin: '7' }))
      .rejects.toThrow(/Data wystawienia/);
    expect(infakt.wystaw).not.toHaveBeenCalled();
    expect(wiersz(db, id)).toBeUndefined();
  });

  // Odmowy sprzed wystawienia (anulowane, brak zgody na fakturę, bariera) mają wygrywać
  // z terminem — poprawny termin nie może przepchnąć dokumentu, którego nie wolno wystawić.
  it('poprawny termin NIE omija odmowy dla zamówienia anulowanego', async () => {
    const { infakt, faktura, id } = zestaw({ anulowane: 1 });
    await expect(faktura.wystaw(id, { dataWystawienia: '2026-08-03', termin: '14' }))
      .rejects.toThrow(/anulowane/i);
    expect(infakt.wystaw).not.toHaveBeenCalled();
  });

  it('poprawny termin NIE omija bariery arytmetycznej', async () => {
    const { infakt, faktura, id } = zestaw({ kwota_brutto: '141.45', koszt_dostawy_brutto: null });
    await expect(faktura.wystaw(id, { dataWystawienia: '2026-08-03', termin: '14' }))
      .rejects.toThrow(/nie zgadza się/i);
    expect(infakt.wystaw).not.toHaveBeenCalled();
  });
});

// ⚠️ SZEW `datyFaktury(termin, kwotaOczekiwanaGrosze(z))` W services/faktura.js. Domena umie
// policzyc `sale_date` i `paid_price`, trasa umie je przekazac — ale to, ze USLUGA faktycznie
// je sklada i wsypuje do payloadu, do 2026-08-04 nie bylo trzymane NICZYM. Zmierzone: obie
// mutacje przechodzily pelna suite:
//   - `kwotaOczekiwanaGrosze(z) - 1` → dokument mowiacy „Zaplacono 122,99" przy sumie 123,00;
//   - `datyFaktury(termin, null)` → wariant „zaplacone" ZAWSZE rzuca, cala galaz martwa.
describe('faktura — data sprzedaży i wariant „zapłacone" w payloadzie', () => {
  // Wplata dopisywana RECZNIE ta sama funkcja, co na karcie — wariant „zaplacone" ma od
  // 2026-08-04 wlasna bariere (nizej), wiec zamowienie musi byc naprawde oplacone.
  const zestawOplacony = (nad = {}, dopiski = []) => {
    const { db, infakt, id, faktura } = zestaw(nad);
    for (const p of dopiski) dodajPozycjeReczna(db, id, parsujNowaPozycje(p));
    return { db, infakt, id, faktura };
  };

  it('data sprzedaży z formularza trafia do payloadu jako sale_date', async () => {
    const { infakt, faktura, id } = zestaw();
    await faktura.wystaw(id, { dataWystawienia: '2026-08-05', dataSprzedazy: '2026-08-03', termin: '14' });
    const p = infakt.wystaw.mock.calls[0][0];
    expect(p.sale_date).toBe('2026-08-03');
    // Data sprzedazy to NIE data wystawienia — caly powod, dla ktorego to pole w ogole jedzie.
    expect(p.invoice_date).toBe('2026-08-05');
  });

  it('bez daty sprzedaży w formularzu payload NIE niesie sale_date w ogóle', async () => {
    const { infakt, faktura, id } = zestaw();
    await faktura.wystaw(id, { dataWystawienia: '2026-08-05', termin: '14' });
    expect(infakt.wystaw.mock.calls[0][0]).not.toHaveProperty('sale_date');
  });

  // ⚠️ NAJWAZNIEJSZY TEST TEGO BLOKU. Zamowienie sklepowe na 123,00 zl PLUS pozycja dopisana
  // recznie za 80,00 zl: `kwota_brutto` to dalej 12300, a kwota OCZEKIWANA od klienta —
  // czyli ta, ktora sprawdzila bariera arytmetyczna i ktora klient naprawde zaplacil —
  // to 20300. Na zamowieniu bez dopisku obie liczby sa nieodroznialne i podmiana zrodla
  // niczego by nie zepsula.
  it('„zapłacone" niesie paid_price z kwoty OCZEKIWANEJ (z dopiskiem), nie z kwota_brutto', async () => {
    const { db, infakt, faktura, id } = zestawOplacony({}, [{ nazwa: 'Dopłata', ilosc: '1', cena_brutto: '80.00' }]);
    // Sklepowa wplata (123,00, z `oplacone_at`) PLUS doplata za dopisana pozycje = 203,00.
    dodajWplateReczna(db, id, { kwota: '80.00', data: '2026-08-03' });
    await faktura.wystaw(id, { dataWystawienia: '2026-08-05', dataSprzedazy: '2026-08-03', termin: 'zaplacone' });
    const p = infakt.wystaw.mock.calls[0][0];
    expect(p.paid_price).toBe(20300);
    expect(p.paid_price).not.toBe(12300);
    // „Zaplacone" to NIE termin platnosci — dokument ma mowic „pozostalo 0,00", a nie
    // podawac date, do kiedy zaplacic.
    expect(p).not.toHaveProperty('payment_date');
  });

  // Grosz w dol to dokument mowiacy „Zaplacono 202,99" przy sumie 203,00 — czyli klient
  // wisi grosz, ktorego nie wisi. Wartosc policzona jawnie, nie przepisana z kodu.
  it('paid_price zgadza się CO DO GROSZA z sumą pozycji na dokumencie', async () => {
    const { db, infakt, faktura, id } = zestawOplacony({}, [{ nazwa: 'Dopłata', ilosc: '1', cena_brutto: '80.00' }]);
    // Sklepowa wplata (123,00, z `oplacone_at`) PLUS doplata za dopisana pozycje = 203,00.
    dodajWplateReczna(db, id, { kwota: '80.00', data: '2026-08-03' });
    await faktura.wystaw(id, { dataWystawienia: '2026-08-05', termin: 'zaplacone' });
    const p = infakt.wystaw.mock.calls[0][0];
    const sumaPozycji = p.services.reduce((acc, s) => acc + s.gross_price, 0);
    expect(p.paid_price).toBe(sumaPozycji);
  });

  // ⚠️ ZACHOWANIE SPRZED CALEJ GALEZI. Wywolanie BEZ wyboru operatora ma dawac payload
  // dokladnie taki, jaki panel wysylal dotad — ani jednego pola wiecej. Sprawdzamy KOMPLET
  // kluczy, a nie brak kilku wybranych: `not.toHaveProperty` przepuscilby kazde nowe pole,
  // o ktorym ten test jeszcze nie wie.
  it('BEZ wyboru operatora payload to dokładnie { client_id, services } i nic więcej', async () => {
    const { infakt, faktura, id } = zestaw();
    await faktura.wystaw(id);
    const p = infakt.wystaw.mock.calls[0][0];
    expect(Object.keys(p).sort()).toEqual(['client_id', 'services']);
  });
});

// ⚠️ BARIERA O PIENIADZE, NIE O PORZADEK. `datyFaktury` sprawdza tylko KSZTALT kwoty
// (calkowita, dodatnia) — nigdy FAKTU zaplaty. Zmierzone przed ta poprawka: zamowienie
// z ZEREM wplat i wyborem „zaplacone" dawalo payload z `paid_price: 12300`, czyli dokument
// mowiacy „Zaplacono: 123,00 / Pozostalo: 0,00" przy zerze na koncie. Takiego dokumentu
// ksiegowego nie da sie poprawic — tylko skorygowac.
describe('faktura — „zapłacone" wymaga PRAWDZIWYCH wpłat', () => {
  // ⚠️ `oplacone_at: null` TO CALA TRESC „ZAMOWIENIA NIEOPLACONEGO" w tym module: przy
  // zapisie zamowienia panel odtwarza z tego pola wplate ZE SKLEPU na pelna kwote
  // (zsynchronizujWplateSklepu w db/platnosci.js). Fixture `zmapowane()` ma je USTAWIONE,
  // wiec zamowienie „bez dopisanych wplat" jest tam w rzeczywistosci oplacone w sklepie.
  const nieoplacone = (nad = {}) => zestaw({ oplacone_at: null, ...nad });

  it('zero wpłat + „zapłacone" → odmowa, inFakt nietknięty i BEZ rezerwacji', async () => {
    const { db, infakt, faktura, id } = nieoplacone();
    await expect(faktura.wystaw(id, { dataWystawienia: '2026-08-05', termin: 'zaplacone' }))
      .rejects.toThrow(/zapłacon/i);
    expect(infakt.wystaw).not.toHaveBeenCalled();
    expect(infakt.znajdzKlientaPoNip).not.toHaveBeenCalled();
    expect(wiersz(db, id)).toBeUndefined();
  });

  // Komunikat ma powiedziec, CO ZROBIC, a nie tylko ze sie nie da: najpierw dopisz wplate
  // na karcie, potem wystawiaj. Bez tego operator wybiera inny wariant i dokument klamie
  // w druga strone.
  it('komunikat podaje obie kwoty i mówi, żeby najpierw dopisać wpłatę na karcie', async () => {
    const { faktura, id } = nieoplacone();
    await expect(faktura.wystaw(id, { dataWystawienia: '2026-08-05', termin: 'zaplacone' }))
      .rejects.toThrow(/0\.00.*123\.00/s);
    await expect(faktura.wystaw(id, { dataWystawienia: '2026-08-05', termin: 'zaplacone' }))
      .rejects.toThrow(/wpłat/i);
  });

  it('odmowa jest otagowana dla operatora', async () => {
    const { faktura, id } = nieoplacone();
    await faktura.wystaw(id, { termin: 'zaplacone' }).catch((e) => expect(e.dlaOperatora).toBe(true));
    expect.assertions(1);
  });

  // NIEDOPLATA to nie zaplata. Miara jest kwota OCZEKIWANA (ze sklepu + dopiski), ta sama,
  // ktora liczy saldo na karcie — inaczej bariera i karta powiedzialyby co innego o tym
  // samym zamowieniu.
  it('niedopłata (122,99 przy 123,00) → odmowa', async () => {
    const { db, infakt, faktura, id } = nieoplacone();
    dodajWplateReczna(db, id, { kwota: '122.99', data: '2026-08-03' });
    await expect(faktura.wystaw(id, { termin: 'zaplacone' })).rejects.toThrow(/zapłacon/i);
    expect(infakt.wystaw).not.toHaveBeenCalled();
  });

  // ⚠️ Zamowienie OPLACONE W SKLEPIE (123,00), ktoremu operator dopisal pozycje za 80,00.
  // Prog to kwota OCZEKIWANA (203,00), wiec sklepowa wplata juz jej nie domyka — i dokladnie
  // po to te pozycje sie dopisuje. To najczestszy realny przypadek tej bariery.
  it('dopisana ręcznie pozycja PODNOSI próg — wpłata sklepowa przestaje wystarczać', async () => {
    const { db, infakt, faktura, id } = zestaw();
    dodajPozycjeReczna(db, id, parsujNowaPozycje({ nazwa: 'Dopłata', ilosc: '1', cena_brutto: '80.00' }));
    await expect(faktura.wystaw(id, { termin: 'zaplacone' })).rejects.toThrow(/203\.00/);
    expect(infakt.wystaw).not.toHaveBeenCalled();
  });

  it('pełne pokrycie PRZECHODZI — bariera nie blokuje faktury naprawdę opłaconej', async () => {
    const { db, infakt, faktura, id } = nieoplacone();
    dodajWplateReczna(db, id, { kwota: '123.00', data: '2026-08-03' });
    await faktura.wystaw(id, { termin: 'zaplacone' });
    expect(infakt.wystaw.mock.calls[0][0].paid_price).toBe(12300);
  });

  it('nadpłata też jest pokryciem — przechodzi', async () => {
    const { db, infakt, faktura, id } = nieoplacone();
    dodajWplateReczna(db, id, { kwota: '200.00', data: '2026-08-03' });
    await faktura.wystaw(id, { termin: 'zaplacone' });
    // Na dokument idzie kwota NALEZNA, nie wplacona — nadplata jest sprawa salda, nie faktury.
    expect(infakt.wystaw.mock.calls[0][0].paid_price).toBe(12300);
  });

  // ⚠️ BARIERA DOTYCZY WYLACZNIE WARIANTU „ZAPLACONE". Brak wplaty NIE blokuje zwyklej
  // faktury z terminem — to sklep B2B i tam jest to norma (patrz odmowy nizej).
  it('brak wpłat NIE blokuje faktury z terminem 14 dni', async () => {
    const { infakt, faktura, id } = nieoplacone();
    await faktura.wystaw(id, { dataWystawienia: '2026-08-05', termin: '14' });
    expect(infakt.wystaw).toHaveBeenCalledTimes(1);
  });

  it('brak wpłat NIE blokuje wariantu „bez terminu"', async () => {
    const { infakt, faktura, id } = nieoplacone();
    await faktura.wystaw(id, { dataWystawienia: '2026-08-05', termin: 'bez_terminu' });
    expect(infakt.wystaw).toHaveBeenCalledTimes(1);
  });

  // Alias krotki z formularza ma trafic na te sama bariere — inaczej „oplacone" byloby
  // cicha objazdowka wokol niej.
  it('alias „oplacone" trafia na tę samą barierę', async () => {
    const { infakt, faktura, id } = nieoplacone();
    await expect(faktura.wystaw(id, { termin: 'oplacone' })).rejects.toThrow(/zapłacon/i);
    expect(infakt.wystaw).not.toHaveBeenCalled();
  });
});

// BARIERA ARYTMETYCZNA. Sprawdza WYNIK, nie zalozenia — to jedyna tania ochrona przed
// wyslaniem zlego, nieodwracalnego dokumentu do KSeF.
describe('faktura — bariera arytmetyczna', () => {
  it('suma pozycji ≠ kwota zamówienia → odmowa i inFakt nietknięty', async () => {
    // 2 x 61,50 = 123,00, a zamowienie opiewa na 141,45 — brakuje 18,45 zl dostawy.
    const { infakt, faktura, id } = zestaw({ kwota_brutto: '141.45', koszt_dostawy_brutto: null });
    await expect(faktura.wystaw(id)).rejects.toThrow(/nie zgadza się/i);
    expect(infakt.wystaw).not.toHaveBeenCalled();
    expect(infakt.znajdzKlientaPoNip).not.toHaveBeenCalled();
  });

  it('komunikat podaje OBIE kwoty', async () => {
    const { faktura, id } = zestaw({ kwota_brutto: '141.45', koszt_dostawy_brutto: null });
    await expect(faktura.wystaw(id)).rejects.toThrow(/123\.00.*141\.45/s);
  });

  // Zaokraglenie: 33,33 x 3 = 99,99, a zamowienie opiewa na 100,00. Roznica jednego grosza
  // jest niewidoczna golym okiem i wlasnie dlatego musi ja lapac maszyna.
  it('łapie różnicę jednego grosza z zaokrąglenia (33,33 × 3 vs 100,00)', async () => {
    const { infakt, faktura, id } = zestaw({
      kwota_brutto: '100.00', koszt_dostawy_brutto: null,
      pozycje: [{ nazwa: 'X', sku: null, ilosc: 3, cena_brutto: '33.33', vat: null }],
    });
    await expect(faktura.wystaw(id)).rejects.toThrow(/99\.99/);
    expect(infakt.wystaw).not.toHaveBeenCalled();
  });

  it('odmowa bariery NIE zostawia rezerwacji w tabeli faktur', async () => {
    const { db, faktura, id } = zestaw({ kwota_brutto: '141.45', koszt_dostawy_brutto: null });
    await expect(faktura.wystaw(id)).rejects.toThrow();
    expect(wiersz(db, id)).toBeUndefined();
  });

  // grosze(null) dawalo NaN, a NaN w JSON-ie staje sie `null` — czyli pozycja bez ceny
  // poleciałaby do inFaktu bez jednego ostrzezenia.
  it('pusta cena pozycji rzuca czytelnie, zamiast wysłać NaN', async () => {
    const { infakt, faktura, id } = zestaw({
      pozycje: [{ nazwa: 'X', sku: null, ilosc: 1, cena_brutto: '', vat: null }],
    });
    await expect(faktura.wystaw(id)).rejects.toThrow(/Brak kwoty.*"X"/);
    expect(infakt.wystaw).not.toHaveBeenCalled();
  });

  it('nieliczbowa cena pozycji rzuca czytelnie', async () => {
    const { faktura, id } = zestaw({
      pozycje: [{ nazwa: 'X', sku: null, ilosc: 1, cena_brutto: 'dużo', vat: null }],
    });
    await expect(faktura.wystaw(id)).rejects.toThrow(/nie jest liczbą/);
  });

  // JEDYNA dziura w barierze: zamowienie na 0,00 zl bez ani jednej pozycji przechodzilo ja
  // bezblednie (suma pustej listy = 0 = kwota zamowienia), wiec do inFaktu leciala faktura
  // z pustym `services`. Dokument bez pozycji tez ląduje w KSeF i tez wymaga korekty.
  it('zamówienie bez pozycji → odmowa, mimo że suma 0 zgadza się z kwotą 0', async () => {
    const { db, infakt, faktura, id } = zestaw({ kwota_brutto: '0.00', koszt_dostawy_brutto: '0.00', pozycje: [] });
    await expect(faktura.wystaw(id)).rejects.toThrow(/pozycji/i);
    expect(infakt.wystaw).not.toHaveBeenCalled();
    expect(infakt.znajdzKlientaPoNip).not.toHaveBeenCalled();
    expect(wiersz(db, id)).toBeUndefined();
  });

  // Sama dostawa to POPRAWNA faktura (np. dopłata do transportu) — odmowa ma dotyczyć
  // pustej listy, a nie braku pozycji towarowych.
  it('zamówienie na samą dostawę przechodzi', async () => {
    const { infakt, faktura, id } = zestaw({ kwota_brutto: '18.45', koszt_dostawy_brutto: '18.45', pozycje: [] });
    await faktura.wystaw(id);
    expect(infakt.wystaw.mock.calls[0][0].services).toHaveLength(1);
  });
});

// ⚠️ POZYCJE DOPISANE RĘCZNIE A FAKTURA. Bariera porównuje sumę pozycji z KWOTĄ OCZEKIWANĄ
// OD KLIENTA (kwota ze sklepu + dopiski), a nie z samą `kwota_brutto` — inaczej każde
// zamówienie z dopłatą odmawiałoby wystawienia faktury, czyli dokładnie te, przy których
// dopłata musi się na fakturze znaleźć.
describe('faktura — pozycje dopisane i poprawione ręcznie', () => {
  function zestawZDopiskiem(nad = {}, dopiski = [], nadpisania = null) {
    const { db, infakt, id, faktura } = zestaw(nad);
    for (const p of dopiski) dodajPozycjeReczna(db, id, parsujNowaPozycje(p));
    if (nadpisania) zapiszNadpisaniaPozycji(db, id, nadpisania);
    return { db, infakt, id, faktura };
  }

  it('zamówienie z dopisaną pozycją PRZECHODZI barierę', async () => {
    const { infakt, faktura, id } = zestawZDopiskiem({}, [{ nazwa: 'Dopłata', ilosc: '1', cena_brutto: '80.00' }]);
    await faktura.wystaw(id);
    expect(infakt.wystaw).toHaveBeenCalledTimes(1);
  });

  it('dopisana pozycja TRAFIA na fakturę, z własną nazwą, ilością i kwotą brutto', async () => {
    const { infakt, faktura, id } = zestawZDopiskiem({}, [{ nazwa: 'Dodatkowy szablon', ilosc: '2', cena_brutto: '40.00' }]);
    await faktura.wystaw(id);
    const s = infakt.wystaw.mock.calls[0][0].services;
    expect(s).toHaveLength(2);
    // `gross_price` to SUMA LINII (2 × 40,00 = 80,00), nie cena za sztukę.
    expect(s[1]).toEqual({ name: 'Dodatkowy szablon', quantity: 2, gross_price: 8000, tax_symbol: '23' });
  });

  it('do inFaktu idzie BRUTTO dopisanej pozycji — netto liczy inFakt, nie panel', async () => {
    const { infakt, faktura, id } = zestawZDopiskiem({}, [{ nazwa: 'Dopłata', ilosc: '1', cena_brutto: '80.00' }]);
    await faktura.wystaw(id);
    const [poz] = infakt.wystaw.mock.calls[0][0].services.slice(-1);
    expect(poz.gross_price).toBe(8000);
    // Gdyby ktoś wysłał tu netto policzone ze stawki VAT, byłoby 6504.
    expect(poz.gross_price).not.toBe(6504);
    expect(poz).not.toHaveProperty('net_price');
  });

  it('poprawiona ręcznie pozycja sklepowa jedzie na fakturę w wersji POPRAWIONEJ', async () => {
    const { infakt, faktura, id } = zestawZDopiskiem({}, [], { p0: { ilosc: 3, nazwa: 'STOP (3 szt.)' } });
    await faktura.wystaw(id);
    const [poz] = infakt.wystaw.mock.calls[0][0].services;
    expect(poz).toEqual({ name: 'STOP (3 szt.)', quantity: 3, gross_price: 18450, tax_symbol: '23' });
  });

  // ⚠️ BARIERA NIE SŁABNIE. Dopisek przesuwa OBIE strony porównania o tę samą wartość, więc
  // prawdziwy rozjazd danych ze sklepu dalej jest łapany.
  it('bariera dalej odmawia, gdy linie ZE SKLEPU nie sumują się do kwoty zamówienia', async () => {
    const { infakt, faktura, id } = zestawZDopiskiem(
      { kwota_brutto: '141.45', koszt_dostawy_brutto: null },
      [{ nazwa: 'Dopłata', ilosc: '1', cena_brutto: '80.00' }],
    );
    await expect(faktura.wystaw(id)).rejects.toThrow(/nie zgadza się/i);
    expect(infakt.wystaw).not.toHaveBeenCalled();
  });
});

// C1. Dokument w KSeF jest NIEODWRACALNY, wiec o tym, czy poleci drugi, musi rozstrzygac
// baza — a nie kolejnosc odczytow w kodzie.
describe('faktura — jedna faktura na zamówienie', () => {
  it('zapisuje numer i uuid przy zamówieniu', async () => {
    const { db, faktura, id } = zestaw();
    await faktura.wystaw(id);
    const z = pobierzZamowienie(db, id);
    expect(z.faktura.numer).toBe('FV/1/2026');
    expect(z.faktura.infakt_uuid).toBe('u1');
    expect(z.faktura.ksef_status).toBe('sent');
  });

  it('drugie wystawienie odmawia i nie woła inFaktu', async () => {
    const { infakt, faktura, id } = zestaw();
    await faktura.wystaw(id);
    await expect(faktura.wystaw(id)).rejects.toThrow(/już wystawiona/i);
    expect(infakt.wystaw).toHaveBeenCalledTimes(1);
  });

  // NAJWAZNIEJSZY test tego pliku. Dwuklik w formularzu to normalne zachowanie czlowieka,
  // a przycisk nie jest blokowany. Przed poprawka obie proby dochodzily do inFaktu i
  // powstawaly DWA dokumenty w KSeF, a operator dostawal na ekran komunikat sterownika SQLite.
  it('dwa równoległe wystawienia → tylko JEDEN dokument', async () => {
    const { infakt, faktura, id } = zestaw();
    const wyniki = await Promise.allSettled([faktura.wystaw(id), faktura.wystaw(id)]);
    expect(infakt.wystaw).toHaveBeenCalledTimes(1);
    expect(wyniki.filter((w) => w.status === 'fulfilled')).toHaveLength(1);
    const odrzucone = wyniki.find((w) => w.status === 'rejected');
    expect(odrzucone.reason.dlaOperatora).toBe(true);
    expect(odrzucone.reason.message).toMatch(/trwa|już wystawiona/i);
  });

  // Awaria NIEJEDNOZNACZNA (zerwane polaczenie, 5xx): dokument MOGL powstac i panel nie ma
  // jak tego sprawdzic. Ponowienie byloby drugim dokumentem w rejestrze panstwowym.
  it('zerwane połączenie → stan „do wyjaśnienia” i BRAK ponowienia', async () => {
    const wystawAtrapa = vi.fn().mockRejectedValue(new Error('inFakt nieosiągalny: fetch failed'));
    const { db, infakt, faktura, id } = zestaw({}, { wystaw: wystawAtrapa });

    await expect(faktura.wystaw(id)).rejects.toThrow(/nieosiągalny/);
    expect(wiersz(db, id).ksef_status).toBe('do_wyjasnienia');

    await expect(faktura.wystaw(id)).rejects.toThrow(/RĘCZNIE w inFakcie/);
    expect(infakt.wystaw).toHaveBeenCalledTimes(1);
  });

  // Awaria JEDNOZNACZNA (4xx): inFakt odpowiedzial i odrzucil, dokumentu na pewno nie ma.
  // Miejsce musi sie zwolnic, inaczej zamowienie zostaje bez faktury na zawsze.
  it('odmowa 4xx zwalnia miejsce — po poprawieniu danych da się ponowić', async () => {
    const wystawAtrapa = vi.fn()
      .mockRejectedValueOnce(bladApi('inFakt odrzucił fakturę (422): Proszę wybrać klienta', 422))
      .mockResolvedValue({ uuid: 'u2', numer: 'FV/2/2026', ksefStatus: 'sent' });
    const { db, faktura, id } = zestaw({}, { wystaw: wystawAtrapa });

    await expect(faktura.wystaw(id)).rejects.toThrow(/Proszę wybrać klienta/);
    expect(wiersz(db, id)).toBeUndefined();

    await faktura.wystaw(id);
    expect(pobierzZamowienie(db, id).faktura.numer).toBe('FV/2/2026');
    expect(wystawAtrapa).toHaveBeenCalledTimes(2);
  });

  // I3. Nieudana proba bez sladu w logu byla najgorszym z mozliwych stanow: przycisk
  // zostawal, historia byla pusta, a dokument mogl juz istniec.
  it('każda awaria zostawia wpis w logu zamówienia', async () => {
    const wystawAtrapa = vi.fn().mockRejectedValue(new Error('inFakt nieosiągalny: fetch failed'));
    const { db, faktura, id } = zestaw({}, { wystaw: wystawAtrapa });
    await expect(faktura.wystaw(id)).rejects.toThrow();
    const wpisy = log(db, id).filter((w) => w.akcja === 'faktura');
    expect(wpisy).toHaveLength(1);
    expect(wpisy[0].wynik).toMatch(/DO WYJAŚNIENIA/);
  });

  it('sukces też trafia do logu, razem z numerem', async () => {
    const { db, faktura, id } = zestaw();
    await faktura.wystaw(id);
    expect(log(db, id).find((w) => w.akcja === 'faktura').wynik).toBe('FV/1/2026');
  });
});

// FALSZYWA BLOKADA. Blokada po awarii jest sluszna WYLACZNIE tam, gdzie dokument mogl
// powstac — czyli w `infakt.wystaw`. Stary wspolny `catch` obejmowal takze wyszukanie
// i zalozenie klienta, a rozstrzygal po `e.status`, wiec przebiegi z ZEREM wywolan
// `infakt.wystaw` konczyly sie stanem 'do_wyjasnienia' i wieczna blokada zamowienia.
describe('faktura — awaria PRZED wystawieniem nie blokuje zamówienia', () => {
  const bezStatusu = (komunikat) => Object.assign(new Error(komunikat), { dlaOperatora: true });

  // Przypadek CODZIENNY przy kartotece z ~275 wpisow zakladanych latami: blad czysto
  // lokalny, rzucany bez `status`, naprawialny w inFakcie w pol minuty. Operator czytal
  // na ekranie ostrzezenie o dokumencie, o ktory nigdy nie poproszono.
  it('duplikat NIP-u w kartotece → zwolnienie i ponowienie po naprawie w inFakcie', async () => {
    const znajdz = vi.fn()
      .mockRejectedValueOnce(bezStatusu('W kartotece inFaktu są 2 wpisy z NIP-em 1000001201 — panel nie zgadnie, który jest nabywcą.'))
      .mockResolvedValue(7);
    const { db, infakt, faktura, id } = zestaw({}, { znajdz });

    await expect(faktura.wystaw(id)).rejects.toThrow(/nie zgadnie/);
    expect(infakt.wystaw).not.toHaveBeenCalled();
    expect(wiersz(db, id)).toBeUndefined();

    await faktura.wystaw(id);
    expect(pobierzZamowienie(db, id).faktura.numer).toBe('FV/1/2026');
  });

  // GET /clients.json niczego nie wystawia — zerwana siec na nim nie moze zostawic
  // podejrzenia o dokument w KSeF.
  it('zerwane połączenie na wyszukaniu klienta → zwolnienie, nie „do wyjaśnienia”', async () => {
    const znajdz = vi.fn().mockRejectedValue(bezStatusu('inFakt nieosiągalny: fetch failed'));
    const { db, infakt, faktura, id } = zestaw({}, { znajdz });
    await expect(faktura.wystaw(id)).rejects.toThrow(/nieosiągalny/);
    expect(infakt.wystaw).not.toHaveBeenCalled();
    expect(wiersz(db, id)).toBeUndefined();
  });

  // 500 z zakladania klienta jest niejednoznaczne co do WPISU W KARTOTECE, ale nie co do
  // faktury: o fakture jeszcze nie poprosilismy. Najwyzej powstanie duplikat kontrahenta.
  it('500 z zakładania klienta → zwolnienie, nie „do wyjaśnienia”', async () => {
    const zaloz = vi.fn().mockRejectedValue(Object.assign(new Error('inFakt odrzucił założenie klienta (500)'), { dlaOperatora: true, status: 500 }));
    const { db, infakt, faktura, id } = zestaw({}, { zaloz });
    await expect(faktura.wystaw(id)).rejects.toThrow(/500/);
    expect(infakt.wystaw).not.toHaveBeenCalled();
    expect(wiersz(db, id)).toBeUndefined();
  });

  it('brak identyfikatora nabywcy → zwolnienie', async () => {
    const zaloz = vi.fn().mockResolvedValue(null);
    const { db, infakt, faktura, id } = zestaw({}, { zaloz });
    await expect(faktura.wystaw(id)).rejects.toThrow(/identyfikatora nabywcy/);
    expect(infakt.wystaw).not.toHaveBeenCalled();
    expect(wiersz(db, id)).toBeUndefined();
  });

  it('awaria fazy przygotowania trafia do logu jako BŁĄD, nie jako DO WYJAŚNIENIA', async () => {
    const znajdz = vi.fn().mockRejectedValue(bezStatusu('inFakt nieosiągalny: fetch failed'));
    const { db, faktura, id } = zestaw({}, { znajdz });
    await expect(faktura.wystaw(id)).rejects.toThrow();
    const wpis = log(db, id).find((w) => w.akcja === 'faktura');
    expect(wpis.wynik).toMatch(/^BŁĄD:/);
    expect(wpis.wynik).not.toMatch(/DO WYJAŚNIENIA/);
  });

  // DRUGA STRONA tej samej granicy i najwazniejszy test bloku: podzial faz NIE MA prawa
  // rozluznic blokady tam, gdzie dokument naprawde mogl powstac. Awaria w samym
  // `infakt.wystaw` — z `status` albo bez — dalej blokuje ponowienie.
  it('5xx z SAMEGO wystawiania nadal blokuje ponowienie', async () => {
    const wystawAtrapa = vi.fn().mockRejectedValue(Object.assign(new Error('inFakt odrzucił fakturę (503)'), { dlaOperatora: true, status: 503 }));
    const { db, infakt, faktura, id } = zestaw({}, { wystaw: wystawAtrapa });
    await expect(faktura.wystaw(id)).rejects.toThrow(/503/);
    expect(wiersz(db, id).ksef_status).toBe('do_wyjasnienia');
    await expect(faktura.wystaw(id)).rejects.toThrow(/RĘCZNIE w inFakcie/);
    expect(infakt.wystaw).toHaveBeenCalledTimes(1);
  });

  it('błąd bez statusu z SAMEGO wystawiania nadal blokuje ponowienie', async () => {
    const wystawAtrapa = vi.fn().mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'uuid')"));
    const { db, infakt, faktura, id } = zestaw({}, { wystaw: wystawAtrapa });
    await expect(faktura.wystaw(id)).rejects.toThrow();
    expect(wiersz(db, id).ksef_status).toBe('do_wyjasnienia');
    await expect(faktura.wystaw(id)).rejects.toThrow(/RĘCZNIE w inFakcie/);
    expect(infakt.wystaw).toHaveBeenCalledTimes(1);
  });
});

describe('faktura — odmowy przed dotknięciem inFaktu', () => {
  // C2. Faktura do anulowanego zamowienia trafia do KSeF i wymaga korekty, czyli drugiego
  // dokumentu i wizyty w ksiegowosci. Odmowa jest TWARDA, bo karta w przegladarce pokazuje
  // stan sprzed sekund — klient moze anulowac dokladnie wtedy, gdy operator ma ja otwarta.
  it('zamówienie ANULOWANE → odmowa i inFakt nietknięty', async () => {
    const { infakt, db, faktura, id } = zestaw({ anulowane: 1 });
    await expect(faktura.wystaw(id)).rejects.toThrow(/anulowane/i);
    expect(infakt.wystaw).not.toHaveBeenCalled();
    expect(infakt.znajdzKlientaPoNip).not.toHaveBeenCalled();
    expect(wiersz(db, id)).toBeUndefined();
  });

  it('zamówienie bez zaznaczonej faktury → odmowa', async () => {
    const { infakt, faktura, id } = zestaw({ chce_fakture: 0 });
    await expect(faktura.wystaw(id)).rejects.toThrow(/nie prosił/i);
    expect(infakt.wystaw).not.toHaveBeenCalled();
  });

  // Decyzja projektowa, taka sama jak przy nadaniu: to sklep B2B, faktura z terminem
  // platnosci jest tam norma. Blokada zmuszalaby operatora do falszywego oznaczania wplat.
  it('brak opłacenia NIE blokuje wystawienia', async () => {
    const { infakt, faktura, id } = zestaw({ oplacone_at: null });
    await faktura.wystaw(id);
    expect(infakt.wystaw).toHaveBeenCalledTimes(1);
  });

  it('nieistniejące zamówienie → czytelna odmowa', async () => {
    const { faktura } = zestaw();
    await expect(faktura.wystaw(99999)).rejects.toThrow(/Nie ma takiego zamówienia/);
  });

  // Wszystkie odmowy sa pisane dla czlowieka przy panelu, wiec musza byc otagowane —
  // inaczej trasa zamieni je na "blad techniczny panelu" i operator nie dowie sie, co poprawic.
  it('odmowy są otagowane jako przeznaczone dla operatora', async () => {
    const { faktura, id } = zestaw({ anulowane: 1 });
    await faktura.wystaw(id).catch((e) => expect(e.dlaOperatora).toBe(true));
    expect.assertions(1);
  });
});

// ⚠️ USTERKA ZGLOSZONA PRZEZ WLASCICIELA (06.08.2026): faktura wystawiona z panelu jako
// „zaplacona" ma w inFakcie status „nieoplacona". Odczyt 60 ostatnich faktur z zywego konta:
// nasze dokumenty maja `paid_price: 15800`, `left_to_pay: 0` (czyli DOKUMENT DLA KLIENTA
// jest poprawny i drukuje „Zaplacono"), ale `paid_date: null` i `status: 'sent'`. Faktura
// oplacona z reki inFaktu ma `paid_date` wypelnione i `status: 'paid'`.
//
// Czyli: `paid_price` w payloadzie zalatwia TRESC dokumentu, a status na liscie faktur
// przestawia dopiero osobne, ASYNCHRONICZNE wywolanie. Potrzebne sa OBA i zadne nie
// zastepuje drugiego.
//
// ⚠️ CALY TEN BLOK PILNUJE JEDNEJ RZECZY: to jest krok PO NIEODWRACALNYM. W chwili tego
// wywolania dokument w inFakcie JUZ ISTNIEJE i ma miejsce w numeracji. Awaria oznaczenia
// ma dac dokladnie dzisiejszy stan rzeczy (zly status w inFakcie) i ANI GRAMA wiecej —
// nigdy wyjatku u operatora i nigdy rezerwacji zostawionej w zlym stanie.
describe('faktura — oznaczenie „zapłacone" w inFakcie (krok PO nieodwracalnym)', () => {
  const nieoplacone = (nad = {}, atrapy = {}) => zestaw({ oplacone_at: null, ...nad }, atrapy);

  it('wariant „zapłacone" zleca oznaczenie dokumentu, który właśnie powstał', async () => {
    const { infakt, faktura, id } = zestaw();
    await faktura.wystaw(id, { dataWystawienia: '2026-08-06', termin: 'zaplacone' });
    expect(infakt.oznaczZaplacona).toHaveBeenCalledTimes(1);
    // uuid MUSI byc ten z odpowiedzi `wystaw`, nie wziety skadinad.
    expect(infakt.oznaczZaplacona.mock.calls[0][0]).toBe('u1');
  });

  // Alias krotki z formularza ma isc ta sama droga — inaczej „oplacone" zostawaloby
  // w inFakcie nieoplacone, czyli dokladnie ta usterka, tylko na jednym wariancie.
  it('alias „oplacone" też zleca oznaczenie', async () => {
    const { infakt, faktura, id } = zestaw();
    await faktura.wystaw(id, { termin: 'oplacone' });
    expect(infakt.oznaczZaplacona).toHaveBeenCalledTimes(1);
  });

  // ⚠️ NAJWAZNIEJSZA ODMOWA TEGO BLOKU. Faktura z terminem platnosci MA zostac nieoplacona —
  // to jest PRAWDA o niej, a nie usterka. Oznaczenie jej jako zaplaconej zrobiloby z listy
  // naleznosci w inFakcie fikcje: wlasciciel przestalby widziec, kto mu jeszcze nie zaplacil.
  it('termin 14 dni NIE zleca oznaczenia — ta faktura ma zostać nieopłacona', async () => {
    const { infakt, faktura, id } = zestaw();
    await faktura.wystaw(id, { dataWystawienia: '2026-08-06', termin: '14' });
    expect(infakt.wystaw).toHaveBeenCalledTimes(1);
    expect(infakt.oznaczZaplacona).not.toHaveBeenCalled();
  });

  it('wariant „bez terminu" NIE zleca oznaczenia', async () => {
    const { infakt, faktura, id } = zestaw();
    await faktura.wystaw(id, { dataWystawienia: '2026-08-06', termin: 'bez_terminu' });
    expect(infakt.oznaczZaplacona).not.toHaveBeenCalled();
  });

  it('„przy odbiorze" NIE zleca oznaczenia — pieniądze przyjdą dopiero przy doręczeniu', async () => {
    const { infakt, faktura, id } = zestaw();
    await faktura.wystaw(id, { dataWystawienia: '2026-08-06', termin: 'przy_odbiorze' });
    expect(infakt.oznaczZaplacona).not.toHaveBeenCalled();
  });

  // Wywolanie BEZ wyboru operatora ma dzialac dokladnie tak, jak dzialalo przed ta zmiana.
  it('wystawienie bez wyboru terminu NIE zleca oznaczenia', async () => {
    const { infakt, faktura, id } = zestaw();
    await faktura.wystaw(id);
    expect(infakt.oznaczZaplacona).not.toHaveBeenCalled();
  });

  // ⚠️ WARUNEK Z DOKUMENTACJI: `paid_date` „nie wczesniejsza niz data wystawienia". Zamowienie
  // oplacone w sklepie 29.07 i zafakturowane 6.08 dalo by date wczesniejsza — czyli odmowe
  // i status, ktory mial sie naprawic, dalej zly. Bierzemy PÓZNIEJSZA z dwoch.
  it('wpłata WCZEŚNIEJSZA niż data wystawienia → paid_date = data wystawienia', async () => {
    // Fixture ma `oplacone_at: '2026-07-29T13:00:00'`, czyli wplate sklepowa z 29.07.
    const { infakt, faktura, id } = zestaw();
    await faktura.wystaw(id, { dataWystawienia: '2026-08-06', termin: 'zaplacone' });
    expect(infakt.oznaczZaplacona.mock.calls[0][1]).toEqual({ paidDate: '2026-08-06' });
  });

  // Druga strona tej samej reguly: gdy pieniadze przyszly PÓZNIEJ niz data na dokumencie
  // (operator wystawia wsteczna data), prawda o zaplacie jest dniem wplaty i to on jedzie.
  it('wpłata PÓŹNIEJSZA niż data wystawienia → paid_date = dzień wpłaty', async () => {
    const { db, infakt, faktura, id } = nieoplacone();
    dodajWplateReczna(db, id, { kwota: '123.00', data: '2026-08-06' });
    await faktura.wystaw(id, { dataWystawienia: '2026-08-05', termin: 'zaplacone' });
    expect(infakt.oznaczZaplacona.mock.calls[0][1]).toEqual({ paidDate: '2026-08-06' });
  });

  // Data wplaty to NASZ znacznik albo data z formularza — dzien liczy `dzienWarszawa`, tak
  // samo jak date sprzedazy (domain/data-sprzedazy.js). 23:40 UTC to w Warszawie latem juz
  // nastepny dzien, a pomylka o dobe w druga strone daje date sprzed wystawienia i odmowe.
  it('dzień wpłaty liczony w czasie WARSZAWSKIM, nie z gołego napisu UTC', async () => {
    const { db, infakt, faktura, id } = nieoplacone();
    dodajWplateReczna(db, id, { kwota: '123.00', data: '2026-08-06T23:40:00Z' });
    await faktura.wystaw(id, { dataWystawienia: '2026-08-05', termin: 'zaplacone' });
    expect(infakt.oznaczZaplacona.mock.calls[0][1]).toEqual({ paidDate: '2026-08-07' });
  });

  // ⚠️ TEST, KTORY TRZYMA CALA KONSTRUKCJE. Dokument JUZ ISTNIEJE — rzucenie stad wywalilo by
  // operatorowi operacje, ktora SIE UDALA, i zostawilo rezerwacje w zlym stanie.
  it('awaria oznaczenia NIE psuje wystawienia — faktura jest wystawiona i zapisana', async () => {
    const oznacz = vi.fn().mockRejectedValue(bladApi('inFakt odrzucił oznaczenie faktury jako zapłaconej (404): bez szczegółów (HTTP 404)', 404));
    const { db, faktura, id } = zestaw({}, { oznacz });
    const w = await faktura.wystaw(id, { dataWystawienia: '2026-08-06', termin: 'zaplacone' });
    expect(w.numer).toBe('FV/1/2026');
    const f = wiersz(db, id);
    expect(f.numer).toBe('FV/1/2026');
    expect(f.infakt_uuid).toBe('u1');
    // Rezerwacja jest ZAMKNIETA, a nie zostawiona w stanie wymagajacym czlowieka.
    expect(f.ksef_status).toBe('sent');
    expect(stanFaktury(f)).toBe('wystawiona');
  });

  // Nawet blad NASZEGO kodu (nie odpowiedz inFaktu) nie ma prawa wywalic kroku po
  // nieodwracalnym — lapiemy WSZYSTKO, nie tylko `bladOperatora`.
  it('nawet TypeError z tego wywołania nie psuje wystawienia', async () => {
    const oznacz = vi.fn().mockRejectedValue(new TypeError('oznaczZaplacona is not a function'));
    const { db, faktura, id } = zestaw({}, { oznacz });
    await expect(faktura.wystaw(id, { dataWystawienia: '2026-08-06', termin: 'zaplacone' })).resolves.toBeTruthy();
    expect(stanFaktury(wiersz(db, id))).toBe('wystawiona');
  });

  // Skutek nieudanego oznaczenia jest WYLACZNIE informacyjny, wiec log zamowienia jest
  // JEDYNYM miejscem, z ktorego wlasciciel sie o tym dowie. Ma tam byc: ze faktura jest
  // wystawiona, ze dokument dla klienta jest poprawny, co dokladnie nie wyszlo i co zrobic.
  it('nieudane oznaczenie zostawia w logu ostrzeżenie z powodem i numerem faktury', async () => {
    const oznacz = vi.fn().mockRejectedValue(bladApi('inFakt odrzucił oznaczenie faktury jako zapłaconej (404): bez szczegółów (HTTP 404)', 404));
    const { db, faktura, id } = zestaw({}, { oznacz });
    await faktura.wystaw(id, { dataWystawienia: '2026-08-06', termin: 'zaplacone' });
    const wpisy = log(db, id).filter((w) => w.akcja === 'faktura');
    // Numer faktury zostaje PIERWSZYM wpisem — ostrzezenie go nie wypiera.
    expect(wpisy[0].wynik).toBe('FV/1/2026');
    expect(wpisy[1].wynik).toMatch(/^UWAGA:/);
    expect(wpisy[1].wynik).toContain('FV/1/2026');
    expect(wpisy[1].wynik).toContain('HTTP 404');
    expect(wpisy[1].wynik).toMatch(/nieopłacon/i);
  });

  // ⚠️ 201 ZNACZY „PRZYJETO ZLECENIE", NIE „ZROBIONE". Log nie ma prawa twierdzic, ze status
  // sie zmienil — bo tego nie wiemy i nie sprawdzamy.
  it('udane oznaczenie mówi w logu „zlecono", a nie „oznaczono"', async () => {
    const { db, faktura, id } = zestaw();
    await faktura.wystaw(id, { dataWystawienia: '2026-08-06', termin: 'zaplacone' });
    const wpisy = log(db, id).filter((w) => w.akcja === 'faktura');
    expect(wpisy[1].wynik).toMatch(/zlecono/i);
    expect(wpisy[1].wynik).not.toMatch(/oznaczono/i);
    expect(wpisy[1].wynik).toContain('2026-08-06');
  });

  // Kolejnosc: wiersz faktury MUSI byc juz zapisany, zanim ruszy oznaczenie. Inaczej awaria
  // (albo zwis) tego kroku zostawialaby rezerwacje w stanie 'w_toku' przy dokumencie, ktory
  // od dawna istnieje — czyli zamowienie zablokowane za operacje, ktora sie udala.
  it('oznaczenie idzie DOPIERO po zapisaniu wiersza faktury', async () => {
    // Atrapa musi zajrzec do bazy W TRAKCIE wywolania, a `db` i `id` powstaja dopiero
    // w `zestaw()` — stad wspolny uchwyt zamiast domkniecia po zmiennych.
    const ctx = {};
    const oznacz = vi.fn(async () => {
      ctx.wiersz = wiersz(ctx.db, ctx.id);
      return { referencja: 'r' };
    });
    const { db, faktura, id } = zestaw({}, { oznacz });
    ctx.db = db;
    ctx.id = id;
    await faktura.wystaw(id, { dataWystawienia: '2026-08-06', termin: 'zaplacone' });
    expect(ctx.wiersz.numer).toBe('FV/1/2026');
    expect(stanFaktury(ctx.wiersz)).toBe('wystawiona');
  });
});
