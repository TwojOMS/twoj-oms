import { it, expect } from 'vitest';
import { uruchomZegary } from '../../../src/core/zegary.ts';
import { zegarMigawkiPowiadomien } from '../../../src/moduly/zamowienia/zegary.ts';
import {
  createMigawkaPowiadomien,
  ODSTEP_MIGAWKI_POWIADOMIEN_MS,
  POWOD_TRWA,
} from '../../../src/moduly/zamowienia/services/migawka-powiadomien.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { wczytajMigawke } from '../../../src/oms/db/powiadomienia-migawka.js';
import { odrzuc } from '../../../src/oms/db/ostrzezenia.js';

// Zegar migawki powiadomień: przebieg zaraz po starcie i co minutę, nigdy dwa naraz — także gdy „przelicz
// teraz" (po „Ignoruj") trafi w trwający przebieg.

const T = new Date('2026-11-18T10:00:00.000Z');
const lampa = (sku) => ({
  typ: 'niski-stan',
  klucz: `niski-stan:${sku}`,
  tekst: `Lampa ${sku} — zostały 2 szt.`,
  przycisk: { etykieta: 'Magazyn', href: '/magazyn' },
});
const mikro = () => new Promise((r) => setImmediate(r));

// Ręczne timery: zapisują, co zegar ustawił, i odpalają na żądanie.
const sztuczneTimery = () => {
  const interwaly = [];
  const timeouty = [];
  const ustawInterwal = (fn, ms) => {
    interwaly.push({ fn, ms });
    return { interwal: interwaly.length };
  };
  const ustawTimeout = (fn, ms) => {
    const u = { timeout: timeouty.length + 1, unref: () => (u.odpiety = true) };
    timeouty.push({ fn, ms, u });
    return u;
  };
  return { interwaly, timeouty, ustawInterwal, ustawTimeout };
};

it('zegar migawki rusza przy starcie procesu i potem co minutę', async () => {
  let przebiegow = 0;
  const zegar = zegarMigawkiPowiadomien({ migawka: { przebieg: async () => void przebiegow++ } });
  expect(zegar).toMatchObject({ nazwa: 'migawkaPowiadomien', odstepMs: 60_000, naStarcie: true });
  expect(ODSTEP_MIGAWKI_POWIADOMIEN_MS).toBe(60_000);

  const t = sztuczneTimery();
  const uchwyty = uruchomZegary([zegar], { ustawInterwal: t.ustawInterwal, ustawTimeout: t.ustawTimeout });
  expect(t.interwaly.map((x) => x.ms)).toEqual([60_000]);
  expect(t.timeouty.map((x) => x.ms)).toEqual([0]);
  // Przebieg startowy nie trzyma procesu przy życiu, a jego uchwyt wraca do odwołania przy zamknięciu.
  expect(t.timeouty[0].u.odpiety).toBe(true);
  expect(uchwyty).toEqual([{ interwal: 1 }, t.timeouty[0].u]);

  t.timeouty[0].fn();
  await mikro();
  expect(przebiegow).toBe(1);
  t.interwaly[0].fn();
  await mikro();
  expect(przebiegow).toBe(2);
});

it('zegar bez przebiegu przy starcie nie ustawia timeoutu', () => {
  const t = sztuczneTimery();
  uruchomZegary([{ nazwa: 'inny', odstepMs: 1000, przebieg: async () => {} }], t);
  expect(t.timeouty).toEqual([]);
});

it('start i pierwszy odstęp się nie nakładają: tyknięcie w trakcie przebiegu startowego jest pominięte', async () => {
  let zwolnij;
  let startow = 0;
  const logi = [];
  const t = sztuczneTimery();
  uruchomZegary(
    [
      {
        nazwa: 'migawkaPowiadomien',
        odstepMs: 60_000,
        naStarcie: true,
        przebieg: () => {
          startow++;
          return new Promise((r) => (zwolnij = r));
        },
      },
    ],
    { ...t, log: (x) => logi.push(x) },
  );
  t.timeouty[0].fn();
  t.interwaly[0].fn();
  expect(startow).toBe(1);
  expect(logi).toEqual(['zegar migawkaPowiadomien: poprzedni przebieg jeszcze trwa — pomijam']);
  zwolnij();
  await mikro();
  t.interwaly[0].fn();
  expect(startow).toBe(2);
  zwolnij();
  await mikro();
});

it('usługa: jeden przebieg naraz; „przelicz teraz" w trakcie powtarza przebieg po jego końcu', async () => {
  const db = openOmsDb(':memory:');
  try {
    let zwolnij;
    let zbieran = 0;
    let rownolegle = 0;
    let najwiecej = 0;
    const migawka = createMigawkaPowiadomien({
      db,
      teraz: () => T,
      zbierz: async () => {
        zbieran++;
        rownolegle++;
        najwiecej = Math.max(najwiecej, rownolegle);
        await new Promise((r) => (zwolnij = r));
        rownolegle--;
        return [lampa('LAMPA-21')];
      },
    });
    const pierwszy = migawka.przebieg();
    await mikro();
    // Zegar w trakcie: pomija, nie zbiera drugi raz.
    expect(await migawka.przebieg()).toEqual({ pominiety: true, powod: POWOD_TRWA });
    expect(zbieran).toBe(1);

    // „Ignoruj" w trakcie: trwający przebieg czytał ignorowania sprzed decyzji, więc po nim idzie drugi.
    odrzuc(db, 'niski-stan:LAMPA-21', { kto: 'magazynier', kiedy: T.toISOString() });
    const przeliczenie = migawka.przeliczTeraz();
    zwolnij();
    await mikro();
    expect(zbieran).toBe(2);
    zwolnij();
    const [a, b] = await Promise.all([pierwszy, przeliczenie]);
    expect(a).toBe(b);
    expect(najwiecej).toBe(1);
    expect(wczytajMigawke(db).map((w) => w.klucz)).toEqual(['niski-stan:LAMPA-21']);

    // Po końcu — następny przebieg normalnie.
    const kolejny = migawka.przebieg();
    await mikro();
    zwolnij();
    await kolejny;
    expect(zbieran).toBe(3);
  } finally {
    db.close();
  }
});
