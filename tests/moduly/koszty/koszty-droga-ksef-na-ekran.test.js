import { describe, it, expect } from 'vitest';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { createCzuwaczKosztow } from '../../../src/moduly/koszty/services/czuwacz-kosztow.js';

// ⚠️⚠️ JEDYNY TEST PRZECHODZACY CALA DROGE: KSZTALT ODPOWIEDZI KSeF → EKRAN (recenzja, W5).
//
// Kazdy klocek tej galezi ma swoje testy — `naWiersz` (koszt-metadane), `zapiszKoszt`
// i `kosztyMiesiaca` (db-koszty), `zlozWidok` (lista-kosztow), trasa (koszty-trasy) — ale ZLOZENIE
// nie mialo zadnego. Nic nie prowadzilo metadanych z KSeF przez wszystkie cztery kroki naraz,
// a testy trasy zasiewaly baze kwotami LICZBOWYMI (`netto: 100`), ktorych droga produkcyjna
// nigdy nie wytwarza (`naWiersz` oddaje '100.00') — czyli utrwalaly ksztalt, ktory nie istnieje.
//
// Ten test broni KRYTERIUM AKCEPTACYJNEGO calego modulu, zapisanego przy tabeli `koszty`
// w schema.sql: suma miesiaca ma sie zgadzac CO DO GROSZA z zestawieniem z KSeF (maj 2026 =
// 2 269,55 zl, czerwiec 2026 = 2 881,04 zl). Dlatego dane wchodza tu w ksztalcie ODPOWIEDZI
// KSeF (camelCase, kwoty jako liczby JSON-a), przez PRAWDZIWEGO czuwacza, a wychodza jako HTML.
//
// Celowo sa w nich trzy przypadki, ktore najlatwiej zepsuc po cichu:
//   • KOREKTA (`Kor`) z kwotami UJEMNYMI — ma sume POMNIEJSZYC (zalozenie §1.5, patrz
//     domain/lista-kosztow.js), a nie zostac dodana modulem;
//   • dokument w EUR — NIE WOLNO go dodac do sumy PLN, bo kursu nie znamy;
//   • dokument BEZ KWOTY — idzie do kwarantanny i NIE wchodzi do sumy, ale ma byc widoczny.

const AUTH = { authorization: `Basic ${Buffer.from('t:h').toString('base64')}` };

// Kwoty jako LICZBY JSON-a — dokladnie tak, jak przychodza z KSeF (netAmount: 1067.0).
const dokument = (n) => ({
  ksefNumber: n.ksefNumber,
  invoiceNumber: n.invoiceNumber,
  issueDate: n.issueDate,
  permanentStorageDate: n.permanentStorageDate,
  seller: { nip: n.nip, name: n.nazwa },
  netAmount: n.netto,
  vatAmount: n.vat,
  grossAmount: n.brutto,
  currency: n.waluta ?? 'PLN',
  invoiceType: n.rodzaj ?? 'Vat',
  hasAttachment: false,
});

const MAJ = [
  dokument({
    ksefNumber: '5252674798-20260504-AA1111-01', invoiceNumber: 'FV/2026/05/1',
    issueDate: '2026-05-04', permanentStorageDate: '2026-05-04T09:12:00.000Z',
    nip: '525-267-47-98', nazwa: 'Allegro sp. z o.o.', netto: 1500, vat: 345, brutto: 1845,
  }),
  dokument({
    ksefNumber: '5250007313-20260521-BB2222-02', invoiceNumber: '2026/05/1123',
    issueDate: '2026-05-21', permanentStorageDate: '2026-05-21T18:40:00.000Z',
    nip: '5250007313', nazwa: 'Poczta Polska S.A.', netto: 345.16, vat: 79.39, brutto: 424.55,
  }),
];

const CZERWIEC = [
  dokument({
    ksefNumber: '5252674798-20260602-CC3333-01', invoiceNumber: 'FV/2026/06/12',
    issueDate: '2026-06-02', permanentStorageDate: '2026-06-02T07:05:00.000Z',
    nip: '5252674798', nazwa: 'Allegro sp. z o.o.', netto: 1000, vat: 230, brutto: 1230,
  }),
  dokument({
    ksefNumber: '5250007313-20260615-DD4444-01', invoiceNumber: '2026/06/2244',
    issueDate: '2026-06-15', permanentStorageDate: '2026-06-15T11:00:00.000Z',
    nip: '5250007313', nazwa: 'Poczta Polska S.A.', netto: 1300, vat: 299, brutto: 1599,
  }),
  dokument({
    ksefNumber: '6762447410-20260628-EE5555-01', invoiceNumber: 'F/2026/6/9',
    issueDate: '2026-06-28', permanentStorageDate: '2026-06-28T19:30:00.000Z',
    nip: '6762447410', nazwa: 'Drobny Dostawca', netto: 81.3, vat: 18.7, brutto: 100,
  }),
  // ⚠️ KOREKTA: kwoty UJEMNE, wprost z KSeF. Ma pomniejszyc sume, a nie ja podniesc.
  dokument({
    ksefNumber: '5252674798-20260630-FF6666-01', invoiceNumber: 'KOR/2026/06/3',
    issueDate: '2026-06-30', permanentStorageDate: '2026-06-30T20:15:00.000Z',
    nip: '5252674798', nazwa: 'Allegro sp. z o.o.', netto: -38.99, vat: -8.97, brutto: -47.96,
    rodzaj: 'Kor',
  }),
  // ⚠️ EUR: `vatAmount` z KSeF jest zawsze w PLN, wiec dokument nie ma jednej wspolnej waluty
  // i nie wolno go dodac do sumy miesiaca. Kursu nie znamy, a zmyslony kurs jest gorszy niz
  // widoczna dziura.
  dokument({
    ksefNumber: '9999999999-20260610-GG7777-01', invoiceNumber: 'INV-2026-0610',
    issueDate: '2026-06-10', permanentStorageDate: '2026-06-10T08:00:00.000Z',
    nip: 'DE100000004', nazwa: 'Zagraniczny Dostawca GmbH', netto: 900, vat: 0, brutto: 900,
    waluta: 'EUR',
  }),
  // ⚠️ BEZ KWOTY: KSeF nie podal `netAmount`. Zero weszloby do sumy jako prawda, wiec dokument
  // idzie do kwarantanny — nie do sumy, ale i nie w niepamiec.
  dokument({
    ksefNumber: '7010012345-20260620-HH8888-01', invoiceNumber: 'FV/BEZ-KWOTY/1',
    issueDate: '2026-06-20', permanentStorageDate: '2026-06-20T12:00:00.000Z',
    nip: '7010012345', nazwa: 'Kontrahent Bez Kwoty', netto: null, vat: 0, brutto: 0,
  }),
];

// Atrapa KSeF HONORUJACA OKNO — zwraca wylacznie dokumenty z zadanego zakresu dat trwalego
// zapisu, dokladnie jak API. Atrapa oddajaca zawsze wszystko przepuscilaby bledy w podziale
// na okna i w kursorze.
const klientKsef = (dokumenty) => ({
  pobierzMetadane: async ({ from, to }) => ({
    faktury: dokumenty.filter((d) => d.permanentStorageDate >= from && d.permanentStorageDate < to),
    hasMore: false,
    isTruncated: false,
  }),
});

async function pobierzIPokaz() {
  const db = openOmsDb(':memory:');
  const czuwacz = createCzuwaczKosztow({
    db,
    klient: klientKsef([...MAJ, ...CZERWIEC]),
    sesja: { accessToken: async () => 'ACC' },
    // 03:30 czasu Warszawy (lato) — pora nocnego pobrania, bez `wymuszony`.
    teraz: () => new Date('2026-07-15T01:30:00Z'),
  });
  const wynik = await czuwacz.przebieg();
  const app = buildOmsServer({ db, config: { auth: { user: 't', pass: 'h' } }, czuwaczKosztow: czuwacz });
  const ekran = async (miesiac) => (await app.inject({
    method: 'GET', url: `/koszty?miesiac=${miesiac}`, headers: AUTH,
  }));
  return { db, wynik, ekran };
}

describe('droga: ksztalt odpowiedzi KSeF → baza → ekran', () => {
  it('⚠️ suma czerwca zgadza sie CO DO GROSZA (2 881,04 zl), z korekta na minus', async () => {
    const { wynik, ekran } = await pobierzIPokaz();

    // Piec dokumentow weszlo do lustra, szosty (bez kwoty) do kwarantanny.
    expect(wynik.nowych).toBe(7);
    expect(wynik.odrzuconych).toBe(1);

    const r = await ekran('2026-06');
    expect(r.statusCode).toBe(200);
    // Brutto: 1230,00 + 1599,00 + 100,00 − 47,96 = 2 881,04 (EUR i dokument bez kwoty poza suma).
    expect(r.body).toContain('2 881,04');
    // Netto: 1000,00 + 1300,00 + 81,30 − 38,99 = 2 342,31; VAT: 230,00 + 299,00 + 18,70 − 8,97.
    expect(r.body).toContain('2 342,31');
    expect(r.body).toContain('538,73');
    // ⚠️ KOREKTA POMNIEJSZA SUME. Suma bez niej to 2 929,00 — gdyby kwoty korekty weszly
    // modulem (albo wypadly z sumy), na ekranie stalaby wlasnie ta liczba.
    expect(r.body).not.toContain('2 929,00');
    expect(r.body).toContain('KOR/2026/06/3');
  });

  it('⚠️ suma maja zgadza sie CO DO GROSZA (2 269,55 zl)', async () => {
    const { ekran } = await pobierzIPokaz();

    const r = await ekran('2026-05');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('2 269,55');
    expect(r.body).toContain('1 845,16');
    expect(r.body).toContain('424,39');
  });

  it('⚠️ dokument w EUR stoi osobno i NIE wchodzi do sumy PLN', async () => {
    const { ekran } = await pobierzIPokaz();

    const r = await ekran('2026-06');
    expect(r.body).toContain('INV-2026-0610');
    expect(r.body).toContain('EUR');
    // Gdyby EUR wpadlo do sumy, brutto czerwca wynioslo by 3 781,04.
    expect(r.body).not.toContain('3 781,04');
  });

  it('⚠️ dokument bez kwoty jest w kwarantannie, widoczny i poza suma', async () => {
    const { db, ekran } = await pobierzIPokaz();

    expect(db.prepare('SELECT COUNT(*) c FROM koszty_odrzucone').get().c).toBe(1);
    const r = await ekran('2026-06');
    expect(r.body).toContain('FV/BEZ-KWOTY/1');
    expect(r.body).toMatch(/nie wchodz\w*\s+do sumy/i);
    // Suma zostaje ta sama — dokument bez kwoty nie ma prawa jej ruszyc w zadna strone.
    expect(r.body).toContain('2 881,04');
  });

  // ⚠️ KSZTALT W BAZIE JEST NAPISOWY, i to jest cala arytmetyka pieniedzy w tym module
  // (niezmiennik 4.5). Testy zasiewajace baze liczbami utrwalaly ksztalt, ktorego droga
  // produkcyjna nigdy nie wytwarza — a wtedy pierwszy blad zamiany liczby na napis nie mialby
  // sie o co potknac.
  it('⚠️ kwoty leza w bazie jako NAPISY z dwoma miejscami po przecinku', async () => {
    const { db } = await pobierzIPokaz();

    const w = db.prepare('SELECT netto, vat, brutto FROM koszty WHERE ksef_number = ?')
      .get('6762447410-20260628-EE5555-01');
    expect(w).toEqual({ netto: '81.30', vat: '18.70', brutto: '100.00' });
    const korekta = db.prepare('SELECT netto, rodzaj FROM koszty WHERE ksef_number = ?')
      .get('5252674798-20260630-FF6666-01');
    expect(korekta).toEqual({ netto: '-38.99', rodzaj: 'Kor' });
  });

  // ⚠️ NIP ZNORMALIZOWANY PO DRODZE — kategoria kosztu dobiera sie po NIP-ie, a KSeF potrafi
  // oddac ten sam numer jako '525-267-47-98' i '5252674798'. Dwa zapisy to dwa wiersze
  // kategorii dla jednego podatnika i chybiony odczyt wygladajacy na „brak kategorii".
  it('⚠️ NIP sprzedawcy trafia do bazy w jednej postaci, bez myslnikow', async () => {
    const { db } = await pobierzIPokaz();

    const nipy = db.prepare(
      "SELECT DISTINCT sprzedawca_nip FROM koszty WHERE sprzedawca_nazwa LIKE 'Allegro%'",
    ).all().map((w) => w.sprzedawca_nip);
    expect(nipy).toEqual(['5252674798']);
  });
});
