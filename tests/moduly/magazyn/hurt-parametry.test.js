import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { utworzKarte, zastosujHurtem } from '../../../src/oms/db/magazyn.js';
import { POLA_HURTU, polaDoPrzeniesienia } from '../../../src/domena/magazyn-hurt.js';
import { dodajParametr, ustawWartoscKarty } from '../../../src/oms/db/parametry-kart.js';

// Edycja hurtem: głębokość, waga i parametry własne kart. Te same zasady co reszta hurtu —
// puste pole nie rusza, czyszczenie to osobny wybór, podgląd przed zapisem, odmowa całościowa.
// Dane zmyślone: lampy „Pracowni Półcień”, parametry „Kolor” i „Moc żarówki”.

const config = { auth: { user: 'adam', pass: 'x' } };
const auth = {
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
  origin: 'http://localhost',
  'content-type': 'application/x-www-form-urlencoded',
};
const STAN_PUSTY = { trwa: false, zaczety_at: null, skonczony_at: null, postep: null, kanaly: [], blad: null };

let db;
let app;
beforeEach(() => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config, magazyn: { start: vi.fn(), stan: () => STAN_PUSTY } });
});
afterEach(() => db?.close());

const AT = '2026-11-19T10:00:00.000Z';
const parametr = (dane) => {
  const w = dodajParametr(db, dane, { at: AT });
  if (!w.ok) throw new Error(w.blad);
  return w.id;
};
const kolorIMoc = () => ({
  kolor: parametr({ nazwa: 'Kolor', typ: 'lista', wartosci: 'czarny\nbiały\nmosiądz' }),
  moc: parametr({ nazwa: 'Moc żarówki', typ: 'liczba', jednostka: 'W' }),
});
const karta = (nazwa, reszta = {}) => utworzKarte(db, { nazwa, ...reszta });
const ustaw = (kartaId, parametrId, wartosc) => {
  const w = ustawWartoscKarty(db, kartaId, parametrId, wartosc, { at: AT, kto: 'import' });
  if (!w.ok) throw new Error(w.blad);
};
const wiersz = (id) => db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(id);
const wartosc = (kartaId, parametrId) =>
  db
    .prepare('SELECT wartosc, kto FROM karty_parametry WHERE karta_id = ? AND parametr_id = ?')
    .get(kartaId, parametrId);
const ileWartosci = () => db.prepare('SELECT COUNT(*) c FROM karty_parametry').get().c;

// Tablica = pole powtórzone (kilka zaznaczonych kart), tak jak wysyła je przeglądarka.
const wyslij = (url, pola) => {
  const dane = new URLSearchParams();
  for (const [k, v] of Object.entries(pola)) for (const x of [v].flat()) dane.append(k, x);
  return app.inject({ method: 'POST', url, headers: auth, payload: dane.toString() });
};
const podglad = (pola) => wyslij('/magazyn/hurt', pola);
const zatwierdz = (pola) => wyslij('/magazyn/hurt/zatwierdz', pola);

function sekcja(body, id) {
  const trafienie = new RegExp(`<(section|details)[^>]*id="${id}"[\\s\\S]*?</\\1>`).exec(body);
  if (!trafienie) throw new Error(`Na ekranie nie ma sekcji „${id}”`);
  return trafienie[0];
}
// Wiersze tabeli podglądu jako „pole | z | na” — bez znaczników, żeby porównywać treść.
const wierszePodgladu = (body) =>
  sekcja(body, 'zmiany-hurtem')
    .split('<tr')
    .slice(1)
    .map((tr) =>
      [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
        .map((m) =>
          m[1]
            .replace(/<[^>]+>/g, '')
            .replace(/\s+/g, ' ')
            .trim(),
        )
        .filter(Boolean),
    )
    .filter((k) => k.length);

// Ukryte pola i zaznaczone karty z podglądu — dokładnie to, co wysyła przycisk „Zatwierdź”.
function daneZPodgladu(body) {
  const dane = new URLSearchParams();
  for (const [input] of sekcja(body, 'zmiany-hurtem').matchAll(/<input\b[^>]*>/g)) {
    const atrybut = (nazwa) => new RegExp(`\\b${nazwa}="([^"]*)"`).exec(input)?.[1];
    const typ = atrybut('type');
    if (typ === 'hidden' || (typ === 'checkbox' && /\schecked\b/.test(input)))
      dane.append(atrybut('name'), atrybut('value'));
  }
  return Object.fromEntries([...dane.entries()].map(([k, v]) => [k, dane.getAll(k).length > 1 ? dane.getAll(k) : v]));
}
const zatwierdzZPodgladu = (body) =>
  app.inject({
    method: 'POST',
    url: '/magazyn/hurt/zatwierdz',
    headers: auth,
    payload: (() => {
      const dane = new URLSearchParams();
      for (const [k, v] of Object.entries(daneZPodgladu(body))) for (const x of [v].flat()) dane.append(k, x);
      return dane.toString();
    })(),
  });

describe('parametr własny hurtem', () => {
  it('wartość z listy: podgląd pokazuje z czego na co i nic nie zapisuje, zatwierdzenie zapisuje z autorem', async () => {
    const { kolor } = kolorIMoc();
    const a = karta('Lampa Kopuła', { sku: 'LMP-1' });
    const b = karta('Lampa Iskra', { sku: 'LMP-2' });
    ustaw(a, kolor, 'czarny');
    const r = await podglad({ zaznaczone: [String(a), String(b)], [`parametr_${kolor}`]: 'BIAŁY' });
    expect(r.statusCode).toBe(200);
    expect(wierszePodgladu(r.body)).toEqual([
      ['Lampa Iskra', 'Kolor', '—', 'biały'],
      ['Lampa Kopuła', 'Kolor', 'czarny', 'biały'],
    ]);
    expect(wartosc(a, kolor)).toEqual({ wartosc: 'czarny', kto: 'import' });
    expect(wartosc(b, kolor)).toBeUndefined();

    const zapis = await zatwierdzZPodgladu(r.body);
    expect(zapis.statusCode).toBe(200);
    expect(wartosc(a, kolor)).toEqual({ wartosc: 'biały', kto: 'adam' });
    expect(wartosc(b, kolor)).toEqual({ wartosc: 'biały', kto: 'adam' });
  });

  it('liczba trafia do bazy w zapisie kanonicznym, a na podglądzie z przecinkiem i jednostką', async () => {
    const { moc } = kolorIMoc();
    const a = karta('Lampa Kopuła');
    ustaw(a, moc, '40');
    const r = await podglad({ zaznaczone: String(a), [`parametr_${moc}`]: '12,5' });
    expect(wierszePodgladu(r.body)).toEqual([['Lampa Kopuła', 'Moc żarówki', '40 W', '12,5 W']]);
    expect((await zatwierdzZPodgladu(r.body)).statusCode).toBe(200);
    expect(wartosc(a, moc).wartosc).toBe('12.5');
  });

  it('„wyczyść wartość” usuwa wiersz; karta bez wartości nie wchodzi do podglądu', async () => {
    const { moc } = kolorIMoc();
    const a = karta('Lampa Kopuła');
    const b = karta('Lampa Iskra');
    ustaw(a, moc, '40');
    const r = await podglad({ zaznaczone: [String(a), String(b)], [`parametr_${moc}_wyczysc`]: 'tak' });
    expect(r.statusCode).toBe(200);
    expect(wierszePodgladu(r.body)).toEqual([['Lampa Kopuła', 'Moc żarówki', '40 W', '—']]);
    expect(wartosc(a, moc)).toBeDefined();
    expect((await zatwierdzZPodgladu(r.body)).statusCode).toBe(200);
    expect(wartosc(a, moc)).toBeUndefined();
  });

  it('karta, która już ma tę wartość, nie wchodzi do podglądu i nie dostaje nowego autora', async () => {
    const { kolor } = kolorIMoc();
    const a = karta('Lampa Kopuła');
    ustaw(a, kolor, 'czarny');
    const p = await podglad({ zaznaczone: String(a), [`parametr_${kolor}`]: 'czarny' });
    expect(wierszePodgladu(p.body)).toEqual([]);
    const r = await zatwierdz({ zaznaczone: String(a), [`parametr_${kolor}`]: 'czarny' });
    expect(r.statusCode).toBe(200);
    expect(wartosc(a, kolor)).toEqual({ wartosc: 'czarny', kto: 'import' });
  });

  it.each(['/magazyn/hurt', '/magazyn/hurt/zatwierdz'])(
    'wartość spoza listy w %s odmawia całego polecenia i nic nie zapisuje',
    async (url) => {
      const { kolor, moc } = kolorIMoc();
      const a = karta('Lampa Kopuła', { szerokosc_mm: 300 });
      const r = await wyslij(url, {
        zaznaczone: String(a),
        szerokosc_cm: '70',
        [`parametr_${moc}`]: '60',
        [`parametr_${kolor}`]: 'zielony',
      });
      expect(r.statusCode).toBe(400);
      expect(r.body).toContain('Kolor: „zielony” nie ma na liście');
      expect(wiersz(a).szerokosc_mm).toBe(300);
      expect(ileWartosci()).toBe(0);
    },
  );

  it.each([
    ['nieznany parametr', (p) => ({ parametr_999: 'czarny' }), /Parametru nr 999 nie ma/],
    [
      'liczba, która nie jest liczbą',
      (p) => ({ [`parametr_${p.moc}`]: 'dużo' }),
      /Moc żarówki: „dużo” to nie jest liczba/,
    ],
    [
      'wartość i „wyczyść” naraz',
      (p) => ({ [`parametr_${p.kolor}`]: 'czarny', [`parametr_${p.kolor}_wyczysc`]: 'tak' }),
      /Kolor: wybierz wartość albo „wyczyść wartość”/,
    ],
  ])('%s odmawia całości', async (_opis, pola, komunikat) => {
    const p = kolorIMoc();
    const a = karta('Lampa Kopuła', { szerokosc_mm: 300 });
    const r = await zatwierdz({ zaznaczone: String(a), szerokosc_cm: '70', ...pola(p) });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(komunikat);
    expect(wiersz(a).szerokosc_mm).toBe(300);
    expect(ileWartosci()).toBe(0);
  });

  it('puste pola parametrów to brak decyzji — ten sam komunikat co pusty formularz', async () => {
    const { kolor, moc } = kolorIMoc();
    const a = karta('Lampa Kopuła');
    const r = await podglad({ zaznaczone: String(a), [`parametr_${kolor}`]: '', [`parametr_${moc}`]: ' ' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Nie wybrałeś, co zmienić');
  });

  it('puste „nie zmieniaj” w polach wyboru panelu nie zmienia ani nie czyści tych pól', async () => {
    const { kolor } = kolorIMoc();
    const a = karta('Lampa Kopuła', { stawka_vat: '23', kategoria_glowna: 'Lampy', marka: 'Półcień', waga_g: 500 });
    ustaw(a, kolor, 'czarny');
    const r = await podglad({
      zaznaczone: String(a),
      glebokosc_cm: '20',
      stawka_vat: '',
      kategoria_glowna: '',
      marka: '',
      waga_kg: '',
      waga_kg_wyczysc: '',
      [`parametr_${kolor}`]: '',
      [`parametr_${kolor}_wyczysc`]: '',
    });
    expect(r.statusCode).toBe(200);
    expect(wierszePodgladu(r.body)).toEqual([['Lampa Kopuła', 'Głębokość', '—', '20 cm']]);
    expect((await zatwierdzZPodgladu(r.body)).statusCode).toBe(200);
    expect(wiersz(a)).toMatchObject({
      glebokosc_mm: 200,
      stawka_vat: '23',
      kategoria_glowna: 'Lampy',
      marka: 'Półcień',
      waga_g: 500,
    });
    expect(wartosc(a, kolor).wartosc).toBe('czarny');
  });

  it('podgląd przenosi do zatwierdzenia decyzje o parametrach, a nie obce pola', () => {
    expect(
      polaDoPrzeniesienia({
        parametr_3: 'czarny',
        parametr_4_wyczysc: 'tak',
        parametr_5: '',
        parametr_x: 'a',
        parametrowy: 'b',
      }),
    ).toEqual([
      { name: 'parametr_3', value: 'czarny' },
      { name: 'parametr_4_wyczysc', value: 'tak' },
    ]);
  });
});

describe('głębokość i waga hurtem', () => {
  it('podgląd pokazuje z czego na co, zatwierdzenie zapisuje milimetry i gramy', async () => {
    const a = karta('Lampa Kopuła', { glebokosc_mm: 100, waga_g: 500 });
    const r = await podglad({ zaznaczone: String(a), glebokosc_cm: '25', waga_kg: '1,25' });
    expect(r.statusCode).toBe(200);
    expect(wierszePodgladu(r.body)).toEqual([
      ['Lampa Kopuła', 'Głębokość', '10 cm', '25 cm'],
      ['Waga', '0,5 kg', '1,25 kg'],
    ]);
    expect(wiersz(a)).toMatchObject({ glebokosc_mm: 100, waga_g: 500 });
    expect((await zatwierdzZPodgladu(r.body)).statusCode).toBe(200);
    expect(wiersz(a)).toMatchObject({ glebokosc_mm: 250, waga_g: 1250 });
  });

  it('„wyczyść wartość” kasuje wymiary i wagę, a puste pole ich nie rusza', async () => {
    const a = karta('Lampa Kopuła', { szerokosc_mm: 300, wysokosc_mm: 400, glebokosc_mm: 100, waga_g: 500 });
    const r = await podglad({
      zaznaczone: String(a),
      szerokosc_cm: '',
      wysokosc_cm_wyczysc: 'tak',
      glebokosc_cm_wyczysc: 'tak',
      waga_kg_wyczysc: 'tak',
    });
    expect(wierszePodgladu(r.body)).toEqual([
      ['Lampa Kopuła', 'Wysokość', '40 cm', '—'],
      ['Głębokość', '10 cm', '—'],
      ['Waga', '0,5 kg', '—'],
    ]);
    expect((await zatwierdzZPodgladu(r.body)).statusCode).toBe(200);
    expect(wiersz(a)).toMatchObject({ szerokosc_mm: 300, wysokosc_mm: null, glebokosc_mm: null, waga_g: null });
  });

  it.each([
    [{ waga_kg: 'ciężka' }, /„ciężka” to nie jest waga w kilogramach/],
    [{ waga_kg: '0' }, /„0” to nie jest waga w kilogramach/],
    [{ waga_kg: '2', waga_kg_wyczysc: 'tak' }, /Waga: wpisz wartość albo wybierz „wyczyść wartość”/],
    [{ glebokosc_cm: '20', glebokosc_cm_wyczysc: 'tak' }, /Głębokość: wpisz wartość albo wybierz „wyczyść wartość”/],
    [{ glebokosc_cm: 'głęboko' }, /„głęboko(&#34;|") to nie jest wymiar w centymetrach/],
  ])('%j odmawia całości', async (pola, komunikat) => {
    const a = karta('Lampa Kopuła', { szerokosc_mm: 300, glebokosc_mm: 100, waga_g: 500 });
    const r = await zatwierdz({ zaznaczone: String(a), szerokosc_cm: '70', ...pola });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(komunikat);
    expect(wiersz(a)).toMatchObject({ szerokosc_mm: 300, glebokosc_mm: 100, waga_g: 500 });
  });
});

describe('pola usunięte z hurtu', () => {
  it('nazwa bez rozmiaru i oznaczenie paczkomatu nie należą do formularza hurtu', () => {
    expect(POLA_HURTU).not.toContain('nazwa_bez_rozmiaru');
    expect(POLA_HURTU).not.toContain('paczkomat');
    expect(POLA_HURTU).toEqual(expect.arrayContaining(['glebokosc_cm', 'waga_kg', 'waga_kg_wyczysc']));
  });

  it('stary formularz z tymi polami niczego nie zmienia', async () => {
    const a = karta('Lampa Kopuła – 30x45cm');
    // Karta nie zapisuje już paczkomatu, a kolumna została — ustawiamy ją wprost,
    // żeby sprawdzić, że stary POST jej nie nadpisze.
    db.prepare("UPDATE karty_produktow SET paczkomat = 'nie' WHERE id = ?").run(a);
    const przed = wiersz(a);
    expect(przed.paczkomat).toBe('nie');
    const r = await zatwierdz({ zaznaczone: String(a), paczkomat: 'tak', nazwa_bez_rozmiaru: 'tak' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Nie wybrałeś, co zmienić');
    expect(wiersz(a)).toEqual(przed);
  });
});

describe('zastosujHurtem — parametry w tej samej transakcji', () => {
  it('błąd parametru na drugiej karcie cofa wymiar i parametr pierwszej', () => {
    const { kolor } = kolorIMoc();
    const a = karta('Lampa Kopuła', { szerokosc_mm: 300 });
    const b = karta('Lampa Iskra');
    expect(() =>
      zastosujHurtem(
        db,
        [
          { id: a, zmiany: { szerokosc_mm: 700 }, parametry: { [kolor]: 'biały' } },
          { id: b, zmiany: {}, parametry: { [kolor]: 'zielony' } },
        ],
        { kto: 'adam' },
      ),
    ).toThrow(/zielony/);
    expect(wiersz(a).szerokosc_mm).toBe(300);
    expect(ileWartosci()).toBe(0);
  });

  it('karta zmieniona tylko w parametrach liczy się jako zmieniona, bez nowej daty karty', () => {
    const { kolor, moc } = kolorIMoc();
    const a = karta('Lampa Kopuła');
    ustaw(a, moc, '40');
    const przed = wiersz(a).zmieniony_at;
    const ile = zastosujHurtem(db, [{ id: a, zmiany: {}, parametry: { [kolor]: 'czarny', [moc]: null } }], {
      kto: 'adam',
      at: '2026-11-19T12:00:00.000Z',
    });
    expect(ile).toBe(1);
    expect(wartosc(a, kolor)).toEqual({ wartosc: 'czarny', kto: 'adam' });
    expect(wartosc(a, moc)).toBeUndefined();
    expect(wiersz(a).zmieniony_at).toBe(przed);
  });
});
