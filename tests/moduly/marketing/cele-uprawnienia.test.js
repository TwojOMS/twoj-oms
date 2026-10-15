import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb, dosypPtaszekCeli, MIGRACJA_PTASZEK_CELE } from '../../../src/oms/db/db.ts';
import { zalozKonto, ustawUprawnienia, uprawnieniaKonta } from '../../../src/core/bezpieczenstwo/konta.js';
import { ekranyRoli } from '../../../src/domena/ekrany.js';

// ⚠️⚠️ DZIURA ZGLOSZONA PRZEZ DRUGA SESJE (13.09.2026), ZANIM WDROZENIE POSZLO NA NAS-a.
// Dopisanie `cele` do EKRANY i do presetow rol zmienia WYLACZNIE konta zakladane OD TERAZ —
// `zalozKonto` wola `ekranyRoli(rola)` raz, przy zakladaniu. Konta juz istniejace maja swoje
// ptaszki ZAPISANE w tabeli `uprawnienia` i nowego nie dostaja.
//
// Skutek bez tej migracji: konto `ewa` (rola `sprzedaz`, admin=0) dostaje na `/cele` 403,
// a straznik ukrywa jej TAKZE pozycje w menu i ikone w pasku — czyli z jej strony wdrozenie
// wyglada jak „nic sie nie zmienilo". Zadne 500, zaden slad w logu.
//
// ⚠️ ZADEN TEST SUITY TEGO NIE LAPAL: testy startuja na PUSTEJ tabeli kont, gdzie konto
// z `.env` jest pelnym adminem, a admin omija ptaszki. Suita byla zielona, bo nikt nie patrzyl
// — dokladnie ta odmiana falszywej zieleni, ktorej pilnuje sekcja 10 PRZEWODNIKA.

// Konto „sprzed" tej migracji: preset roli minus `cele`, i bez sladu, ze migracja tu byla.
const bezPtaszka = (db, { login, rola }) => {
  const id = zalozKonto(db, { login, imie: login, haslo: 'x', rola, admin: false });
  ustawUprawnienia(db, id, ekranyRoli(rola).filter((k) => k !== 'cele'));
  // ⚠️ `openOmsDb` odpalil juz migracje na PUSTEJ tabeli kont i znacznik ZOSTAL. Bez jego
  // skasowania drugie wywolanie byloby gwarantowanym no-opem — test nie testowalby niczego.
  db.prepare('DELETE FROM migracje_jednorazowe WHERE nazwa = ?').run(MIGRACJA_PTASZEK_CELE);
  db.prepare('DELETE FROM uprawnienia_rozdane WHERE klucz = ?').run('cele');
  return id;
};

// Baza PLIKOWA, nie `:memory:` — jedyny sposob, zeby ja zamknac i otworzyc PONOWNIE, czyli
// zeby test zobaczyl migracje przechodzaca przez jej PRAWDZIWE miejsce wywolania (`openOmsDb`),
// a nie tylko przez eksport wolany wprost. Zakomentowanie wywolania w `openOmsDb` przechodzi
// inaczej na zielono — sprawdzone mutacja.
const plikBazy = () => join(mkdtempSync(join(tmpdir(), 'oms-cele-upr-')), 'oms.sqlite');

describe('dosypPtaszekCeli', () => {
  it('rola Sprzedaż dostaje ptaszek — to jest konto Agi', () => {
    const db = openOmsDb(':memory:');
    const id = bezPtaszka(db, { login: 'ewa', rola: 'sprzedaz' });
    expect(uprawnieniaKonta(db, id).has('cele')).toBe(false);
    dosypPtaszekCeli(db);
    expect(uprawnieniaKonta(db, id).has('cele')).toBe(true);
  });

  it('rola Administrator dostaje ptaszek', () => {
    const db = openOmsDb(':memory:');
    const id = bezPtaszka(db, { login: 'adam', rola: 'administrator' });
    dosypPtaszekCeli(db);
    expect(uprawnieniaKonta(db, id).has('cele')).toBe(true);
  });

  it('rola Produkcja ptaszka NIE dostaje i dostac nie ma', () => {
    // „Role sa presetem, ptaszki sa prawda" — ale dla ekranu, ktorego wczoraj nie bylo,
    // zadnej decyzji czlowieka nie ma, wiec nie ma czego respektowac. Preset rozstrzyga.
    const db = openOmsDb(':memory:');
    const id = bezPtaszka(db, { login: 'pakowacz', rola: 'produkcja' });
    dosypPtaszekCeli(db);
    expect(uprawnieniaKonta(db, id).has('cele')).toBe(false);
  });

  it('NIE rusza pozostalych ptaszkow konta', () => {
    const db = openOmsDb(':memory:');
    const id = bezPtaszka(db, { login: 'ewa', rola: 'sprzedaz' });
    const przed = [...uprawnieniaKonta(db, id)].sort();
    dosypPtaszekCeli(db);
    const po = [...uprawnieniaKonta(db, id)].sort();
    expect(po).toEqual([...przed, 'cele'].sort());
  });

  it('SZANUJE swiadome odebranie ptaszka: drugi przebieg go NIE przywraca', () => {
    // Po wykonaniu migracji znacznik zostaje. Gdyby migracja chodzila przy kazdym starcie
    // kontenera bez znacznika, cofalaby decyzje operatora, ktory komus `cele` odebral —
    // i robilaby to po cichu, raz na restart.
    const db = openOmsDb(':memory:');
    const id = bezPtaszka(db, { login: 'ewa', rola: 'sprzedaz' });
    dosypPtaszekCeli(db);
    ustawUprawnienia(db, id, [...uprawnieniaKonta(db, id)].filter((k) => k !== 'cele'));
    dosypPtaszekCeli(db);
    expect(uprawnieniaKonta(db, id).has('cele')).toBe(false);
  });

  it('jest IDEMPOTENTNA — kontener migruje przy kazdym starcie', () => {
    const db = openOmsDb(':memory:');
    const id = bezPtaszka(db, { login: 'ewa', rola: 'sprzedaz' });
    dosypPtaszekCeli(db);
    dosypPtaszekCeli(db);
    dosypPtaszekCeli(db);
    const ile = db.prepare(
      "SELECT COUNT(*) AS n FROM uprawnienia WHERE konto_id = ? AND ekran = 'cele'",
    ).get(id).n;
    expect(ile).toBe(1);
  });
});

describe('migracja jedzie przez PRAWDZIWE miejsce wywolania, nie tylko przez eksport', () => {
  it('ponowne otwarcie bazy PLIKOWEJ dosypuje ptaszek', () => {
    // ⚠️ TO JEST TEST, KTORY LAPIE ZAPOMNIANE WYWOLANIE W `openOmsDb`. Sam eksport wolany
    // wprost przechodzi na zielono takze wtedy, gdy nikt go nie podpial do startu panelu.
    const plik = plikBazy();
    const pierwsza = openOmsDb(plik);
    const id = bezPtaszka(pierwsza, { login: 'ewa', rola: 'sprzedaz' });
    expect(uprawnieniaKonta(pierwsza, id).has('cele')).toBe(false);
    pierwsza.close();

    const druga = openOmsDb(plik);
    expect(uprawnieniaKonta(druga, id).has('cele')).toBe(true);
    druga.close();
  });
});
