import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb, dosypPtaszekStatystyk, MIGRACJA_PTASZEK_STATYSTYKI } from '../../../src/oms/db/db.ts';
import { zalozKonto, ustawUprawnienia, uprawnieniaKonta } from '../../../src/core/bezpieczenstwo/konta.js';
import { ekranyRoli } from '../../../src/domena/ekrany.js';

// Zakłada konto „sprzed" tej migracji: preset roli, ale bez wskazanych ekranów (domyślnie
// samego `statystyki`) — i bez śladu, że migracja kiedykolwiek widziała tę bazę.
//
// ⚠️⚠️ ODSTĘPSTWO OD BRIEFU (ma uzasadnienie w tym repo): `openOmsDb(':memory:')` woła
// `dosypPtaszekStatystyk` automatycznie — na PUSTEJ jeszcze tabeli `konta` — i ZNACZNIK
// w `migracje_jednorazowe` zostaje trwały (ta sama zasada co przy `przemianujHosting`,
// tests/oms/db-koszty.test.js `bazaSprzedZmiany`: migracja dokłada to, czego brakuje, i NIE
// WOLNO jej cofać decyzji operatora przy kolejnym restarcie). Bez usunięcia znacznika drugie,
// jawne wywołanie w teście byłoby więc gwarantowanym no-opem — nie testowałoby niczego. Kasujemy
// WYŁĄCZNIE znacznik TEJ migracji (nie całą tabelę, jak `bazaSprzedZmiany` — inne migracje
// startowe nie mają tu czego dotyczyć), żeby zasymulować konto „sprzed" tego zadania.
const bezPtaszkow = (db, { login, rola, brakEkranow = ['statystyki'] }) => {
  const id = zalozKonto(db, { login, imie: login, haslo: 'x', rola, admin: false });
  const brak = new Set(brakEkranow);
  ustawUprawnienia(db, id, ekranyRoli(rola).filter((k) => !brak.has(k)));
  db.prepare('DELETE FROM migracje_jednorazowe WHERE nazwa = ?').run(MIGRACJA_PTASZEK_STATYSTYKI);
  db.prepare('DELETE FROM uprawnienia_rozdane WHERE klucz = ?').run('statystyki');
  return id;
};

// Baza PLIKOWA (nie `:memory:`) — jedyny sposób, żeby ją zamknąć i otworzyć PONOWNIE, czyli
// żeby test zobaczył migrację przechodzącą przez jej PRAWDZIWE miejsce wywołania (`openOmsDb`),
// a nie tylko przez eksport `dosypPtaszekStatystyk` wprost. Ten sam wzorzec, co
// tests/oms/db-koszty.test.js (`plikBazy`, `bazaSprzedZmiany`).
const plikBazy = () => join(mkdtempSync(join(tmpdir(), 'oms-statystyki-')), 'oms.sqlite');

describe('dosypPtaszekStatystyk', () => {
  it('rola Sprzedaż dostaje ptaszek', () => {
    const db = openOmsDb(':memory:');
    const id = bezPtaszkow(db, { login: 'ewa', rola: 'sprzedaz' });
    dosypPtaszekStatystyk(db);
    expect(uprawnieniaKonta(db, id)).toContain('statystyki');
  });

  // ⚠️ Osoba pakująca ma widzieć zamówienia i przesyłki, nie statystyki sprzedaży.
  it('rola Produkcja ptaszka NIE dostaje', () => {
    const db = openOmsDb(':memory:');
    const id = bezPtaszkow(db, { login: 'pakowacz', rola: 'produkcja' });
    dosypPtaszekStatystyk(db);
    expect(uprawnieniaKonta(db, id)).not.toContain('statystyki');
  });

  // ⚠️ ODSTĘPSTWO OD BRIEFU: `uprawnieniaKonta` oddaje `Set` (potwierdzone w
  // tests/oms/konta-db.test.js, „oddaje pusty Set"), a `Set` nie ma `.every`/`.length` —
  // stąd `[...przed]` i `.size` zamiast literalnych wywołań z briefu.
  it('nie rusza żadnego istniejącego ptaszka', () => {
    const db = openOmsDb(':memory:');
    const id = bezPtaszkow(db, { login: 'ewa', rola: 'sprzedaz' });
    const przed = [...uprawnieniaKonta(db, id)];
    dosypPtaszekStatystyk(db);
    const po = uprawnieniaKonta(db, id);
    expect(przed.every((k) => po.has(k))).toBe(true);
    expect(po.size).toBe(przed.length + 1);
  });

  // ⚠️⚠️ REGUŁA „DOSYPUJEMY WYŁĄCZNIE PTASZEK `statystyki`" (recenzja: podmiana ciała pętli na
  // `for (const e of ekranyRoli(k.rola)) wstaw.run(k.id, e)` przywracałaby KAŻDY ptaszek
  // presetu roli, nie tylko `statystyki` — 5/5 zielone bez tego testu). Kontu trzeba odebrać
  // DWA ptaszki: odebranie samego `statystyki` nie odróżnia „dosypujemy jeden ekran" od
  // „dosypujemy cały preset roli", bo to jedyny ekran, którego wtedy brakuje.
  it('przywraca WYŁĄCZNIE ptaszek statystyki — inny świadomie odebrany zostaje odebrany', () => {
    const db = openOmsDb(':memory:');
    const id = bezPtaszkow(db, {
      login: 'ewa', rola: 'sprzedaz', brakEkranow: ['statystyki', 'kampania'],
    });
    dosypPtaszekStatystyk(db);
    const po = uprawnieniaKonta(db, id);
    expect(po).toContain('statystyki');
    expect(po).not.toContain('kampania');
  });

  // ⚠️ DWA PRZEBIEGI — kontener migruje przy KAŻDYM starcie. Drugi przebieg nie ma prawa
  // ani zdublować wiersza, ani rzucić na indeksie unikalnym.
  it('jest idempotentna — dwa przebiegi dają ten sam stan', () => {
    const db = openOmsDb(':memory:');
    const id = bezPtaszkow(db, { login: 'ewa', rola: 'sprzedaz' });
    dosypPtaszekStatystyk(db);
    const poPierwszym = uprawnieniaKonta(db, id).size;
    dosypPtaszekStatystyk(db);
    expect(uprawnieniaKonta(db, id).size).toBe(poPierwszym);
    expect([...uprawnieniaKonta(db, id)].filter((k) => k === 'statystyki')).toHaveLength(1);
    // ⚠️⚠️ DOPISANE PRZY SAMOPRZEGLĄDZIE MUTACYJNYM: usunięcie zapisu do
    // `migracje_jednorazowe` nie psuło żadnej z powyższych asercji (Set i tak nie dopuszcza
    // duplikatu), więc drugi przebieg mógłby po cichu ZNOWU skanować całą tabelę `konta` —
    // brak szkody dziś, ale też brak dowodu, że migracja rzeczywiście przestaje pracować.
    // Znacznik ma zostać DOKŁADNIE RAZ, nie przy każdym wywołaniu.
    expect(
      db.prepare('SELECT COUNT(*) c FROM migracje_jednorazowe WHERE nazwa = ?')
        .get(MIGRACJA_PTASZEK_STATYSTYKI).c,
    ).toBe(1);
  });

  // ⚠️ NAPRAWIONE PO RECENZJI: `openOmsDb(':memory:')` zdąża zawsze dołożyć znacznik jako
  // pierwsze (na PUSTEJ jeszcze tabeli `konta`, w samym pipeline'ie migracji) — bez jawnego
  // skasowania go tutaj to wywołanie zawracałoby na bramce i NIGDY nie dochodziłoby do pętli,
  // więc nazwany bezpiecznik przed „panelem, który nie startuje" nic by nie sprawdzał.
  it('pusta tabela kont nie wybucha', () => {
    const db = openOmsDb(':memory:');
    db.prepare('DELETE FROM migracje_jednorazowe WHERE nazwa = ?').run(MIGRACJA_PTASZEK_STATYSTYKI);
    expect(() => dosypPtaszekStatystyk(db)).not.toThrow();
  });

  // ⚠️⚠️ MIGRACJA WOŁANA Z PRAWDZIWEGO MIEJSCA WYWOŁANIA. Wszystkie testy powyżej wołają
  // `dosypPtaszekStatystyk` BEZPOŚREDNIO z importu — żaden nie sprawdza, że `openOmsDb`
  // w ogóle ją woła (src/oms/db/db.js, ~linia 115). Zakomentowanie tego jednego wywołania
  // zostawiało całą resztę suity kont/uprawnień/ekranów (74/74) zieloną — czyli dokładnie tę
  // regresję, przed którą stoi to zadanie (konto `ewa` dostaje 403 po wdrożeniu), nie łapał
  // ani jeden test w repo. Wzorzec: tests/oms/db-koszty.test.js, `bazaSprzedZmiany` — baza
  // PLIKOWA, stan „sprzed", zamknięcie, ponowne otwarcie przez `openOmsDb(ta sama ścieżka)`.
  describe('wywołanie przez openOmsDb — baza plikowa, zamknięcie i ponowne otwarcie', () => {
    it('konto sprzed migracji dostaje ptaszek statystyki przy najbliższym starcie', () => {
      const sciezka = plikBazy();
      const db1 = openOmsDb(sciezka);
      const id = bezPtaszkow(db1, { login: 'ewa', rola: 'sprzedaz' });
      db1.close();

      const db2 = openOmsDb(sciezka);
      expect(uprawnieniaKonta(db2, id)).toContain('statystyki');
      db2.close();
    });

    // ⚠️⚠️ SKUTEK BRAMKI, NIE JEJ ŚLAD (recenzja: `if (zrobione) return;` → `if (false)
    // return;`, 5/5 zielone — asercja z 7aeb940 dowodzi tylko, że wiersz znacznika powstaje
    // raz, nie że bramka go CZYTA i ZAWRACA). „Role są presetem, ptaszki są prawdą": raz
    // wykonana migracja nie ma prawa cofać decyzji człowieka. Operator odbiera kontu ptaszek
    // `statystyki` PO TYM, jak migracja już przeszła (znacznik stoi w bazie) — kolejny start
    // (drugie otwarcie tej samej bazy plikowej) nie ma prawa go przywrócić.
    it('⚠️ po wykonaniu NIE przywraca ptaszka, który operator świadomie odebrał', () => {
      const sciezka = plikBazy();
      // Pierwsze otwarcie: baza świeża, zero kont — migracja przechodzi od razu (no-op na
      // pustej tabeli) i zostawia znacznik w `migracje_jednorazowe`.
      const db1 = openOmsDb(sciezka);
      const id = zalozKonto(db1, {
        login: 'ewa', imie: 'ewa', haslo: 'x', rola: 'sprzedaz', admin: false,
      });
      expect(uprawnieniaKonta(db1, id)).toContain('statystyki');
      // Operator ŚWIADOMIE odbiera ptaszek — decyzja człowieka, nie stan „sprzed migracji".
      ustawUprawnienia(db1, id, ekranyRoli('sprzedaz').filter((k) => k !== 'statystyki'));
      db1.close();

      // Drugie otwarcie: ten sam plik, znacznik migracji JUŻ stoi w bazie.
      const db2 = openOmsDb(sciezka);
      expect(uprawnieniaKonta(db2, id)).not.toContain('statystyki');
      db2.close();
    });
  });
});
