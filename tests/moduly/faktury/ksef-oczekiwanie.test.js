import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import {
  czekaNaKsef, WARUNEK_CZEKA_NA_KSEF_SQL, KOLUMNA_ZLECONA_Z_PANELU_SQL, czyWierszWZakresieKsef,
} from '../../../src/domena/ksef-oczekiwanie.js';
import { zajmijWysylkeKsef } from '../../../src/moduly/faktury/db/wysylki-ksef.js';

// „Faktura czekająca na KSeF" ma JEDNĄ definicję (recenzja Partii 2, W4+W5). Do 06.08.2026
// były dwie: czuwacz pytał o faktury z numerem dokumentu i UUID-em, a pasek spraw zapalał
// blokadę przy każdej fakturze „wystawionej" — czyli TAKŻE przy wierszu bez numeru, o który
// czuwacz nigdy nie zapyta. Taki wiersz po dobie meldował „Faktura  czeka na KSeF od …",
// z pustym numerem, na zawsze.
//
// Osobno: zamówienie ANULOWANE po wystawieniu faktury dostawało dwie blokady — poprawną
// („anulowane po wystawieniu faktury") i fałszywą („kupujący jej jeszcze nie ma", choć nic
// nie kupił). Anulowane wypada z OBU stron.

let licznik = 0;

function zamowienieZFaktura(db, {
  zamowienie = {}, faktura = {}, bezFaktury = false, wyslanaZPanelu = false,
} = {}) {
  licznik += 1;
  const sklep = zamowienie.sklep ?? 'allegro_szkicownia';
  const id = zapiszZamowienie(db, sklep, {
    zrodlo_id: `${sklep}-${licznik}`,
    numer: String(2000 + licznik),
    klient: { first_name: 'Jan' },
    dostawa: {},
    metoda_wysylki: 'dpd',
    kwota_pobrania: null,
    chce_fakture: 1,
    nip: null,
    kwota_brutto: '100.00',
    koszt_dostawy_brutto: '0.00',
    status_woo: 'processing',
    oplacone_at: null,
    anulowane: 0,
    utworzone_at: '2026-08-05T09:00:00',
    pozycje: [],
    ...zamowienie,
  }, {});
  // `anulowane_recznie` nie ma na liście pól UPDATE-u (to cała jego ochrona przed pollerem),
  // więc ustawiamy je wprost — tak samo jak robi to trasa zmiany statusu.
  if (zamowienie.anulowane_recznie != null) {
    db.prepare('UPDATE zamowienia SET anulowane_recznie = ? WHERE id = ?').run(zamowienie.anulowane_recznie, id);
  }
  if (!bezFaktury) {
    const f = {
      infakt_uuid: `u${licznik}`,
      numer: 'FV/12/2026',
      ksef_status: null,
      ksef_numer: null,
      allegro_wyslana_at: null,
      ...faktura,
    };
    db.prepare(
      'INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, ksef_status, ksef_numer,'
      + ' allegro_wyslana_at, utworzona_at) VALUES (?,?,?,?,?,?,?)',
    ).run(id, f.infakt_uuid, f.numer, f.ksef_status, f.ksef_numer, f.allegro_wyslana_at, '2026-08-05T10:00:00Z');
    // Dokladnie to, co robi services/wysylka-ksef.js PRZED wywolaniem inFaktu: rezerwacja
    // dokumentu w `wysylki_ksef`. To jest FAKT drugiej galezi warunku.
    if (wyslanaZPanelu && f.infakt_uuid) zajmijWysylkeKsef(db, f.infakt_uuid, { numer: f.numer });
  }
  return id;
}

describe('czekaNaKsef — jedna definicja dla czuwacza i dla paska spraw', () => {
  const czeka = (db, id) => czekaNaKsef(pobierzZamowienie(db, id));

  it('faktura z numerem, z kanału Allegro, bez numeru KSeF — czeka', () => {
    const db = openOmsDb(':memory:');
    expect(czeka(db, zamowienieZFaktura(db))).toBe(true);
    db.close();
  });

  // ⚠️ W4. inFakt potrafi oddać sukces BEZ pola `number` (widok ma na to osobny przypadek).
  // Taki wiersz jest „wystawiony", ale czuwacz NIGDY o niego nie zapyta — a pasek pokazywał
  // przy nim blokadę z pustym numerem.
  it('wiersz bez numeru dokumentu NIE czeka — czuwacz o niego nie zapyta', () => {
    const db = openOmsDb(':memory:');
    expect(czeka(db, zamowienieZFaktura(db, { faktura: { numer: null } }))).toBe(false);
    db.close();
  });

  it('wiersz bez UUID-a w inFakcie NIE czeka — nie ma o co zapytać', () => {
    const db = openOmsDb(':memory:');
    expect(czeka(db, zamowienieZFaktura(db, { faktura: { infakt_uuid: null } }))).toBe(false);
    db.close();
  });

  // ⚠️ W5. Anulowane zamówienie ma już SWOJĄ blokadę („anulowane po wystawieniu faktury").
  // Druga, mówiąca „kupujący jej jeszcze nie ma", jest po prostu nieprawdziwa: nikt nic
  // nie kupił. Czuwacz też nie ma po co o taki dokument pytać.
  it('zamówienie anulowane w sklepie NIE czeka', () => {
    const db = openOmsDb(':memory:');
    expect(czeka(db, zamowienieZFaktura(db, { zamowienie: { anulowane: 1 } }))).toBe(false);
    db.close();
  });

  it('zamówienie anulowane RĘCZNIE też nie czeka', () => {
    const db = openOmsDb(':memory:');
    expect(czeka(db, zamowienieZFaktura(db, { zamowienie: { anulowane_recznie: 1 } }))).toBe(false);
    db.close();
  });

  it('rezerwacja „w toku" i „do wyjaśnienia" nie czekają', () => {
    const db = openOmsDb(':memory:');
    expect(czeka(db, zamowienieZFaktura(db, { faktura: { ksef_status: 'w_toku' } }))).toBe(false);
    expect(czeka(db, zamowienieZFaktura(db, { faktura: { ksef_status: 'do_wyjasnienia' } }))).toBe(false);
    db.close();
  });

  it('faktura z numerem KSeF i faktura wysłana już do Allegro nie czekają', () => {
    const db = openOmsDb(':memory:');
    expect(czeka(db, zamowienieZFaktura(db, { faktura: { ksef_numer: 'KS-1' } }))).toBe(false);
    expect(czeka(db, zamowienieZFaktura(db, { faktura: { allegro_wyslana_at: '2026-08-06T09:00:00Z' } })))
      .toBe(false);
    db.close();
  });

  it('sklep, „allegrowy" i kupujący bez prośby o fakturę nie czekają', () => {
    const db = openOmsDb(':memory:');
    expect(czeka(db, zamowienieZFaktura(db, { zamowienie: { sklep: 'szkicownia' } }))).toBe(false);
    expect(czeka(db, zamowienieZFaktura(db, { zamowienie: { sklep: 'allegrowy' } }))).toBe(false);
    expect(czeka(db, zamowienieZFaktura(db, { zamowienie: { chce_fakture: 0 } }))).toBe(false);
    db.close();
  });

  it('zamówienie bez faktury nie czeka na nic', () => {
    const db = openOmsDb(':memory:');
    expect(czeka(db, zamowienieZFaktura(db, { bezFaktury: true }))).toBe(false);
    db.close();
  });

  // ⚠️⚠️ DRUGA GAŁĄŹ (06.08.2026). Do tego dnia „czeka na KSeF" znaczyło WYŁĄCZNIE „kanał
  // Allegro", bo tylko tam numer miał komu służyć. Od chwili, gdy panel sam wysyła dokumenty
  // do KSeF, faktura SKLEPOWA też czeka — na numer, po który nikt inny nie pójdzie.
  it('faktura sklepowa, której wysyłkę do KSeF zlecił PANEL — czeka', () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db, { zamowienie: { sklep: 'szkicownia' }, wyslanaZPanelu: true });
    expect(czeka(db, id)).toBe(true);
    db.close();
  });

  // ⚠️ TO JEST CAŁE DŁAWIENIE. Dokument, którego nikt nie wysłał, numeru w bazie nie dostanie
  // NIGDY — bez tej granicy pytanie objęłoby całe archiwum sprzedaży, co godzinę, na zawsze.
  it('faktura sklepowa, której panel nie wysyłał, nie czeka', () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db, { zamowienie: { sklep: 'szkicownia' } });
    expect(czeka(db, id)).toBe(false);
    db.close();
  });

  // Gałąź druga o kanał NIE PYTA — także wtedy, gdy klucz sklepu wygląda „prawie jak" allegrowy.
  it('sklep „allegrowy" wysłany z panelu czeka — po fakcie wysyłki, nie po nazwie kanału', () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db, { zamowienie: { sklep: 'allegrowy' }, wyslanaZPanelu: true });
    expect(czeka(db, id)).toBe(true);
    db.close();
  });

  // Gałęzie są ALTERNATYWĄ, nie koniunkcją: część wspólna dalej obowiązuje OBIE. Dokument
  // z numerem KSeF nie czeka na nic, choćby panel zlecił jego wysyłkę.
  it('wysłana z panelu, ale mająca już numer KSeF — nie czeka', () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db, {
      zamowienie: { sklep: 'szkicownia' }, faktura: { ksef_numer: 'KS-9' }, wyslanaZPanelu: true,
    });
    expect(czeka(db, id)).toBe(false);
    db.close();
  });
});

// ⚠️⚠️ TO JEST TEST, DLA KTÓREGO POWSTAŁ TEN MODUŁ. Warunek SQL (czuwacz) i predykat
// domeny (pasek spraw) MUSZĄ dawać tę samą odpowiedź — inaczej rozjadą się przy pierwszej
// zmianie reguły i panel znowu zacznie meldować blokadę przy dokumencie, o który nigdy nie
// zapytał. Zestaw niżej obchodzi KAŻDĄ granicę definicji naraz.
//
// ⚠️ Rozpoznanie kanału rozstrzyga PREDYKAT (`czyKanalAllegro` wewnątrz `czyWierszWZakresieKsef`),
// nie SQL: `LIKE` w SQLite jest dla ASCII niewrażliwe na wielkość liter, więc `ALLEGRO_SZKICOWNIA`
// wchodzi do zapytania i wypada dopiero na filtrze. Dokładnie tak, jak używa tego czuwacz.
//
// ⚠️⚠️ FILTR JEST `czyWierszWZakresieKsef`, A NIE GOŁY `czyKanalAllegro` — i to jest ta sama
// pułapka, którą musiał ominąć czuwacz. Filtr po kanale, puszczony bezwarunkowo, wyciąłby
// z wyniku SQL-a KAŻDY wiersz drugiej gałęzi, a test wciąż byłby zielony: obie strony milczałyby
// zgodnie o fakturach sklepowych, o które właśnie chodzi.
describe('warunek SQL i predykat domeny odpowiadają IDENTYCZNIE', () => {
  it('na całym zestawie granicznych przypadków', () => {
    const db = openOmsDb(':memory:');
    const przypadki = [
      {},
      { zamowienie: { sklep: 'szkicownia' } },
      { zamowienie: { sklep: 'allegrowy' } },
      { zamowienie: { sklep: 'ALLEGRO_SZKICOWNIA' } },
      { zamowienie: { sklep: 'allegro_amarka' } },
      { zamowienie: { chce_fakture: 0 } },
      { zamowienie: { anulowane: 1 } },
      { zamowienie: { anulowane_recznie: 1 } },
      { faktura: { numer: null } },
      { faktura: { infakt_uuid: null } },
      { faktura: { ksef_numer: 'KS-1' } },
      { faktura: { allegro_wyslana_at: '2026-08-06T09:00:00Z' } },
      { faktura: { ksef_status: 'w_toku' } },
      { faktura: { ksef_status: 'do_wyjasnienia' } },
      { faktura: { ksef_status: 'sent' } },
      { bezFaktury: true },
      // ⚠️ DRUGA GAŁĄŹ przy KAŻDEJ granicy, którą mogłaby przesunąć: sklep zwykły i taki, który
      // `LIKE` łapie, a `czyKanalAllegro` odrzuca; do tego część wspólna, obowiązująca OBIE
      // gałęzie (numer KSeF już jest, zamówienie anulowane, kupujący faktury nie chciał,
      // dokument bez numeru).
      { zamowienie: { sklep: 'szkicownia' }, wyslanaZPanelu: true },
      { zamowienie: { sklep: 'allegrowy' }, wyslanaZPanelu: true },
      { zamowienie: { sklep: 'ALLEGRO_SZKICOWNIA' }, wyslanaZPanelu: true },
      { zamowienie: { sklep: 'szkicownia' }, faktura: { ksef_numer: 'KS-2' }, wyslanaZPanelu: true },
      { zamowienie: { sklep: 'szkicownia', anulowane: 1 }, wyslanaZPanelu: true },
      { zamowienie: { sklep: 'szkicownia', chce_fakture: 0 }, wyslanaZPanelu: true },
      { zamowienie: { sklep: 'szkicownia' }, faktura: { numer: null }, wyslanaZPanelu: true },
    ];
    const idy = przypadki.map((p) => zamowienieZFaktura(db, p));

    const zeSqla = new Set(db.prepare(`
      SELECT f.zamowienie_id, z.sklep, ${KOLUMNA_ZLECONA_Z_PANELU_SQL}
      FROM faktury f
      JOIN zamowienia z ON z.id = f.zamowienie_id
      WHERE ${WARUNEK_CZEKA_NA_KSEF_SQL}
    `).all().filter(czyWierszWZakresieKsef).map((w) => w.zamowienie_id));

    const zPredykatu = new Set(idy.filter((id) => czekaNaKsef(pobierzZamowienie(db, id))));

    expect([...zeSqla].sort()).toEqual([...zPredykatu].sort());
    // Zestaw ma zawierać CHOĆ JEDEN przypadek pozytywny — inaczej dwie puste odpowiedzi
    // byłyby zgodne i test nie dowodziłby niczego.
    expect(zPredykatu.size).toBeGreaterThan(0);
    db.close();
  });
});
