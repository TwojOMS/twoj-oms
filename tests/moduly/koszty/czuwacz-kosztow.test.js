import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import {
  createCzuwaczKosztow, POWOD_TRWA, POWOD_NIE_TA_PORA, SUFIT_STRON,
  BUDZET_ARCHIWUM_MS, LIMIT_KOLEJNYCH_BLEDOW_ARCHIWUM,
} from '../../../src/moduly/koszty/services/czuwacz-kosztow.js';
import {
  wczytajKursor, stanKosztow, odrzuconeKoszty, zapiszOdrzuconyKoszt, zapiszKursor,
  zapiszBladPobrania,
} from '../../../src/oms/db/koszty.js';
import { PODLOGA_KOSZTOW, ZAPAS_KURSORA_MS } from '../../../src/domena/okna-pobrania.js';
import { zarchiwizuj } from '../../../src/moduly/koszty/services/archiwum-kosztow.js';

const faktura = (n) => ({
  ksefNumber: `K-${n}`, invoiceNumber: `FV/${n}`, issueDate: '2026-06-05',
  permanentStorageDate: `2026-06-0${n}T10:00:00.000Z`,
  seller: { nip: '5252674798', name: 'Allegro' },
  netAmount: 100, vatAmount: 23, grossAmount: 123, currency: 'PLN',
  invoiceType: 'Vat', hasAttachment: false,
});

// ⚠️ TRUJACY DOKUMENT: KSeF nie podał kwoty netto. `naWiersz` rzuca na nim głośno
// (domain/koszt-metadane.js) — bo ciche zero w kosztach zaniża sumę miesiąca podaną
// z pełnym przekonaniem. Ten kształt jest tu punktem wyjścia dla całej grupy testów
// „jeden dokument nie ma prawa zatrzymać pobierania".
const trujaca = (n) => ({ ...faktura(n), netAmount: null, invoiceType: '' });

const klientAtrapa = (strony) => {
  let i = 0;
  return { pobierzMetadane: async () => strony[i++] ?? { faktury: [], hasMore: false, isTruncated: false } };
};
const sesjaAtrapa = { accessToken: async () => 'ACC' };
const strona = (faktury, reszta = {}) => ({
  faktury, hasMore: false, isTruncated: false, ...reszta,
});

describe('czuwacz kosztow', () => {
  it('poza pora nocna NIE pobiera nic', async () => {
    const db = openOmsDb();
    const czuwacz = createCzuwaczKosztow({ db, klient: klientAtrapa([strona([faktura(1)])]), sesja: sesjaAtrapa, teraz: () => new Date('2026-08-12T10:00:00Z') });
    const wynik = await czuwacz.przebieg();
    expect(wynik.pominiety).toBe(true);
    expect(wynik.powod).toBe(POWOD_NIE_TA_PORA);
    expect(db.prepare('SELECT COUNT(*) c FROM koszty').get().c).toBe(0);
  });

  it('wymuszony przebieg (przycisk) pobiera o kazdej porze', async () => {
    const db = openOmsDb();
    const czuwacz = createCzuwaczKosztow({ db, klient: klientAtrapa([strona([faktura(1)])]), sesja: sesjaAtrapa, teraz: () => new Date('2026-08-12T10:00:00Z') });
    const wynik = await czuwacz.przebieg({ wymuszony: true });
    expect(wynik.nowych).toBe(1);
  });

  it('przechodzi kolejne strony, gdy hasMore', async () => {
    const db = openOmsDb();
    const czuwacz = createCzuwaczKosztow({
      db, sesja: sesjaAtrapa, teraz: () => new Date('2026-08-12T01:30:00Z'),
      klient: klientAtrapa([
        strona([faktura(1)], { hasMore: true }),
        strona([faktura(2)]),
      ]),
    });
    const wynik = await czuwacz.przebieg();
    expect(wynik.nowych).toBe(2);
  });

  it('zapisuje kursor na dacie trwalego zapisu OSTATNIEGO rekordu', async () => {
    const db = openOmsDb();
    const czuwacz = createCzuwaczKosztow({ db, sesja: sesjaAtrapa, teraz: () => new Date('2026-08-12T01:30:00Z'), klient: klientAtrapa([strona([faktura(1), faktura(2)])]) });
    await czuwacz.przebieg();
    expect(wczytajKursor(db)).toBe('2026-06-02T10:00:00.000Z');
  });

  it('⚠️ blad w polowie NIE przesuwa kursora', async () => {
    const db = openOmsDb();
    const klient = { pobierzMetadane: async () => { throw new Error('KSeF odmowil'); } };
    const czuwacz = createCzuwaczKosztow({ db, klient, sesja: sesjaAtrapa, teraz: () => new Date('2026-08-12T01:30:00Z') });
    await expect(czuwacz.przebieg()).rejects.toThrow(/KSeF/);
    expect(wczytajKursor(db)).toBeNull();
    expect(stanKosztow(db).ostatni_blad).toMatch(/KSeF/);
  });

  it('⚠️ drugi przebieg w trakcie pierwszego jest POMIJANY i mowi o tym', async () => {
    const db = openOmsDb();
    let zwolnij;
    let pierwszeWywolanie = true;
    // ⚠️ WISI TYLKO PIERWSZE WYWOŁANIE. Podłoga historii dzieli pobranie na KILKA okien, więc
    // atrapa wisząca na każdym wywołaniu zawiesiłaby cały test po zwolnieniu pierwszego okna —
    // a sprawdzamy tu strażnika „jeden przebieg naraz", a nie liczbę okien.
    const pusto = { faktury: [], hasMore: false, isTruncated: false };
    const klient = {
      pobierzMetadane: () => {
        if (!pierwszeWywolanie) return Promise.resolve(pusto);
        pierwszeWywolanie = false;
        return new Promise((r) => { zwolnij = () => r(pusto); });
      },
    };
    const czuwacz = createCzuwaczKosztow({ db, klient, sesja: sesjaAtrapa, teraz: () => new Date('2026-08-12T01:30:00Z') });
    const pierwszy = czuwacz.przebieg();
    const drugi = await czuwacz.przebieg();
    expect(drugi.pominiety).toBe(true);
    expect(drugi.powod).toBe(POWOD_TRWA);
    zwolnij();
    await pierwszy;
  });

  // Pierwsze pobranie zaczyna się od PODŁOGI HISTORII, a nie od „całego KSeF-u" ani od dziś.
  it('pierwszy przebieg pyta od podlogi historii i niesie token z sesji', async () => {
    const db = openOmsDb();
    const zapytania = [];
    const klient = {
      pobierzMetadane: async (a) => { zapytania.push(a); return { faktury: [], hasMore: false, isTruncated: false }; },
    };
    // 03:30 CET — zima przesunięcie wynosi godzinę, więc pora pobrania to 02:30 UTC.
    const czuwacz = createCzuwaczKosztow({ db, klient, sesja: sesjaAtrapa, teraz: () => new Date('2026-03-01T02:30:00Z') });
    const wynik = await czuwacz.przebieg();
    expect(zapytania[0].accessToken).toBe('ACC');
    expect(zapytania[0].from).toBe(new Date(PODLOGA_KOSZTOW).toISOString());
    expect(zapytania[0].pageOffset).toBe(0);
    expect(wynik.okien).toBe(1);
  });

  // ⚠️ OBCIETY WYNIK PRZESUWA OKNO I ZERUJE STRONE (reguła z domain/okna-pobrania.js).
  // Zachowany offset przy przesuniętym oknie przeskakuje dokładnie tyle faktur, ile stron
  // zdążyliśmy przeczytać — i robi to bez błędu.
  it('przy isTruncated przesuwa okno na ostatnia date i zeruje strone', async () => {
    const db = openOmsDb();
    const zapytania = [];
    const strony = [
      strona([faktura(1)], { hasMore: true, isTruncated: true }),
      strona([faktura(2)]),
    ];
    let i = 0;
    const klient = {
      pobierzMetadane: async (a) => { zapytania.push(a); return strony[i++] ?? { faktury: [], hasMore: false, isTruncated: false }; },
    };
    const czuwacz = createCzuwaczKosztow({ db, klient, sesja: sesjaAtrapa, teraz: () => new Date('2026-08-12T01:30:00Z') });
    await czuwacz.przebieg();
    expect(zapytania[1].from).toBe('2026-06-01T10:00:00.000Z');
    expect(zapytania[1].pageOffset).toBe(0);
  });

  // ⚠️⚠️ `nastepnyKrok` RZUCA, gdy przy obciętym wyniku brakuje daty ostatniego rekordu —
  // bo cicha pustka kończyła pobieranie DZIURĄ w danych. Czuwacz ma ten błąd PRZEPUŚCIĆ
  // (ślad w stanie kosztów i odrzucenie obietnicy), a nie połknąć.
  it('⚠️ obciety wynik bez daty ostatniego rekordu przerywa GLOSNO', async () => {
    const db = openOmsDb();
    const klient = { pobierzMetadane: async () => ({ faktury: [], hasMore: true, isTruncated: true }) };
    const czuwacz = createCzuwaczKosztow({ db, klient, sesja: sesjaAtrapa, teraz: () => new Date('2026-08-12T01:30:00Z') });
    await expect(czuwacz.przebieg()).rejects.toThrow(/isTruncated/);
    expect(wczytajKursor(db)).toBeNull();
    expect(stanKosztow(db).ostatni_blad).toMatch(/isTruncated/);
  });

  // ⚠️⚠️ SUFIT STRON MA ZATRZYMAC CALY PRZEBIEG, A NIE SAMO OKNO. Przejście do NASTĘPNEGO
  // okna po wyczerpaniu limitu zostawiało dokumenty z ogona przerwanego okna nieprzeczytane
  // NA ZAWSZE — kursor przeskakiwał za nie razem z ostatnim oknem, a przebieg kończył się
  // bez błędu. To jest dokładnie ta dziura w kosztach, przed którą broni reszta modułu.
  it('⚠️ wyczerpany sufit stron KONCZY przebieg i zostawia kursor na ostatnim dokumencie', async () => {
    const db = openOmsDb();
    let wywolan = 0;
    const kolejna = (n) => ({
      ...faktura(1),
      ksefNumber: `K-${n}`,
      invoiceNumber: `FV/${n}`,
      permanentStorageDate: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
    });
    const klient = {
      pobierzMetadane: async () => {
        wywolan += 1;
        return { faktury: [kolejna(wywolan)], hasMore: true, isTruncated: false };
      },
    };
    const czuwacz = createCzuwaczKosztow({ db, klient, sesja: sesjaAtrapa, teraz: () => new Date('2026-08-12T01:30:00Z') });
    const wynik = await czuwacz.przebieg();

    // Ani jednej strony ponad limit — i ani jednego okna po przerwanym.
    expect(wywolan).toBe(SUFIT_STRON);
    expect(wynik.niedokonczone).toBe(true);
    expect(wynik.nowych).toBe(SUFIT_STRON);
    // Kursor stoi na ostatnim PRZECZYTANYM dokumencie, więc następny przebieg podejmuje
    // dokładnie stąd — nic nie przepadło.
    expect(wczytajKursor(db)).toBe(kolejna(SUFIT_STRON).permanentStorageDate);
    expect(stanKosztow(db).ostatni_blad).toMatch(/limicie/);
  });

  it('normalne zakonczenie okna NIE jest oznaczane jako niedokonczone', async () => {
    const db = openOmsDb();
    const czuwacz = createCzuwaczKosztow({
      db, sesja: sesjaAtrapa, teraz: () => new Date('2026-08-12T01:30:00Z'),
      klient: klientAtrapa([strona([faktura(1)])]),
    });
    expect((await czuwacz.przebieg()).niedokonczone).toBe(false);
  });
});

// ⚠️⚠️ JEDEN TRUJACY DOKUMENT NIE MA PRAWA ZATRZYMAC POBIERANIA — ANI ZNIKNAC PO CICHU.
//
// `naWiersz` i `zapiszKoszt` rzucają (brak kwoty, odmowa bazy), a błąd przebiegu NIE RUSZA
// kursora — więc bez tej grupy testów jeden dokument bez kwoty zatrzymałby czuwacza w tym
// samym oknie w kółko, co noc, na zawsze. Rozstrzygnięcie: dokument idzie do KWARANTANNY
// (tabela `koszty_odrzucone`, razem z surowymi metadanymi), kursor jedzie dalej, a przebieg
// mówi ile dokumentów odrzucił. Uzasadnienie w nagłówku services/czuwacz-kosztow.js.
describe('czuwacz kosztow — trujacy dokument', () => {
  const oPolnocy = () => new Date('2026-08-12T01:30:00Z');

  it('nie zatrzymuje przebiegu: reszta strony ladzie w kosztach, dokument w kwarantannie', async () => {
    const db = openOmsDb();
    const czuwacz = createCzuwaczKosztow({
      db, sesja: sesjaAtrapa, teraz: oPolnocy,
      klient: klientAtrapa([strona([faktura(1), trujaca(2), faktura(3)])]),
    });
    const wynik = await czuwacz.przebieg();

    expect(wynik.nowych).toBe(2);
    expect(wynik.odrzuconych).toBe(1);
    expect(wynik.przeczytanych).toBe(3);
    expect(db.prepare('SELECT COUNT(*) c FROM koszty').get().c).toBe(2);
    // Kursor jedzie dalej — inaczej co noc mielilibyśmy to samo okno bez drogi obok.
    expect(wczytajKursor(db)).toBe('2026-06-03T10:00:00.000Z');
  });

  it('kwarantanna niesie POWOD i SUROWE metadane, zeby dalo sie dokument odzyskac', async () => {
    const db = openOmsDb();
    const czuwacz = createCzuwaczKosztow({
      db, sesja: sesjaAtrapa, teraz: oPolnocy, klient: klientAtrapa([strona([trujaca(2)])]),
    });
    await czuwacz.przebieg();

    const odrzucone = odrzuconeKoszty(db);
    expect(odrzucone).toHaveLength(1);
    expect(odrzucone[0].ksef_number).toBe('K-2');
    expect(odrzucone[0].numer_dokumentu).toBe('FV/2');
    expect(odrzucone[0].powod).toMatch(/kwoty/);
    // ⚠️ SUROWE METADANE, a nie sam powód: bez nich dokument jest stracony na zawsze —
    // kursor przejechał obok, a KSeF drugi raz go w tym oknie nie pokaże.
    expect(JSON.parse(odrzucone[0].metadane_json)).toEqual(trujaca(2));
  });

  it('⚠️ odrzucenie ZOSTAJE w bazie takze po kolejnym UDANYM przebiegu', async () => {
    const db = openOmsDb();
    const czuwacz = createCzuwaczKosztow({
      db, sesja: sesjaAtrapa, teraz: oPolnocy,
      klient: klientAtrapa([strona([trujaca(2)]), strona([faktura(3)])]),
    });
    await czuwacz.przebieg();
    await czuwacz.przebieg();

    expect(odrzuconeKoszty(db)).toHaveLength(1);
  });

  it('ten sam dokument spotkany drugi raz nie robi dubletu', async () => {
    const db = openOmsDb();
    const klient = { pobierzMetadane: async () => ({ faktury: [trujaca(2)], hasMore: false, isTruncated: false }) };
    const czuwacz = createCzuwaczKosztow({
      db, klient, sesja: sesjaAtrapa, teraz: oPolnocy,
    });
    await czuwacz.przebieg();
    await czuwacz.przebieg();

    const odrzucone = odrzuconeKoszty(db);
    expect(odrzucone).toHaveLength(1);
    // Pierwsze odrzucenie zostaje na miejscu, ostatnia próba idzie do przodu.
    expect(odrzucone[0].ostatnia_proba_at >= odrzucone[0].odrzucony_at).toBe(true);
  });

  it('⚠️ przebieg z odrzuceniem ZAPALA slad w stanie kosztow, mimo ze kursor ruszyl', async () => {
    const db = openOmsDb();
    const czuwacz = createCzuwaczKosztow({
      db, sesja: sesjaAtrapa, teraz: oPolnocy, klient: klientAtrapa([strona([trujaca(2)])]),
    });
    await czuwacz.przebieg();

    const stan = stanKosztow(db);
    expect(stan.ostatni_blad).toMatch(/odrzuc/i);
    expect(stan.ostatni_blad).toMatch(/K-2/);
    expect(stan.ostatnie_udane_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(stan.kursor).toBe('2026-06-02T10:00:00.000Z');
  });

  // ⚠️ KWARANTANNA JEST DLA ODMOWY DOTYCZACEJ DOKUMENTU, NIE DLA AWARII PANELU. Błąd
  // techniczny (padnięta baza, brak tabeli) ma przerwać przebieg i ZOSTAWIĆ kursor —
  // inaczej awaria dysku przejechałaby po całym oknie, „odrzucając" każdy dokument po kolei.
  it('⚠️ awaria bazy NIE trafia do kwarantanny — przerywa przebieg i nie rusza kursora', async () => {
    const db = openOmsDb();
    db.exec('DROP TABLE koszty');
    const czuwacz = createCzuwaczKosztow({
      db, sesja: sesjaAtrapa, teraz: oPolnocy, klient: klientAtrapa([strona([faktura(1)])]),
    });
    await expect(czuwacz.przebieg()).rejects.toThrow(/koszty/);
    expect(wczytajKursor(db)).toBeNull();
    expect(odrzuconeKoszty(db)).toHaveLength(0);
  });

  // Bez numeru KSeF nie ma czym zaadresować kwarantanny — a wpis bez klucza wracałby
  // co noc jako nowy wiersz. To jest stan, którego panel nie umie rozstrzygnąć sam.
  it('dokument bez numeru KSeF przerywa przebieg glosno', async () => {
    const db = openOmsDb();
    const bezNumeru = { ...trujaca(2), ksefNumber: null };
    const czuwacz = createCzuwaczKosztow({
      db, sesja: sesjaAtrapa, teraz: oPolnocy, klient: klientAtrapa([strona([bezNumeru])]),
    });
    await expect(czuwacz.przebieg()).rejects.toThrow(/numeru KSeF/);
    expect(wczytajKursor(db)).toBeNull();
  });
});

// ⚠️⚠️ KWARANTANNA MA MIEĆ WEJŚCIE, WYJŚCIE I WIDOCZNOŚĆ DŁUŻSZĄ NIŻ JEDNA NOC (recenzja, W1+W4).
//
// Pierwsza wersja liczyła oba te fakty z licznika BIEŻĄCEGO przebiegu — a `zapiszKursor`
// gasi `ostatni_blad` przy każdym udanym przebiegu. Skutek zmierzony sondą: dokument
// odrzucony w nocy 1 znikał z ekranu w nocy 2, mimo że wiersz kwarantanny stał dalej.
// To wywraca całe uzasadnienie wyboru kwarantanny („nic nie znika po cichu"): jedynym
// śladem zostawała tabela, której nic nie czyta.
describe('czuwacz kosztow — kwarantanna widoczna i opuszczalna', () => {
  const oPolnocy = () => new Date('2026-08-12T01:30:00Z');

  // Atrapa sterowana NUMEREM PRZEBIEGU, a nie kolejnością stron: podłoga historii dzieli
  // pierwsze pobranie na kilka okien, więc lista stron rozjeżdża się z intencją testu.
  const klientPrzebiegow = (dajFakture, licznik) => ({
    pobierzMetadane: async () => strona([dajFakture(licznik.n)]),
  });

  it('⚠️ slad o kwarantannie NIE GASNIE po pierwszym czystym przebiegu', async () => {
    const db = openOmsDb();
    const licznik = { n: 1 };
    const czuwacz = createCzuwaczKosztow({
      db,
      sesja: sesjaAtrapa,
      teraz: oPolnocy,
      klient: klientPrzebiegow((n) => (n === 1 ? trujaca(2) : faktura(3)), licznik),
    });
    await czuwacz.przebieg();
    licznik.n = 2;
    await czuwacz.przebieg();

    // Wiersz kwarantanny stoi — więc suma miesiąca WCIĄŻ jest niepełna, i panel ma to mówić.
    expect(odrzuconeKoszty(db)).toHaveLength(1);
    const stan = stanKosztow(db);
    expect(stan.ostatni_blad).toMatch(/K-2/);
    expect(stan.kursor).toBe('2026-06-03T10:00:00.000Z');
  });

  // Ten sam licznik z drugiej strony: kwarantanna zapełniona RĘCZNIE (jak po nocy sprzed
  // tygodnia) ma być widoczna także w przebiegu, który sam nie odrzucił niczego.
  it('⚠️ zastana kwarantanna jest widoczna w przebiegu, ktory sam nic nie odrzucil', async () => {
    const db = openOmsDb();
    zapiszOdrzuconyKoszt(db, { ksefNumber: 'K-STARY', invoiceNumber: 'FV/9' }, 'brak kwoty');
    const czuwacz = createCzuwaczKosztow({
      db, sesja: sesjaAtrapa, teraz: oPolnocy, klient: klientAtrapa([strona([faktura(1)])]),
    });
    const wynik = await czuwacz.przebieg();

    expect(wynik.odrzuconych).toBe(0);
    expect(stanKosztow(db).ostatni_blad).toMatch(/K-STARY/);
  });

  // ⚠️ WYJŚCIE Z KWARANTANNY. Bez niego (1) po naprawie mapowania nic nie przerabia surowych
  // metadanych na wiersz — trzeba ręcznie cofać kursor, czyli dokładnie to, czemu kolumna
  // z metadanymi miała zapobiec; (2) dokument zapisany poprawnie przy ponownym spotkaniu
  // w oknie zachodzącym zostawiał wiersz kwarantanny NA ZAWSZE, a panel do końca świata
  // twierdziłby, że brakuje dokumentu, który już jest w sumie.
  it('⚠️ udany zapis WYPUSZCZA dokument z kwarantanny', async () => {
    const db = openOmsDb();
    const licznik = { n: 1 };
    const czuwacz = createCzuwaczKosztow({
      db,
      sesja: sesjaAtrapa,
      teraz: oPolnocy,
      klient: klientPrzebiegow((n) => (n === 1 ? trujaca(2) : faktura(2)), licznik),
    });
    await czuwacz.przebieg();
    expect(odrzuconeKoszty(db)).toHaveLength(1);

    licznik.n = 2;
    await czuwacz.przebieg();

    expect(odrzuconeKoszty(db)).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) c FROM koszty').get().c).toBe(1);
    // Nic nie zostało odrzucone i nic nie leży w kwarantannie — pasek gaśnie zgodnie z prawdą.
    expect(stanKosztow(db).ostatni_blad).toBeNull();
  });
});

// ⚠️⚠️ OKNO NIE MA PRAWA ODDAĆ SWOJEGO STANU OKNU NASTĘPNEMU (recenzja, W2+W3).
//
// `ostatniaData` była wspólna dla WSZYSTKICH okien, więc pusta strona z `isTruncated` w oknie N
// dostawała datę z okna N-1 i strażnik `!ostatniaData` — napisany dokładnie na ten przypadek —
// był obchodzony bogusową datą. Zmierzone sondą: zapytanie `from=2026-02-01 → to=2026-07-01`,
// czyli 149 dni przy twardym limicie MF trzech miesięcy.
describe('czuwacz kosztow — granice okien', () => {
  const wNocy = () => new Date('2026-08-12T01:30:00Z');
  const DNI_W_OKNIE = 93;

  it('⚠️ pusta strona z isTruncated NIE dziedziczy daty z okna poprzedniego', async () => {
    const db = openOmsDb();
    const zapytania = [];
    let n = 0;
    const klient = {
      pobierzMetadane: async (a) => {
        zapytania.push(a);
        n += 1;
        // Okno 1 kończy się normalnie i zostawia po sobie datę z lutego.
        if (n === 1) {
          return strona([{ ...faktura(1), permanentStorageDate: '2026-02-01T10:00:00.000Z' }]);
        }
        // Okno 2: strona PUSTA, ale KSeF mówi „jest więcej i wynik obcięty".
        return strona([], { hasMore: true, isTruncated: true });
      },
    };
    const czuwacz = createCzuwaczKosztow({
      db, klient, sesja: sesjaAtrapa, teraz: wNocy,
    });

    // Bez daty W TYM oknie nie da się bezpiecznie przesunąć okna — przerywamy głośno.
    await expect(czuwacz.przebieg()).rejects.toThrow(/isTruncated/);
    expect(zapytania).toHaveLength(2);
    // ŻADNE zapytanie nie przekroczyło twardego limitu MF (3 miesiące) — bo taki zakres
    // KSeF odbija czterysetką i przebieg padałby co noc w tym samym miejscu.
    for (const z of zapytania) {
      const dni = (new Date(z.to) - new Date(z.from)) / 86400000;
      expect(dni).toBeLessThanOrEqual(DNI_W_OKNIE);
    }
    expect(wczytajKursor(db)).toBeNull();
  });

  // ⚠️ DRUGIE WYJŚCIE PRZEDWCZESNE, ta sama dziura co przy suficie stron: klient degraduje
  // brakujące/niebulowskie `hasMore` do `false` (kształt niezmierzony na żywym API). Gdyby
  // KSeF pominął to pole na stronie mającej następniki, okno kończy się cicho, przebieg leci
  // do okien PÓŹNIEJSZYCH, a kursor przeskakuje ogon okna przerwanego. Ta sama obrona:
  // przy przedwczesnym zakończeniu okna nie wchodzimy w okna następne.
  it('⚠️ okno zakonczone NIEPEWNIE nie wpuszcza przebiegu w okna nastepne', async () => {
    const db = openOmsDb();
    const zapytania = [];
    const klient = {
      pobierzMetadane: async (a) => {
        zapytania.push(a);
        return {
          faktury: [faktura(1)], hasMore: false, isTruncated: false, koniecNiepewny: true,
        };
      },
    };
    const czuwacz = createCzuwaczKosztow({
      db, klient, sesja: sesjaAtrapa, teraz: wNocy,
    });
    const wynik = await czuwacz.przebieg();

    expect(zapytania).toHaveLength(1);
    expect(wynik.niedokonczone).toBe(true);
    // Kursor stoi na ostatnim PRZECZYTANYM dokumencie — następny przebieg podejmuje stąd.
    expect(wczytajKursor(db)).toBe('2026-06-01T10:00:00.000Z');
    expect(stanKosztow(db).ostatni_blad).toMatch(/hasMore/);
    // ⚠️ `okien` to okna PRZETWORZONE, nie zaplanowane — przy przerwanym przebiegu liczba
    // zaplanowanych kłamie o tym, ile panel naprawdę przeczytał.
    expect(wynik.okien).toBe(1);
    expect(wynik.okienZaplanowanych).toBe(3);
  });

  it('koniec PEWNY konczy okno normalnie i przepuszcza okna nastepne', async () => {
    const db = openOmsDb();
    const zapytania = [];
    const klient = {
      pobierzMetadane: async (a) => {
        zapytania.push(a);
        return {
          faktury: [], hasMore: false, isTruncated: false, koniecNiepewny: false,
        };
      },
    };
    const czuwacz = createCzuwaczKosztow({
      db, klient, sesja: sesjaAtrapa, teraz: wNocy,
    });
    const wynik = await czuwacz.przebieg();

    expect(zapytania).toHaveLength(3);
    expect(wynik.niedokonczone).toBe(false);
    expect(wynik.okien).toBe(3);
    expect(wynik.okienZaplanowanych).toBe(3);
  });

  // ⚠️ KURSOR TO NAJDALSZA DATA, NIE OSTATNIA WIDZIANA. KSeF sortuje rosnąco, więc w normalnym
  // przebiegu to jedno i to samo — ale kursor jest OBIETNICĄ „wszystko do tej daty już
  // przeczytaliśmy", a jedna strona przysłana nie po kolei zamieniłaby ją w obietnicę fałszywą:
  // cofnięty kursor to dokument przeczytany dwa razy (niegroźne, `INSERT OR IGNORE`),
  // przesunięty za daleko — dokument nieprzeczytany NIGDY.
  it('⚠️ kursor bierze NAJDALSZA date, takze gdy strona przyszla nie po kolei', async () => {
    const db = openOmsDb();
    const czuwacz = createCzuwaczKosztow({
      db,
      sesja: sesjaAtrapa,
      teraz: wNocy,
      klient: klientAtrapa([strona([faktura(3), faktura(1)])]),
    });
    await czuwacz.przebieg();

    expect(wczytajKursor(db)).toBe('2026-06-03T10:00:00.000Z');
  });

  // ⚠️ TOKEN NA KAŻDĄ STRONĘ, NIE RAZ NA PRZEBIEG. Przebieg potrafi trwać godziny (samo pełne
  // logowanie do KSeF ~31 min), a `sesja.accessToken()` jest tani: czyta z bazy i wychodzi
  // do sieci dopiero przy wygaśnięciu. Pobranie tokena raz na starcie to cała klasa awarii
  // „401 w połowie nocy", której nie widać do rana.
  it('⚠️ token idzie z sesji przy KAZDEJ stronie, a nie raz na caly przebieg', async () => {
    const db = openOmsDb();
    let wydan = 0;
    const sesja = { accessToken: async () => { wydan += 1; return `ACC-${wydan}`; } };
    const zapytania = [];
    const strony = [strona([faktura(1)], { hasMore: true }), strona([faktura(2)])];
    let i = 0;
    const klient = {
      pobierzMetadane: async (a) => { zapytania.push(a); return strony[i++] ?? strona([]); },
    };
    const czuwacz = createCzuwaczKosztow({
      db, klient, sesja, teraz: wNocy,
    });
    await czuwacz.przebieg();

    expect(zapytania[0].accessToken).toBe('ACC-1');
    expect(zapytania[1].accessToken).toBe('ACC-2');
  });
});

// ⚠️⚠️ UDANY PRZEBIEG JEST FAKTEM NIEZALEZNYM OD TEGO, CZY KURSOR SIE RUSZYL (recenzja, W1).
//
// `zapiszKursor` byl JEDYNYM zapisem `ostatnie_udane_at` i jedynym miejscem kasujacym
// `ostatni_blad` — a wolany byl tylko wtedy, gdy przebieg cokolwiek przeczytal. Skutek:
// spokojna doba bez ani jednej faktury kosztowej zostawiala `ostatnie_udane_at = null`
// i NIE GASILA awarii sprzed trzech tygodni. Ekran mowi wprost, ze „kiedy ostatnio sie udalo"
// jest wazniejsze niz „czy byl blad" — wiec to jest kłamstwo dokladnie w tym miejscu, ktore
// ma odpowiadac na pytanie „czy panel jeszcze pobiera koszty".
describe('czuwacz kosztow — udany przebieg bez dokumentow', () => {
  const wNocy = () => new Date('2026-08-12T01:30:00Z');

  it('⚠️ pusty przebieg odnotowuje sie jako UDANY i gasi stara awarie', async () => {
    const db = openOmsDb();
    zapiszBladPobrania(db, 'KSeF odmowil trzy tygodnie temu');
    const czuwacz = createCzuwaczKosztow({
      db, sesja: sesjaAtrapa, teraz: wNocy, klient: klientAtrapa([]),
    });
    const wynik = await czuwacz.przebieg();

    expect(wynik.przeczytanych).toBe(0);
    const stan = stanKosztow(db);
    expect(stan.ostatnie_udane_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(stan.ostatni_blad).toBeNull();
    expect(stan.ostatni_blad_at).toBeNull();
  });

  it('⚠️ pusty przebieg NIE rusza kursora — nie ma czym go przesunac', async () => {
    const db = openOmsDb();
    zapiszKursor(db, '2026-06-01T10:00:00.000Z');
    const czuwacz = createCzuwaczKosztow({
      db, sesja: sesjaAtrapa, teraz: wNocy, klient: klientAtrapa([]),
    });
    await czuwacz.przebieg();

    expect(wczytajKursor(db)).toBe('2026-06-01T10:00:00.000Z');
  });
});

// ⚠️⚠️ OKNO PRZYROSTOWE ZACHODZI NA POPRZEDNIE (recenzja calej galezi, K1).
//
// Kursor to maksimum `permanentStorageDate` dokumentow, KTORE WROCILY Z ZAPYTANIA — a nie
// „wszystkiego, co KSeF juz zapisal". Dokument zapisany przed ta chwila, lecz widoczny dopiero
// pozniej (opoznienie indeksu MF, dwa dokumenty z tym samym znacznikiem czasu, `from` okazujace
// sie wylaczajace) nie trafilby juz do zadnego przyszlego okna: kursor nad nim przeskoczyl,
// a podloga zabrania cofania. Zanizona suma miesiaca, bez ani jednego bledu.
describe('czuwacz kosztow — zapas okna przyrostowego', () => {
  const wNocy = () => new Date('2026-08-12T01:30:00Z');

  it('⚠️ drugi przebieg pyta od daty WCZESNIEJSZEJ niz kursor', async () => {
    const db = openOmsDb();
    const zapytania = [];
    const klient = {
      pobierzMetadane: async (a) => { zapytania.push(a); return strona([faktura(1)]); },
    };
    const czuwacz = createCzuwaczKosztow({ db, klient, sesja: sesjaAtrapa, teraz: wNocy });
    await czuwacz.przebieg();
    const kursor = wczytajKursor(db);
    zapytania.length = 0;
    await czuwacz.przebieg();

    expect(kursor).toBe('2026-06-01T10:00:00.000Z');
    const od = new Date(zapytania[0].from).getTime();
    expect(od).toBeLessThan(new Date(kursor).getTime());
    expect(new Date(kursor).getTime() - od).toBe(ZAPAS_KURSORA_MS);
  });

  // Dokument „spozniony" (KSeF pokazal go dopiero w kolejnym przebiegu, mimo ze jego data
  // trwalego zapisu jest WCZESNIEJSZA niz kursor) ma jeszcze wejsc do sumy miesiaca.
  it('⚠️ dokument widoczny z opoznieniem wchodzi do kosztow w kolejnym przebiegu', async () => {
    const db = openOmsDb();
    // Atrapa sterowana NUMEREM PRZEBIEGU, a nie kolejnoscia stron: podloga historii dzieli
    // pierwsze pobranie na kilka okien, wiec lista stron rozjezdza sie z intencja testu.
    const licznik = { n: 1 };
    const spozniony = { ...faktura(1), ksefNumber: 'K-SPOZNIONY', invoiceNumber: 'FV/SP' };
    const klient = {
      // ⚠️ ATRAPA HONORUJE OKNO — inaczej test przechodzilby TAKZE bez zapasu, bo dokument
      // sprzed kursora wracalby w kazdym zapytaniu, niezaleznie od `from`.
      pobierzMetadane: async ({ from, to }) => {
        // Przebieg 1 widzi tylko dokument z 5 czerwca; przebieg 2 doklada dokument z 1 czerwca,
        // czyli SPRZED kursora postawionego poprzedniej nocy.
        const wszystkie = licznik.n === 1 ? [faktura(5)] : [faktura(5), spozniony];
        return strona(wszystkie.filter(
          (f) => f.permanentStorageDate >= from && f.permanentStorageDate < to,
        ));
      },
    };
    const czuwacz = createCzuwaczKosztow({ db, klient, sesja: sesjaAtrapa, teraz: wNocy });
    await czuwacz.przebieg();
    licznik.n = 2;
    const drugi = await czuwacz.przebieg();

    expect(drugi.nowych).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM koszty').get().c).toBe(2);
  });

  // ⚠️ D1: kursor z przyszlosci (skew zegara albo data z KSeF w innej strefie) dawal PUSTA
  // liste okien — czuwacz nie robil NIC, na zawsze, bez ani jednego bledu.
  it('⚠️ kursor z przyszlosci nie zatrzymuje pobierania i zostawia slad', async () => {
    const db = openOmsDb();
    zapiszKursor(db, '2027-01-01T00:00:00.000Z');
    const zapytania = [];
    const klient = {
      pobierzMetadane: async (a) => { zapytania.push(a); return strona([faktura(1)]); },
    };
    const czuwacz = createCzuwaczKosztow({ db, klient, sesja: sesjaAtrapa, teraz: wNocy });
    const wynik = await czuwacz.przebieg();

    expect(zapytania.length).toBeGreaterThan(0);
    expect(wynik.nowych).toBe(1);
    // Kursor wraca na date prawdziwego dokumentu — stan naprawia sie sam.
    expect(wczytajKursor(db)).toBe('2026-06-01T10:00:00.000Z');
    expect(stanKosztow(db).ostatni_blad).toMatch(/przyszłoś/i);
  });
});

// ⚠️⚠️ ARCHIWUM XML — OKABLOWANIE `services/archiwum-kosztow.js` DO CZUWACZA.
//
// Trzy rzeczy rozstrzygnięte tutaj i tylko tutaj, wszystkie o tym, czego archiwum NIE MA
// PRAWA zepsuć:
//
//  1. archiwizacja stoi POZA pętlą kwarantanny — bo klient KSeF taguje `dlaOperatora` KAŻDY
//     swój błąd (także HTTP 500 i „KSeF nieosiągalny"), więc wołanie go w tamtej pętli
//     zamieniłoby awarię KSeF w ciche wrzucenie CAŁEGO okna do kwarantanny, dokument po
//     dokumencie, z kursorem jadącym spokojnie za nią (zakaz z nagłówka `zapiszAlboOdloz`);
//  2. awaria pobierania XML-a ani awaria NAS-a nie przerywa przebiegu i nie rusza kursora —
//     dane w bazie są ważniejsze niż plik na dysku;
//  3. archiwizacja ma BUDŻET CZASU, bo dokłada jedno żądanie HTTP na dokument.
describe('czuwacz kosztow — archiwum XML', () => {
  const wNocy = () => new Date('2026-08-12T01:30:00Z');
  const katalogTymczasowy = () => mkdtempSync(join(tmpdir(), 'czuwacz-archiwum-'));
  const sciezki = (db) => db.prepare('SELECT ksef_number, sciezka_xml FROM koszty ORDER BY ksef_number').all();

  it('pobrany dokument ląduje w archiwum: plik na dysku i ścieżka w bazie', async () => {
    const db = openOmsDb();
    const katalogArchiwum = katalogTymczasowy();
    const pobrane = [];
    const klient = {
      ...klientAtrapa([strona([faktura(1)])]),
      pobierzXml: async ({ ksefNumber }) => { pobrane.push(ksefNumber); return '<Faktura/>'; },
    };
    const czuwacz = createCzuwaczKosztow({
      db, klient, sesja: sesjaAtrapa, teraz: wNocy, katalogArchiwum,
    });

    const wynik = await czuwacz.przebieg();

    expect(pobrane).toEqual(['K-1']);
    expect(wynik.zarchiwizowanych).toBe(1);
    const [w] = sciezki(db);
    expect(w.sciezka_xml).toBe('Kosztowe 2026/Czerwiec/2026-06-05_ALLEGRO_FV-1.xml');
    expect(readFileSync(join(katalogArchiwum, w.sciezka_xml), 'utf8')).toBe('<Faktura/>');
  });

  // Brak `KSEF_ARCHIWUM` to POPRAWNY tryb: koszty pobierają się dokładnie jak dotąd, tylko
  // bez plików na NAS-ie. Ani jednego dodatkowego żądania do KSeF.
  it('bez katalogu archiwum przebieg NIE pobiera ani jednego XML-a', async () => {
    const db = openOmsDb();
    const klient = {
      ...klientAtrapa([strona([faktura(1)])]),
      pobierzXml: async () => { throw new Error('nie wolno bylo tego wolac'); },
    };
    const czuwacz = createCzuwaczKosztow({ db, klient, sesja: sesjaAtrapa, teraz: wNocy });

    const wynik = await czuwacz.przebieg();

    expect(wynik.nowych).toBe(1);
    expect(wynik.zarchiwizowanych).toBe(0);
    expect(sciezki(db)[0].sciezka_xml).toBeNull();
  });

  // ⚠️⚠️ TEN TEST PILNUJE ZAKAZU Z NAGŁÓWKA `zapiszAlboOdloz`: klienta KSeF nie wolno wołać
  // wewnątrz pętli kwarantanny. Sprawdzamy to jedynym sposobem widocznym z zewnątrz —
  // KOLEJNOŚCIĄ: w chwili pierwszego `pobierzXml` kursor jest już zapisany, czyli pętla
  // metadanych (a z nią kwarantanna) dawno się skończyła.
  it('⚠️ XML pobiera się DOPIERO po zapisaniu kursora, nigdy w pętli kwarantanny', async () => {
    const db = openOmsDb();
    const kursorWChwiliPobrania = [];
    const klient = {
      ...klientAtrapa([strona([faktura(1)])]),
      pobierzXml: async () => { kursorWChwiliPobrania.push(wczytajKursor(db)); return '<F/>'; },
    };
    const czuwacz = createCzuwaczKosztow({
      db, klient, sesja: sesjaAtrapa, teraz: wNocy, katalogArchiwum: katalogTymczasowy(),
    });

    await czuwacz.przebieg();

    expect(kursorWChwiliPobrania).toEqual(['2026-06-01T10:00:00.000Z']);
  });

  // ⚠️⚠️ AWARIA KSeF PRZY POBIERANIU XML-a NIE MA PRAWA: przerwać przebiegu, cofnąć kursora
  // ani wrzucić dokumentu do kwarantanny. Dokument JEST w sumie miesiąca — brakuje tylko
  // pliku, który da się dociągnąć następnej nocy.
  it('⚠️ awaria pobierania XML nie przerywa przebiegu, nie rusza kursora i nie wchodzi do kwarantanny', async () => {
    const db = openOmsDb();
    const ostrzezenia = [];
    const klient = {
      ...klientAtrapa([strona([faktura(1)])]),
      pobierzXml: async () => {
        // ⚠️ BŁĄD Z `dlaOperatora` — DOKŁADNIE TAKI, JAKI TAGUJE KLIENT KSeF przy każdej
        // swojej awarii. Gdyby archiwizacja siedziała w pętli kwarantanny, ten dokument
        // wylądowałby w `koszty_odrzucone` mimo poprawnych danych.
        const e = new Error('KSeF nieosiągalny przy pobieraniu dokumentu K-1');
        e.dlaOperatora = true;
        throw e;
      },
    };
    const czuwacz = createCzuwaczKosztow({
      db,
      klient,
      sesja: sesjaAtrapa,
      teraz: wNocy,
      katalogArchiwum: katalogTymczasowy(),
      log: (...czesci) => ostrzezenia.push(czesci.join(' ')),
    });

    const wynik = await czuwacz.przebieg();

    expect(wynik.nowych).toBe(1);
    expect(wynik.zarchiwizowanych).toBe(0);
    expect(wczytajKursor(db)).toBe('2026-06-01T10:00:00.000Z');
    expect(odrzuconeKoszty(db)).toHaveLength(0);
    expect(sciezki(db)[0].sciezka_xml).toBeNull();
    expect(ostrzezenia.join(' ')).toContain('K-1');
  });

  // ⚠️ DOKUMENT ODRZUCONY (kwarantanna) NIE MA WIERSZA W `koszty`, więc nie ma czego
  // archiwizować — i nie ma czym nazwać pliku (nie znamy jego kwot ani rodzaju). Pobieramy
  // XML WYŁĄCZNIE dla dokumentów, które weszły do lustra.
  it('dokument w kwarantannie nie jest archiwizowany', async () => {
    const db = openOmsDb();
    const pobrane = [];
    const klient = {
      ...klientAtrapa([strona([faktura(1), trujaca(2)])]),
      pobierzXml: async ({ ksefNumber }) => { pobrane.push(ksefNumber); return '<F/>'; },
    };
    const czuwacz = createCzuwaczKosztow({
      db, klient, sesja: sesjaAtrapa, teraz: wNocy, katalogArchiwum: katalogTymczasowy(),
    });

    const wynik = await czuwacz.przebieg();

    expect(wynik.odrzuconych).toBe(1);
    expect(pobrane).toEqual(['K-1']);
  });

  // ⚠️ XML RAZ POBRANY NIE ZMIENIA SIĘ NIGDY (to trwały, wystawiony dokument), a okna pobrania
  // ZACHODZĄ na siebie — bez bramki po `sciezka_xml` każdy nocny przebieg ściągałby całe
  // archiwum od nowa, dokument po dokumencie. Bramka siedzi w `zarchiwizuj`; ten test
  // potwierdza, że czuwacz jej nie obchodzi (np. własną listą „nowych z tego przebiegu").
  it('⚠️ drugi przebieg NIE pobiera XML-a dokumentu, który ma już ścieżkę', async () => {
    const db = openOmsDb();
    const katalogArchiwum = katalogTymczasowy();
    const pobrane = [];
    const klient = {
      // Ten sam dokument w obu przebiegach — okna pobrania zachodzą na siebie, to normalny stan.
      pobierzMetadane: async () => strona([faktura(1)]),
      pobierzXml: async ({ ksefNumber }) => { pobrane.push(ksefNumber); return '<F/>'; },
    };
    const czuwacz = createCzuwaczKosztow({
      db, klient, sesja: sesjaAtrapa, teraz: wNocy, katalogArchiwum,
    });

    await czuwacz.przebieg();
    const drugi = await czuwacz.przebieg();

    expect(pobrane).toEqual(['K-1']);
    expect(drugi.zarchiwizowanych).toBe(0);
  });

  // ⚠️⚠️ BUDŻET CZASU, NIE SUFIT SZTUK. Backfill od stycznia to setki dokumentów, czyli setki
  // żądań HTTP w JEDNYM przebiegu — a przebieg dziedziczy już ~31 min najgorszego logowania
  // i przy przekroczeniu godziny gubi kolejne tyknięcie zegara (bootstrap.js). Sufit sztuk
  // nie ogranicza CZASU (każde żądanie może iść do limitu klienta), więc granicą jest zegar.
  // Reszta zostaje na następną noc: bramka po `sciezka_xml` sama ją podejmie.
  it('⚠️ archiwizacja mieści się w budżecie czasu, reszta czeka na następny przebieg', async () => {
    const db = openOmsDb();
    let chwila = new Date('2026-08-12T01:30:00Z').getTime();
    const pobrane = [];
    const klient = {
      ...klientAtrapa([strona([faktura(1), faktura(2), faktura(3)])]),
      pobierzXml: async ({ ksefNumber }) => {
        pobrane.push(ksefNumber);
        // Pierwszy dokument zjada CAŁY budżet — drugi nie ma już prawa wystartować.
        chwila += BUDZET_ARCHIWUM_MS;
        return '<F/>';
      },
    };
    const czuwacz = createCzuwaczKosztow({
      db,
      klient,
      sesja: sesjaAtrapa,
      teraz: () => new Date(chwila),
      katalogArchiwum: katalogTymczasowy(),
      log: () => {},
    });

    const wynik = await czuwacz.przebieg({ wymuszony: true });

    expect(pobrane).toHaveLength(1);
    expect(wynik.zarchiwizowanych).toBe(1);
    expect(wynik.przeczytanych).toBe(3);
    expect(sciezki(db).filter((w) => w.sciezka_xml === null)).toHaveLength(2);
  });

  // ⚠️ KSeF NIEOSIĄGALNY = KAŻDY dokument odbije się tak samo. Bez tego hamulca przebieg
  // waliłby w martwe API tyle razy, ile jest niezarchiwizowanych dokumentów (przy backfillu
  // — setki), każde żądanie do limitu czasu klienta.
  it('⚠️ seria błędów z rzędu zatrzymuje archiwizację, a nie cały przebieg', async () => {
    const db = openOmsDb();
    const proby = [];
    const klient = {
      ...klientAtrapa([strona([faktura(1), faktura(2), faktura(3), faktura(4), faktura(5)])]),
      pobierzXml: async ({ ksefNumber }) => {
        proby.push(ksefNumber);
        throw new Error('KSeF nieosiągalny');
      },
    };
    const czuwacz = createCzuwaczKosztow({
      db, klient, sesja: sesjaAtrapa, teraz: wNocy, katalogArchiwum: katalogTymczasowy(), log: () => {},
    });

    const wynik = await czuwacz.przebieg();

    expect(proby).toHaveLength(LIMIT_KOLEJNYCH_BLEDOW_ARCHIWUM);
    expect(wynik.przeczytanych).toBe(5);
    expect(wynik.zarchiwizowanych).toBe(0);
    expect(stanKosztow(db).kursor).toBe('2026-06-05T10:00:00.000Z');
  });

  // ⚠️⚠️ HTTP 429 TO PROSBA O PRZERWE, NIE AWARIA ZRODLA (zmierzone na produkcji 2026-09-02).
  //
  // Przebieg pobral 16 XML-i w ~20 s, a potem KSeF odbijal kazde zadanie zdaniem „Przekroczono
  // limit 16 zadan na minute. Sprobuj ponownie po 54 sekundach". Licznik `bledyZRzedu` — pisany
  // na MARTWE zrodlo — liczyl te odmowy jak awarie i po trzech przerywal archiwizacje. Skutek:
  // archiwum dociaga 16 dokumentow na dobe, a przy backfillu od stycznia to miesiace.
  //
  // Rozstrzygniecie: odmowa z limitu ma POCZEKAC (`zCzekaniemNa429`, ksef/limit.js) i ponowic,
  // a gdy czekanie nie miesci sie w budzecie przebiegu — zakonczyc archiwizacje BEZ liczenia
  // jej jako bledu i BEZ zapalania paska awarii. Reszta wraca nastepnej nocy, dokladnie tak,
  // jak przy wyczerpanym budzecie czasu.
  it('⚠️ 429 w środku kolejki NIE przerywa archiwizacji — panel czeka i pobiera dalej', async () => {
    const db = openOmsDb();
    const spania = [];
    let odmowil = false;
    const klient = {
      ...klientAtrapa([strona([faktura(1), faktura(2), faktura(3)])]),
      pobierzXml: async ({ ksefNumber }) => {
        if (ksefNumber === 'K-3' && !odmowil) {
          odmowil = true;
          throw Object.assign(new Error('KSeF odmówił: HTTP 429'), {
            status: 429, retryAfterS: 1, dlaOperatora: true,
          });
        }
        return '<F/>';
      },
    };
    const czuwacz = createCzuwaczKosztow({
      db,
      klient,
      sesja: sesjaAtrapa,
      teraz: wNocy,
      katalogArchiwum: katalogTymczasowy(),
      spij: async (ms) => { spania.push(ms); },
      log: () => {},
    });

    const wynik = await czuwacz.przebieg();

    // Wszystkie trzy dokumenty w archiwum — odmowa kosztowala jedno czekanie, nie kolejke.
    expect(wynik.zarchiwizowanych).toBe(3);
    expect(sciezki(db).filter((w) => w.sciezka_xml === null)).toHaveLength(0);
    // Sekunda z odmowy plus sekunda zapasu — i ani jednego spania wiecej.
    expect(spania).toEqual([2000]);
    expect(stanKosztow(db).ostatni_blad).toBeNull();
  });

  // ⚠️⚠️ 429, KTORE NIE MIESCI SIE W BUDZECIE, KONCZY ARCHIWIZACJE SPOKOJNIE. To NIE jest
  // awaria: dokumenty sa w bazie i w sumie miesiaca, brakuje tylko plikow, a kolejka archiwum
  // jest stanem tabeli (`sciezka_xml`), wiec reszta wraca sama nastepnej nocy. Zapalenie tu
  // `ostatni_blad` znaczyloby trwale czerwony pasek przez caly backfill — czyli pasek, ktory
  // przestaje cokolwiek znaczyc i przykrywa NASTEPNA, prawdziwa awarie pobierania.
  it('⚠️ 429 bez miejsca w budżecie kończy archiwizację CICHO, bez śladu awarii', async () => {
    const db = openOmsDb();
    let chwila = new Date('2026-08-12T01:30:00Z').getTime();
    const spania = [];
    const proby = [];
    const klient = {
      ...klientAtrapa([strona([faktura(1), faktura(2)])]),
      pobierzXml: async ({ ksefNumber }) => {
        proby.push(ksefNumber);
        // Pobranie zjada budzet niemal w calosci — zostaje 10 s, a KSeF prosi o 54.
        chwila += BUDZET_ARCHIWUM_MS - 10 * 1000;
        throw Object.assign(new Error('KSeF odmówił: HTTP 429'), {
          status: 429, retryAfterS: 54, dlaOperatora: true,
        });
      },
    };
    const czuwacz = createCzuwaczKosztow({
      db,
      klient,
      sesja: sesjaAtrapa,
      teraz: () => new Date(chwila),
      katalogArchiwum: katalogTymczasowy(),
      spij: async (ms) => { spania.push(ms); },
      log: () => {},
    });

    const wynik = await czuwacz.przebieg({ wymuszony: true });

    // Ani jednego spania (czekanie nie miescilo sie w budzecie) i ani jednej proby po odmowie.
    expect(spania).toEqual([]);
    expect(proby).toEqual(['K-1']);
    expect(wynik.zarchiwizowanych).toBe(0);
    expect(wynik.przeczytanych).toBe(2);
    // Przebieg jest UDANY: dane w bazie sa kompletne, brakuje tylko plikow.
    expect(stanKosztow(db).ostatni_blad).toBeNull();
    expect(sciezki(db).filter((w) => w.sciezka_xml === null)).toHaveLength(2);
  });

  // ⚠️ HAMULEC NA MARTWE ZRODLO ZOSTAJE NIETKNIETY. Przeczekany 429 nie jest bledem, ale
  // NIE ZERUJE tez niczego: blad, ktory przyszedl po ponowieniu, liczy sie normalnie. Gdyby
  // owiniecie w `zCzekaniemNa429` gubilo ten licznik, padniety KSeF oddajacy 500 przeoralby
  // cala kolejke backfillu, dokument po dokumencie, kazde zadanie do limitu czasu klienta.
  it('⚠️ przeczekany 429 nie rozbraja hamulca na martwe zrodlo', async () => {
    const db = openOmsDb();
    const proby = [];
    const klient = {
      ...klientAtrapa([strona([faktura(1), faktura(2), faktura(3), faktura(4), faktura(5)])]),
      pobierzXml: async ({ ksefNumber }) => {
        proby.push(ksefNumber);
        // Pierwszy dokument: limit (przeczekany i ponowiony), reszta: martwe zrodlo.
        if (proby.length === 1) {
          throw Object.assign(new Error('HTTP 429'), { status: 429, retryAfterS: 1 });
        }
        throw Object.assign(new Error('KSeF nieosiągalny'), { dlaOperatora: true });
      },
    };
    const czuwacz = createCzuwaczKosztow({
      db,
      klient,
      sesja: sesjaAtrapa,
      teraz: wNocy,
      katalogArchiwum: katalogTymczasowy(),
      spij: async () => {},
      log: () => {},
    });

    const wynik = await czuwacz.przebieg();

    // Jedna proba zjedzona przez limit (ponowiona), potem trzy awarie z rzedu i stop.
    expect(proby).toHaveLength(1 + LIMIT_KOLEJNYCH_BLEDOW_ARCHIWUM);
    expect(wynik.zarchiwizowanych).toBe(0);
  });

  // ⚠️⚠️ 429 Z SEKWENCJI LOGOWANIA NIE JEST PONAWIANY — i to jest cala tresc tego testu.
  //
  // `sesja.accessToken()` (ksef/sesja.js) robi PELNE logowanie najwyzej RAZ, bo endpoint
  // `/auth/token/redeem` jest jednorazowy. Klient KSeF taguje `status: 429` KAZDA odmowe
  // z limitu, takze ta z sekwencji uwierzytelniania — gdyby ponowienie obejmowalo cale
  // `archiwizuj` (a wiec i pobranie tokenu), taka odmowa kazalaby powtorzyc logowanie do
  // czterech razy, za kazdym razem odbijajac sie od zuzytego challenge. Ponowienie siedzi
  // wiec WYLACZNIE wokol `klient.pobierzXml` (services/archiwum-kosztow.js), a odmowa
  // z logowania liczy sie jak zwykla awaria: hamulec na martwe zrodlo robi swoje.
  it('⚠️ 429 z LOGOWANIA nie jest ponawiany — liczy sie jak zwykly blad', async () => {
    const db = openOmsDb();
    const spania = [];
    let fazaArchiwum = false;
    let logowanWArchiwum = 0;
    const sesja = {
      accessToken: async () => {
        if (!fazaArchiwum) return 'ACC';
        logowanWArchiwum += 1;
        throw Object.assign(new Error('KSeF odmówił przy uwierzytelnianiu: HTTP 429'), {
          status: 429, retryAfterS: 1, dlaOperatora: true,
        });
      },
    };
    const klient = {
      ...klientAtrapa([strona([faktura(1), faktura(2), faktura(3), faktura(4), faktura(5)])]),
      pobierzXml: async () => { throw new Error('do pobrania XML-a nie mialo prawa dojsc'); },
    };
    const czuwacz = createCzuwaczKosztow({
      db,
      klient,
      sesja,
      teraz: wNocy,
      katalogArchiwum: katalogTymczasowy(),
      spij: async (ms) => { spania.push(ms); },
      // Prawdziwe `zarchiwizuj`, tylko ze znacznikiem „zaczela sie faza archiwum" — inaczej
      // atrapa sesji nie ma jak odroznic tokenu na strone metadanych od tokenu na XML-a.
      archiwizuj: (args) => { fazaArchiwum = true; return zarchiwizuj(args); },
      log: () => {},
    });

    const wynik = await czuwacz.przebieg();

    // JEDNO logowanie na dokument (zero ponowien) i stop po trzech bledach z rzedu.
    expect(logowanWArchiwum).toBe(LIMIT_KOLEJNYCH_BLEDOW_ARCHIWUM);
    expect(spania).toEqual([]);
    expect(wynik.zarchiwizowanych).toBe(0);
    // Przebieg pobierania jest udany — archiwum to dodatek do lustra w bazie.
    expect(wynik.przeczytanych).toBe(5);
  });

  // Jeden dokument, którego KSeF nie oddaje (np. odmowa dotycząca TEGO dokumentu), nie ma
  // prawa zablokować kolejki archiwum na zawsze — licznik zeruje się po każdym udanym pliku.
  it('pojedynczy nieudany dokument nie blokuje następnych', async () => {
    const db = openOmsDb();
    const klient = {
      ...klientAtrapa([strona([faktura(1), faktura(2)])]),
      pobierzXml: async ({ ksefNumber }) => {
        if (ksefNumber === 'K-2') throw new Error('nie ma takiego dokumentu');
        return '<F/>';
      },
    };
    const czuwacz = createCzuwaczKosztow({
      db, klient, sesja: sesjaAtrapa, teraz: wNocy, katalogArchiwum: katalogTymczasowy(), log: () => {},
    });

    const wynik = await czuwacz.przebieg();

    expect(wynik.zarchiwizowanych).toBe(1);
    expect(sciezki(db).find((w) => w.ksef_number === 'K-1').sciezka_xml).toBeTruthy();
    expect(sciezki(db).find((w) => w.ksef_number === 'K-2').sciezka_xml).toBeNull();
  });
});
