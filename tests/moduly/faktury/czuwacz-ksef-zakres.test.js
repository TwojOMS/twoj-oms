import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijFakture, zakonczFakture } from '../../../src/moduly/faktury/db/faktury.js';
import { zajmijWysylkeKsef } from '../../../src/moduly/faktury/db/wysylki-ksef.js';
import { createCzuwaczKsef } from '../../../src/moduly/faktury/services/czuwacz-ksef.js';

// Do 06.08.2026 czuwacz pytal WYLACZNIE o faktury z kanalow Allegro — bo tylko one mialy
// dokad pojechac. Od chwili, gdy panel sam wysyla dokumenty do KSeF (POST /faktury/ksef/wyslij),
// numer trzeba dociagnac TAKZE dla faktur sklepowych: inaczej `faktury.ksef_numer` zostaje pusty
// NA ZAWSZE, a zakladka pokazuje „brak KSeF" przy dokumencie, ktory wlasnie stamtad wyszedl.
//
// ⚠️ ROZPOZNAJEMY TO PO WIERSZU W `wysylki_ksef`, A NIE PO TRESCI WPISU W LOGU. Tabela jest
// FAKTEM (rezerwacja zapisana PRZED wywolaniem, db/wysylki-ksef.js), a zdanie w logu jest tekstem
// dla czlowieka — wolno je przeredagowac bez uprzedzenia i nikt by nie zauwazyl, ze zakres
// czuwacza wlasnie sie zawezil do zera.

let licznik = 0;

function zamowienieZFaktura(db, { sklep, wyslanaZPanelu }) {
  licznik += 1;
  const uuid = `uuid-${sklep}-${licznik}`;
  const id = zapiszZamowienie(db, sklep, {
    zrodlo_id: `${sklep}-${licznik}`,
    numer: String(3000 + licznik),
    klient: { first_name: 'Jan' },
    dostawa: {},
    metoda_wysylki: 'dpd',
    kwota_pobrania: null,
    chce_fakture: 1,
    nip: null,
    kwota_brutto: '123.00',
    koszt_dostawy_brutto: '0.00',
    status_woo: 'processing',
    oplacone_at: null,
    anulowane: 0,
    utworzone_at: '2026-08-05T09:00:00',
    pozycje: [],
  }, {});
  const f = rozpocznijFakture(db, id);
  zakonczFakture(db, f.id, { uuid, numer: '1/08/2026', ksefStatus: null });
  // Dokladnie to, co robi services/wysylka-ksef.js przed wywolaniem inFaktu.
  if (wyslanaZPanelu) zajmijWysylkeKsef(db, uuid, { numer: '1/08/2026' });
  return uuid;
}

function pytaniaCzuwacza(db, ksefNumer = null, opcje = {}) {
  const pytane = [];
  return {
    pytane,
    czuwacz: createCzuwaczKsef({
      db,
      infakt: {
        pobierzFakture: async (uuid) => {
          pytane.push(uuid);
          return { numer: '1/08/2026', ksefNumer };
        },
      },
      ...opcje,
    }),
  };
}

const dniTemu = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

// Przesuwa fakture w czasie tak, jak zrobilaby to prawdziwa historia: `utworzona_at` to
// WYSTAWIENIE dokumentu, `wysylki_ksef.zlecona_at` to moment, w ktorym panel zlecil wysylke.
function przesunWCzasie(db, uuid, { wystawiona, zlecona }) {
  if (wystawiona) db.prepare('UPDATE faktury SET utworzona_at = ? WHERE infakt_uuid = ?').run(wystawiona, uuid);
  if (zlecona) db.prepare('UPDATE wysylki_ksef SET zlecona_at = ? WHERE uuid = ?').run(zlecona, uuid);
}

describe('zakres czuwacza po dolozeniu wysylki z panelu', () => {
  it('pyta o fakturę SKLEPOWĄ wysłaną z panelu', async () => {
    const db = openOmsDb(':memory:');
    const uuid = zamowienieZFaktura(db, { sklep: 'pro', wyslanaZPanelu: true });
    const { pytane, czuwacz } = pytaniaCzuwacza(db, 'KSEF-1');

    await czuwacz.przebieg();

    expect(pytane).toEqual([uuid]);
    expect(db.prepare('SELECT ksef_numer FROM faktury').get().ksef_numer).toBe('KSEF-1');
    db.close();
  });

  // ⚠️ TO JEST CALE DLAWIENIE. Faktura sklepowa, ktorej nikt nie wyslal z panelu, numeru KSeF
  // w bazie nie dostanie NIGDY — bez tego warunku czuwacz pytalby o cale archiwum sprzedazy,
  // co godzine, w nieskonczonosc.
  it('NIE pyta o fakturę sklepową, której panel nie wysyłał', async () => {
    const db = openOmsDb(':memory:');
    zamowienieZFaktura(db, { sklep: 'pro', wyslanaZPanelu: false });
    const { pytane, czuwacz } = pytaniaCzuwacza(db);

    await czuwacz.przebieg();

    expect(pytane).toEqual([]);
    db.close();
  });

  it('faktury allegrowe pyta dalej, jak dotąd', async () => {
    const db = openOmsDb(':memory:');
    const uuid = zamowienieZFaktura(db, { sklep: 'allegro_szkicownia', wyslanaZPanelu: false });
    const { pytane, czuwacz } = pytaniaCzuwacza(db);

    await czuwacz.przebieg();

    expect(pytane).toEqual([uuid]);
    db.close();
  });

  // ⚠️ FILTR PO ZAPYTANIU MA DZIALAC WYLACZNIE NA GALAZ ALLEGROWA. `LIKE` w SQLite jest dla ASCII
  // NIEWRAZLIWE NA WIELKOSC LITER, wiec sklep `ALLEGRO_PRO` wchodzi do zapytania galezia allegrowa,
  // a `czyKanalAllegro` (wrazliwe) go wyrzuca — i o to chodzi, dopoki panel tego dokumentu nie
  // wyslal. Gdy wyslal, wiersz zostaje: pyta o niego DRUGA galaz, ktorej kanal nie obchodzi.
  it('sklep „ALLEGRO_PRO" bez wysyłki z panelu wypada, a z wysyłką zostaje', async () => {
    const db = openOmsDb(':memory:');
    zamowienieZFaktura(db, { sklep: 'ALLEGRO_PRO', wyslanaZPanelu: false });
    const uuid = zamowienieZFaktura(db, { sklep: 'ALLEGRO_PRO', wyslanaZPanelu: true });
    const { pytane, czuwacz } = pytaniaCzuwacza(db);

    await czuwacz.przebieg();

    expect(pytane).toEqual([uuid]);
    db.close();
  });

  // ⚠️ PODLOGA OBOWIAZUJE OBIE GALEZIE. Poszerzenie zakresu zwieksza ruch, wiec dlawienie jest
  // teraz WAZNIEJSZE, a nie mniej wazne: dokument, ktory numeru nigdy nie dostanie (wysylka
  // odrzucona przez organ, dokument skasowany), inaczej siedzialby w zapytaniu 24 razy na dobe
  // do konca swiata.
  //
  // ⚠️⚠️ ZDARZENIEM WEJSCIOWYM DRUGIEJ GALEZI JEST ZLECENIE WYSYLKI, NIE WYSTAWIENIE DOKUMENTU
  // (recenzja, K1). Do poprawki stalo tu wylacznie przesuniecie `utworzona_at` — a to znaczylo,
  // ze podloga liczy sie od zdarzenia, ktore z ta galezia nie ma nic wspolnego. Test przesuwa
  // wiec OBA stemple: dokument wystawiony dawno I wyslany dawno naprawde wypada.
  it('faktura sklepowa wysłana dawniej niż podłoga wypada', async () => {
    const db = openOmsDb(':memory:');
    const uuid = zamowienieZFaktura(db, { sklep: 'pro', wyslanaZPanelu: true });
    przesunWCzasie(db, uuid, { wystawiona: dniTemu(60), zlecona: dniTemu(31) });
    const { pytane, czuwacz } = pytaniaCzuwacza(db);

    await czuwacz.przebieg();

    expect(pytane).toEqual([]);
    db.close();
  });

  // ⚠️⚠️ TO JEST TA USTERKA. Zakladka faktur jest MIESIECZNA, wiec wysylanie dokumentow
  // z zeszlego miesiaca to zwykly tryb pracy wlasciciela — a przy podlodze liczonej od
  // `utworzona_at` KAZDA taka faktura wypadala z zapytania JUZ W CHWILI WYSYLKI. `ksef_numer`
  // zostawal wtedy NULL-em na zawsze, i to po cichu: sprawa na karcie stoi na `ksef_odczyt = 'ok'`,
  // a te kolumne pisze WYLACZNIE ten czuwacz, wiec nikt by sie nie dowiedzial.
  it('faktura wystawiona dawno, ale WYSŁANA DZIŚ, jest pytana', async () => {
    const db = openOmsDb(':memory:');
    const uuid = zamowienieZFaktura(db, { sklep: 'pro', wyslanaZPanelu: true });
    przesunWCzasie(db, uuid, { wystawiona: dniTemu(60) });
    const { pytane, czuwacz } = pytaniaCzuwacza(db, 'KSEF-2');

    await czuwacz.przebieg();

    expect(pytane).toEqual([uuid]);
    expect(db.prepare('SELECT ksef_numer FROM faktury').get().ksef_numer).toBe('KSEF-2');
    db.close();
  });

  // ⚠️⚠️ PORZADEK PO DACIE OSTATNIEGO PYTANIA — dokladnie ta sama poprawka, ktora dostala juz
  // druga petla czuwacza (recenzja Partii 3, W6). Wiersz, ktory numeru NIE DOSTANIE, nie wypada
  // ze zbioru az do podlogi, a zakladka wysyla HURTOWO: jedna partia >=50 odrzuconych dokumentow
  // zajmowalaby wszystkie sloty przez 30 dni, a nowsze faktury nie bylyby zapytane ANI RAZU.
  it('dokument już pytany ustępuje miejsca temu, o który nikt nie pytał', async () => {
    const db = openOmsDb(':memory:');
    const stary = zamowienieZFaktura(db, { sklep: 'pro', wyslanaZPanelu: true });
    const nowy = zamowienieZFaktura(db, { sklep: 'pro', wyslanaZPanelu: true });
    // Stary jest STARSZY po obu dawnych kryteriach (wystawienie), a mimo to ma ustapic:
    // o niego juz pytalismy, o nowy — nigdy.
    przesunWCzasie(db, stary, { wystawiona: dniTemu(5) });
    db.prepare('UPDATE faktury SET ksef_sprawdzona_at = ? WHERE infakt_uuid = ?').run(dniTemu(0.04), stary);
    const { pytane, czuwacz } = pytaniaCzuwacza(db, null, { limit: 1 });

    await czuwacz.przebieg();

    expect(pytane).toEqual([nowy]);
    db.close();
  });
});
