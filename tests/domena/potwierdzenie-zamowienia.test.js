import { describe, it, expect } from 'vitest';
import {
  trescPotwierdzenia, czyWolnoWyslacPotwierdzenie, adresatPotwierdzenia,
} from '../pomoc/potwierdzenie-parytetu.js';

const zam = (nad = {}) => ({
  numer: '202600014',
  utworzone_at: '2026-08-21T09:15:00Z',
  sklep: 'reczne',
  kwota_brutto: '243.70',
  koszt_dostawy_brutto: '19.00',
  koszt_dostawy_netto: '15.45',
  metoda_wysylki: 'dpd',
  metoda_platnosci: 'Przelew',
  chce_fakture: 0,
  anulowane: 0,
  klient: { email: 'klient@firma.pl', phone: '600100200' },
  dostawa: { first_name: 'Jan', last_name: 'Kowalski', company: 'BETAMET sp. z o.o.', address_1: 'Fabryczna 4', postcode: '00-650', city: 'Pęki' },
  pozycje: [
    { nazwa: 'Lampa stołowa Grzybek 30x45', sku: 'LMP-GRZ-30', ilosc: 3, cena_brutto: '74.90', brutto_linii: '224.70' },
  ],
  ...nad,
});

describe('adresat potwierdzenia', () => {
  it('bierze adres zamawiającego', () => {
    expect(adresatPotwierdzenia(zam())).toBe('klient@firma.pl');
  });

  // ⚠️ Mail z faktury bywa adresem KSIEGOWOSCI — potwierdzenie jest dla osoby, ktora zamowila.
  it('adres z faktury dopiero wtedy, gdy zamawiający go nie podał', () => {
    const z = zam({
      klient: { email: null },
      klient_reczny_json: JSON.stringify({ email: 'ksiegowosc@firma.pl' }),
    });
    expect(adresatPotwierdzenia(z)).toBe('ksiegowosc@firma.pl');
  });
});

describe('kiedy NIE wolno wysłać', () => {
  // ⚠️ Mail „potwierdzamy przyjecie" do zamowienia, ktore wlasnie anulowalismy, jest GORSZY
  // niz brak maila: klient potwierdza cos, czego nie ma, i dzwoni o to, co my juz wiemy.
  it('zamówienie anulowane → odmowa', () => {
    const zgoda = czyWolnoWyslacPotwierdzenie(zam({ anulowane: 1 }));
    expect(zgoda.wolno).toBe(false);
    expect(zgoda.powod).toMatch(/anulowane/);
    expect(() => trescPotwierdzenia(zam({ anulowane: 1 }))).toThrow(/anulowane/);
  });

  it('brak adresu e-mail → odmowa z podpowiedzią, gdzie go dopisać', () => {
    const zgoda = czyWolnoWyslacPotwierdzenie(zam({ klient: { email: null } }));
    expect(zgoda.wolno).toBe(false);
    expect(zgoda.powod).toMatch(/adresu e-mail/);
  });

  it('zamówienie bez pozycji → odmowa', () => {
    expect(czyWolnoWyslacPotwierdzenie(zam({ pozycje: [] })).wolno).toBe(false);
  });
});

describe('treść potwierdzenia', () => {
  it('temat i adresat', () => {
    const m = trescPotwierdzenia(zam());
    expect(m.do).toBe('klient@firma.pl');
    expect(m.temat).toBe('Potwierdzenie przyjęcia zamówienia nr 202600014');
  });

  // ⚠️⚠️ NAJWAZNIEJSZY TEST TEGO MODULU: mail i karta licza TA SAMA funkcja
  // (`wierszePozycji`), wiec kwoty musza sie zgadzac co do grosza — razem z wysylka.
  it('wymienia pozycje, wysyłkę i sumę dokładnie tak, jak karta', () => {
    const t = trescPotwierdzenia(zam()).tekst;
    expect(t).toContain('3 × Lampa stołowa Grzybek 30x45 — 74,90 zł/szt = 224,70 zł');
    expect(t).toContain('1 × Wysyłka — 19,00 zł/szt = 19,00 zł');
    expect(t).toContain('RAZEM: 243,70 zł brutto');
  });

  it('kwoty idą po polsku, z przecinkiem', () => {
    expect(trescPotwierdzenia(zam()).tekst).not.toContain('243.70');
  });

  it('mówi o płatności i o metodzie wysyłki', () => {
    const t = trescPotwierdzenia(zam()).tekst;
    expect(t).toContain('PŁATNOŚĆ\n  Przelew');
    expect(t).toContain('WYSYŁKA\n  Kurier DPD');
  });

  // ⚠️ PRZY POBRANIU KWOTA MUSI PASC W MAILU — to jedyna liczba, ktora klient ma miec
  // przygotowana dla kuriera, i jedyna, o ktora dzwoni, gdy jej nie zna.
  it('przy pobraniu podaje kwotę do zapłaty kurierowi', () => {
    const t = trescPotwierdzenia(zam({ pobranie: 1, kwota_pobrania: '243.70', metoda_platnosci: 'Za pobraniem' })).tekst;
    expect(t).toContain('Za pobraniem — kurier pobierze 243,70 zł');
  });

  it('niesie adres dostawy — ten sam, który pojedzie na etykietę', () => {
    const t = trescPotwierdzenia(zam()).tekst;
    expect(t).toContain('BETAMET sp. z o.o.');
    expect(t).toContain('Fabryczna 4');
    expect(t).toContain('00-650 Pęki');
  });

  // ⚠️ SEKCJA FAKTURY POKAZUJE SIĘ ZAWSZE — także z odpowiedzią „Nie” (21.08.2026,
  // prośba właściciela). Wcześniej znikała, gdy klient faktury nie chciał — czyli jedyny
  // moment, w którym da się to bezkosztowo sprostować, przechodził bez śladu.
  it('o fakturze mówi ZAWSZE — „Nie” też jest odpowiedzią', () => {
    expect(trescPotwierdzenia(zam()).tekst).toContain('FAKTURA\n  Nie');
    const zF = zam({ chce_fakture: 1, nip: '1000001023', klient: { email: 'k@f.pl', company: 'BETAMET sp. z o.o.' } });
    expect(trescPotwierdzenia(zF).tekst).toContain('Tak — wystawimy na');
  });

  // ⚠️ PODPISUJEMY SIĘ MARKĄ, nie nazwą podmiotu (decyzja właściciela 21.08.2026).
  // Klient zna Szkicownia.pl; Lumina Marek Zywiecki widuje dopiero na fakturze i musiałby
  // się domyślić, że to ten sam sprzedawca.
  it('podpisuje się marką, nie nazwą podmiotu', () => {
    expect(trescPotwierdzenia(zam()).tekst).toContain('Szkicownia.pl');
    expect(trescPotwierdzenia(zam()).tekst).not.toContain('Lumina');
  });

  // Mail ma byc czytelny takze w kliencie tekstowym i w podgladzie na telefonie.
  it('jest tekstem, nie HTML-em', () => {
    expect(trescPotwierdzenia(zam()).tekst).not.toMatch(/<[a-z]/i);
  });
});

describe('adres dostawy w mailu', () => {
  // ⚠️ Zmierzone na zywym zamowieniu R/2026/013 (21.08.2026): zamowienie telefoniczne bywa
  // zakladane z samym e-mailem klienta, a panel pokazuje ten e-mail w polu nazwy odbiorcy.
  // Bez warunku mail twierdzilby, ze dostawa pojdzie „na anna.nowak@example.org".
  it('sama nazwa bez ulicy i miasta NIE jest adresem', () => {
    const z = zam({ dostawa: { first_name: 'anna.nowak@example.org' }, klient: { email: 'anna.nowak@example.org' } });
    const t = trescPotwierdzenia(z).tekst;
    expect(t).toContain('(adres do uzgodnienia)');
    expect(t).not.toMatch(/WYSYŁKA: DPD\n\s+p\.nowak/);
  });

  it('sama miejscowość wystarczy, żeby pokazać adres', () => {
    const z = zam({ dostawa: { first_name: 'Jan', last_name: 'Kowalski', postcode: '00-650', city: 'Pęki' } });
    const t = trescPotwierdzenia(z).tekst;
    expect(t).toContain('00-650 Pęki');
    expect(t).not.toContain('(adres do uzgodnienia)');
  });

  it('pełny adres dalej idzie w całości', () => {
    const t = trescPotwierdzenia(zam()).tekst;
    expect(t).toContain('BETAMET sp. z o.o.');
    expect(t).toContain('Fabryczna 4');
  });
});
