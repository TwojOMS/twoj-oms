// Czas odpowiedzi listy Magazynu na katalogu wielkości małej firmy (1000 kart).
//
// Plik stoi poza `tests/moduly`, bo mierzy zegar, a nie zachowanie: szybka bramka uruchamia tylko
// wskazane katalogi, pełna — całość. Próg jest luźny wobec celu (lista ma odpowiadać w ułamku
// sekundy), ale ciasny wobec dawnego kosztu: odczyt definicji kanałów z bazy przy każdym wierszu
// dawał sekundy, więc jego powrót przebija próg wielokrotnie, a nie o włos.
//
// Okablowanie jak w piaskownicy: baza z generatora demo (kanały z zaszyfrowanymi tokenami w bazie),
// moduły i nadpisania usług z `deploy/proba/atrapy`. Tylko tak definicje kanałów idą tą samą drogą
// co w działającym panelu; atrapa z gotową tablicą ukryłaby koszt.
import { afterAll, beforeAll, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ENV_DEMO, utworzBazeDemo } from '../../scripts/demo-dane.mjs';
import { modulyPiaskownicy, nadpisaniaPiaskownicy } from '../../deploy/proba/atrapy/index.mjs';
import { zbudujAplikacje } from '../../src/core/aplikacja.ts';
import { otworzBazeStartu } from '../../src/oms/db/db.ts';
import { zalozKonto } from '../../src/core/bezpieczenstwo/konta.js';
import { podpisz } from '../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../src/core/bezpieczenstwo/sekret-sesji.js';

const KART = 1000;
const PROG_MS = 500;

let katalog, db, aplikacja, ciastko;

// Kopie kart demo (z produktami w kanałach i ofertami) aż do KART — ten sam rozkład danych, co w demo.
function powiekszKatalog(sciezka, ile) {
  const baza = new DatabaseSync(sciezka);
  const kolumny = (t) =>
    baza
      .prepare(`PRAGMA table_info(${t})`)
      .all()
      .map((c) => c.name)
      .filter((c) => c !== 'id');
  const wstaw = (t, k) => baza.prepare(`INSERT INTO ${t} (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`);
  const karty = baza.prepare('SELECT * FROM karty_produktow ORDER BY id').all();
  const produkty = baza.prepare('SELECT * FROM produkty_sklepowe WHERE karta_id IS NOT NULL').all();
  const oferty = baza.prepare('SELECT * FROM oferty_kanalow WHERE karta_id IS NOT NULL').all();
  const [kk, kp, ko] = ['karty_produktow', 'produkty_sklepowe', 'oferty_kanalow'].map(kolumny);
  const [wK, wP, wO] = [wstaw('karty_produktow', kk), wstaw('produkty_sklepowe', kp), wstaw('oferty_kanalow', ko)];
  const zNumerem = (v, i) => (typeof v === 'string' && v ? `${v}-k${i}` : v);
  baza.exec('BEGIN');
  let n = karty.length;
  for (let i = 1; n < ile; i++) {
    for (const k of karty) {
      if (n >= ile) break;
      const nowa = { ...k, sku: zNumerem(k.sku, i), nazwa: `${k.nazwa} ${i}`, ean: null };
      const id = Number(wK.run(...kk.map((c) => nowa[c] ?? null)).lastInsertRowid);
      for (const p of produkty.filter((x) => x.karta_id === k.id)) {
        const np = { ...p, karta_id: id };
        for (const c of ['produkt_id', 'sku']) if (np[c]) np[c] = zNumerem(String(np[c]), i);
        wP.run(...kp.map((c) => np[c] ?? null));
      }
      for (const o of oferty.filter((x) => x.karta_id === k.id)) {
        const no = { ...o, karta_id: id };
        for (const c of ['id_zewnetrzne']) if (no[c]) no[c] = zNumerem(String(no[c]), i);
        wO.run(...ko.map((c) => no[c] ?? null));
      }
      n++;
    }
  }
  baza.exec('COMMIT');
  const razem = baza.prepare('SELECT COUNT(*) AS n FROM karty_produktow').get().n;
  baza.close();
  return razem;
}

beforeAll(async () => {
  katalog = fs.mkdtempSync(path.join(os.tmpdir(), 'lista-magazynu-'));
  const sciezka = path.join(katalog, 'oms.sqlite');
  const env = {
    ...ENV_DEMO,
    OMS_KLUCZ_SEKRETOW: randomBytes(32).toString('base64url'),
    OMS_DB_PATH: sciezka,
    OMS_USER: 'serwis-pomiar',
    OMS_PASS: randomBytes(12).toString('base64url'),
    OMS_PROFORMY_KATALOG: path.join(katalog, 'proformy'),
    OMS_ETYKIETY_KATALOG: path.join(katalog, 'etykiety'),
  };
  await utworzBazeDemo({ baza: sciezka, dzis: '2026-11-18', env });
  expect(powiekszKatalog(sciezka, KART)).toBe(KART);
  const moduly = modulyPiaskownicy(env, { baza: () => db });
  db = otworzBazeStartu(env, sciezka, { moduly, bezKataloguBazy: true });
  aplikacja = await zbudujAplikacje({
    db,
    moduly,
    env,
    nadpisania: nadpisaniaPiaskownicy({ db, env, log: () => {} }),
    log: () => {},
  });
  zalozKonto(db, { login: 'pomiar', imie: 'Pomiar', haslo: 'pomiar-haslo', rola: 'administrator', admin: true });
  ciastko = 'sesja_oms_proba=' + podpisz('pomiar', wczytajSekret(db), Date.now());
}, 120_000);

afterAll(async () => {
  await aplikacja?.app.close();
  db?.close();
  if (katalog) fs.rmSync(katalog, { recursive: true, force: true });
});

// `wszystkie=1` renderuje każdą kartę naraz — tu regres odczytu kanałów na wiersz wychodzi z dużym zapasem
// także na obciążonej maszynie, a sama pierwsza strona chroni zwykłe wejście.
it.each(['/magazyn', '/magazyn?wszystkie=1'])(
  `lista Magazynu z ${KART} kart (%s) odpowiada w mniej niż ${PROG_MS} ms`,
  async (adres) => {
    const czasy = [];
    // Pierwsze żądanie kompiluje szablon i rozgrzewa zapytania — nie wchodzi do pomiaru.
    for (let i = 0; i < 4; i++) {
      const t0 = performance.now();
      const r = await aplikacja.app.inject({ method: 'GET', url: adres, headers: { cookie: ciastko } });
      const ms = performance.now() - t0;
      expect(r.statusCode).toBe(200);
      expect(r.body).toMatch(/plakietka--kanal/);
      if (i > 0) czasy.push(ms);
    }
    const mediana = czasy.sort((a, b) => a - b)[1];
    expect(mediana).toBeLessThan(PROG_MS);
  },
  180_000,
);
