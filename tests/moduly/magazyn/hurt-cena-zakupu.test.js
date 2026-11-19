import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { historiaCenZakupu, zapiszCeneZakupu } from '../../../src/oms/db/ceny-zakupu.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { dzienPolski } from '../../../src/domena/cena-zakupu.js';
import { dzienWarszawa } from '../../../src/domena/format-daty.js';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';

// CENA ZAKUPU HURTEM — strona serwera. Cena ma własną tabelę z historią, więc hurt zapisuje ją
// obok kolumn karty, ale w TEJ SAMEJ transakcji: odmowa przy jednej karcie cofa i cenę, i stawkę.
// Sama cena zakupu nie przestawia `zmieniony_at` karty (ETag i „zmienione od” API kart — a cena do
// API nie wychodzi). Podgląd liczy „starą” cenę na dzień „od”, nie na dziś.

const origin = 'http://localhost';
const STARY_ZNACZNIK = '2020-05-05T10:00:00.000Z';
let db, app, headers;

async function zaloguj(login, rola) {
  zalozKonto(db, { login, imie: 'Ada', haslo: 'test', rola, admin: false });
  const r = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { origin },
    payload: { uzytkownik: login, haslo: 'test' },
  });
  expect(r.statusCode).toBe(302);
  return {
    origin,
    cookie: []
      .concat(r.headers['set-cookie'])
      .map((c) => c.split(';')[0])
      .join('; '),
  };
}

beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({
    db,
    config: { auth: { user: 'operator', pass: 'test' } },
    magazyn: { stan: () => ({ trwa: false }) },
  });
  headers = await zaloguj('sprzedawca', 'sprzedaz');
});

afterEach(async () => {
  await app.close();
  db.close();
});

const dzis = () => dzienWarszawa(new Date().toISOString());
const karta = (nazwa, reszta = {}) => {
  const id = utworzKarte(db, { nazwa, ...reszta });
  db.prepare('UPDATE karty_produktow SET zmieniony_at = ? WHERE id = ?').run(STARY_ZNACZNIK, id);
  return id;
};
const cena = (id, gr, od) => zapiszCeneZakupu(db, id, { gr, od }, { zrodlo: 'karta', kto: 'ktos' });
const wiersz = (id) => db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(id);
const wpisyHurtu = () =>
  db.prepare("SELECT karta_id, cena_netto_gr, obowiazuje_od, kto FROM ceny_zakupu_kart WHERE zrodlo = 'hurt'").all();
const post = (url, payload) => app.inject({ method: 'POST', url, headers, payload });
const podglad = (payload) => post('/magazyn/hurt', payload);
const zatwierdz = (payload) => post('/magazyn/hurt/zatwierdz', payload);
const zaznacz = (...id) => id.map(String);

function sekcja(body) {
  const m = /<section[^>]*id="zmiany-hurtem"[\s\S]*?<\/section>/.exec(body);
  if (!m) throw new Error('Na ekranie nie ma sekcji „zmiany-hurtem"');
  return m[0];
}
function ileNaEkranie(body) {
  const m = /<strong class="hurt-ile">([^<]*)<\/strong>/.exec(body);
  if (!m) throw new Error('Ekran hurtu nie podaje liczby kart');
  return m[1];
}
const nazwyWPodgladzie = (body) =>
  [...sekcja(body).matchAll(/<div class="nazwa-karty">([^<]*)<\/div>/g)].map((m) => m[1]);
function wierszZmiany(body, nazwa) {
  const w = sekcja(body)
    .split('<tr')
    .find((t) => t.includes(`<div class="nazwa-karty">${nazwa}</div>`));
  if (!w) throw new Error(`W podglądzie nie ma karty „${nazwa}"`);
  return [...w.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]*>/g, '').trim());
}

const trzyKarty = () => {
  const bez = karta('Lampa Kopuła');
  const dziesiec = karta('Lampa Stożek');
  cena(dziesiec, 1000, '2020-01-01');
  const juzMa = karta('Lampa Walec');
  cena(juzMa, 1310, '2020-01-01');
  return { bez, dziesiec, juzMa };
};

describe('cena zakupu hurtem — podgląd i zatwierdzenie', () => {
  it('podgląd: dwie karty „z czego na co", karta z tą samą ceną nie wchodzi, nic nie zapisane', async () => {
    const { bez, dziesiec, juzMa } = trzyKarty();
    const r = await podglad({ zaznaczone: zaznacz(bez, dziesiec, juzMa), cena_zakupu_netto: '13,10' });

    expect(r.statusCode).toBe(200);
    expect(ileNaEkranie(r.body)).toBe('2');
    expect(nazwyWPodgladzie(r.body)).toEqual(['Lampa Kopuła', 'Lampa Stożek']);
    const na = `13,10 zł od ${dzienPolski(dzis())}`;
    expect(wierszZmiany(r.body, 'Lampa Kopuła').slice(1)).toEqual(['Cena zakupu netto', '—', na]);
    expect(wierszZmiany(r.body, 'Lampa Stożek').slice(1)).toEqual(['Cena zakupu netto', '10,00 zł', na]);
    expect(wpisyHurtu()).toEqual([]);
  });

  it('zatwierdzenie: dwa wpisy z „hurt" i loginem, zmieniony_at kart bez zmian, wynik 2', async () => {
    const { bez, dziesiec, juzMa } = trzyKarty();
    const r = await zatwierdz({ zaznaczone: zaznacz(bez, dziesiec, juzMa), cena_zakupu_netto: '13,10' });

    expect(r.statusCode).toBe(200);
    expect(ileNaEkranie(r.body)).toBe('2');
    expect(r.body).toContain('Zmieniono <b>2 karty</b>');
    expect(wpisyHurtu()).toEqual([
      { karta_id: bez, cena_netto_gr: 1310, obowiazuje_od: dzis(), kto: 'sprzedawca' },
      { karta_id: dziesiec, cena_netto_gr: 1310, obowiazuje_od: dzis(), kto: 'sprzedawca' },
    ]);
    // Wpis karty z 2020 zostaje — hurt dopisuje historię, nie kasuje jej.
    expect(historiaCenZakupu(db, dziesiec).map((w) => w.cena_netto_gr)).toEqual([1000, 1310]);
    for (const id of [bez, dziesiec, juzMa]) expect(wiersz(id).zmieniony_at).toBe(STARY_ZNACZNIK);
  });

  it('cena i stawka na tej samej karcie liczą się jako JEDNA zmieniona karta', async () => {
    const { bez, dziesiec, juzMa } = trzyKarty();
    const r = await zatwierdz({
      zaznaczone: zaznacz(bez, dziesiec, juzMa),
      cena_zakupu_netto: '13,10',
      stawka_vat: '23',
    });

    expect(r.statusCode).toBe(200);
    expect(ileNaEkranie(r.body)).toBe('3');
    for (const id of [bez, dziesiec, juzMa]) expect(wiersz(id).stawka_vat).toBe('23');
    // Stawka to kolumna karty — ta zmiana przestawia znacznik, cena nie.
    expect(wiersz(juzMa).zmieniony_at).not.toBe(STARY_ZNACZNIK);
    expect(wpisyHurtu()).toHaveLength(2);
  });

  it('cena + stawka w jednej transakcji: błąd przy drugiej karcie nie zapisuje niczego', async () => {
    const { bez, dziesiec } = trzyKarty();
    const prepare = db.prepare.bind(db);
    let zapisyCen = 0;
    db.prepare = (sql) => {
      const st = prepare(sql);
      if (!String(sql).includes('INSERT INTO ceny_zakupu_kart')) return st;
      return {
        get: (...a) => {
          zapisyCen += 1;
          if (zapisyCen === 2) throw new Error('awaria w trakcie zapisu ceny');
          return st.get(...a);
        },
      };
    };
    const r = await zatwierdz({ zaznaczone: zaznacz(bez, dziesiec), cena_zakupu_netto: '13,10', stawka_vat: '23' });
    db.prepare = prepare;

    expect(zapisyCen).toBe(2);
    expect(r.statusCode).toBeGreaterThanOrEqual(500);
    expect(wpisyHurtu()).toEqual([]);
    expect([bez, dziesiec].map((id) => wiersz(id).stawka_vat)).toEqual([null, null]);
    expect([bez, dziesiec].map((id) => wiersz(id).zmieniony_at)).toEqual([STARY_ZNACZNIK, STARY_ZNACZNIK]);
  });

  it('zła kwota albo nieistniejący dzień → 400 i nic nie zapisane (także stawka obok)', async () => {
    const { bez, dziesiec } = trzyKarty();
    for (const pola of [
      { cena_zakupu_netto: '12,345' },
      { cena_zakupu_netto: 'dużo' },
      { cena_zakupu_netto: '13,10', cena_zakupu_od: '2026-02-30' },
    ]) {
      const r = await zatwierdz({ zaznaczone: zaznacz(bez, dziesiec), stawka_vat: '23', ...pola });
      expect(r.statusCode, JSON.stringify(pola)).toBe(400);
    }
    expect(wpisyHurtu()).toEqual([]);
    expect(wiersz(bez).stawka_vat).toBe(null);
  });

  it('„stara" cena liczy się na dzień „od": ta sama cena obowiązująca wtedy → karta nie wchodzi', async () => {
    const id = karta('Lampa Kula');
    cena(id, 1000, '2020-01-01');
    cena(id, 1200, '2099-01-01');
    const inna = karta('Lampa Klosz');
    cena(inna, 1000, '2020-01-01');
    const payload = { zaznaczone: zaznacz(id, inna), cena_zakupu_netto: '12,00', cena_zakupu_od: '2099-06-01' };

    const r = await podglad(payload);
    expect(nazwyWPodgladzie(r.body)).toEqual(['Lampa Klosz']);
    expect(wierszZmiany(r.body, 'Lampa Klosz').slice(1)).toEqual([
      'Cena zakupu netto',
      '10,00 zł',
      '12,00 zł od 01.06.2099',
    ]);

    const z = await zatwierdz(payload);
    expect(ileNaEkranie(z.body)).toBe('1');
    expect(wpisyHurtu()).toEqual([
      { karta_id: inna, cena_netto_gr: 1200, obowiazuje_od: '2099-06-01', kto: 'sprzedawca' },
    ]);
  });

  it('zawężenie z adresu „brak=cena_zakupu" bierze tylko karty bez ceny obowiązującej dziś', async () => {
    const { bez } = trzyKarty();
    const przyszla = karta('Lampa Klosz');
    cena(przyszla, 900, '2099-01-01');
    const r = await zatwierdz({ zakres: 'pasujace', zawezenie: 'brak=cena_zakupu', cena_zakupu_netto: '5,00' });

    expect(r.statusCode).toBe(200);
    expect(
      wpisyHurtu()
        .map((w) => w.karta_id)
        .sort((a, b) => a - b),
    ).toEqual([bez, przyszla].sort((a, b) => a - b));
  });
});
