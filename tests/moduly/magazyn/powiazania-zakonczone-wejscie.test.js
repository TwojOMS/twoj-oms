import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import {
  zapiszProduktSklepowy,
  utworzKarte,
  powiazProdukt,
  niepowiazaneOfertyAllegro,
} from '../../../src/oms/db/magazyn.js';

// Trzy rzeczy wokol ekranu powiazan i listy magazynu:
//   (1) oferty zakonczone nie wygladaja jak robota do zrobienia, ale dalej da sie je powiazac;
//   (2) z listy magazynu jest wejscie do powiazan, z liczba tego, co faktycznie czeka;
//   (3) komorka zaznaczania reaguje na klik w cala komorke (etykieta obejmuje pole).

const config = { auth: { user: 'adam', pass: 'x' } };
const auth = {
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
  origin: 'http://localhost',
};
const STAN_PUSTY = { trwa: false, zaczety_at: null, skonczony_at: null, postep: null, kanaly: [], blad: null };
const atrapaMagazynu = () => ({ start: vi.fn(), stan: () => STAN_PUSTY });

let db;
let numer;
const serwer = () => buildOmsServer({ db, config, magazyn: atrapaMagazynu() });
const get = (app, url) => app.inject({ method: 'GET', url, headers: auth });
const post = (app, url, payload) => app.inject({ method: 'POST', url, headers: auth, payload });

beforeEach(() => {
  db = openOmsDb(':memory:');
  numer = 0;
});

function oferta(nazwa, status, nadpisania = {}) {
  numer += 1;
  return zapiszProduktSklepowy(db, {
    kanal: 'allegro_swietlik',
    produkt_id: `oferta-${numer}`,
    wariant_id: '',
    nazwa,
    status_publikacji: status,
    odczytane_at: '2026-11-18T06:00:00.000Z',
    ...nadpisania,
  });
}

const nazwyOfert = (body) => [...body.matchAll(/<div class="nazwa-oferty">([^<]*)<\/div>/g)].map((m) => m[1]);
const wierszOferty = (body, nazwa) => {
  const w = body.split('<tr').find((x) => x.includes(`<div class="nazwa-oferty">${nazwa}</div>`));
  if (!w) throw new Error(`Brak wiersza oferty ${nazwa}`);
  return w;
};

describe('Powiazania: oferty zakonczone', () => {
  beforeEach(() => {
    utworzKarte(db, { nazwa: 'Lampion srebrny' });
    oferta('Lampion aktywny', 'ACTIVE');
    oferta('Lampion nieaktywny', 'INACTIVE');
    oferta('Lampion zakonczony', 'ENDED');
  });

  it('domyslnie pokazuje aktywne i nieaktywne, zakonczone tylko policzone', async () => {
    const r = await get(serwer(), '/magazyn/powiazania');
    expect(r.statusCode).toBe(200);
    expect(nazwyOfert(r.body).sort()).toEqual(['Lampion aktywny', 'Lampion nieaktywny']);
    expect(r.body).toContain('1 zakończona');
    expect(r.body).toContain('pokaż zakończone (1)');
  });

  it('z przelacznikiem pokazuje tez zakonczone, ze znacznikiem', async () => {
    const r = await get(serwer(), '/magazyn/powiazania?zakonczone=1');
    expect(nazwyOfert(r.body)).toHaveLength(3);
    expect(wierszOferty(r.body, 'Lampion zakonczony')).toContain('<span class="znacznik">zakończona</span>');
    expect(wierszOferty(r.body, 'Lampion nieaktywny')).toContain('<span class="znacznik">nieaktywna</span>');
    expect(wierszOferty(r.body, 'Lampion aktywny')).not.toContain('class="znacznik"');
    expect(r.body).toContain('ukryj zakończone');
  });

  it('formularze ekranu niosa przelacznik dalej i skacza do listy, nie na gore', async () => {
    const r = await get(serwer(), '/magazyn/powiazania?zakonczone=1');
    expect(r.body).toContain('<input type="hidden" name="zakonczone" value="1">');
    expect(r.body).toMatch(/<form class="szukajka"[^>]*action="\/magazyn\/powiazania#lista-ofert"/);
    expect(r.body).toMatch(/<form class="filtry"[^>]*action="\/magazyn\/powiazania#lista-ofert"/);
    expect(r.body).toContain('id="lista-ofert"');
  });

  it('zatwierdzenie z oferta zakonczona dalej ja wiaze', async () => {
    const id = db.prepare("SELECT id FROM produkty_sklepowe WHERE nazwa = 'Lampion zakonczony'").get().id;
    const karta = db.prepare('SELECT id FROM karty_produktow').get().id;
    await post(serwer(), '/magazyn/powiazania', { [`karta_${id}`]: String(karta) });
    expect(db.prepare('SELECT karta_id FROM produkty_sklepowe WHERE id = ?').get(id).karta_id).toBe(karta);
  });

  it('zapytanie bazy dla innych wolajacych dalej widzi wszystkie oferty', () => {
    expect(niepowiazaneOfertyAllegro(db, ['allegro_swietlik'])).toHaveLength(3);
  });
});

describe('Lista magazynu: wejscie do powiazan', () => {
  it('ma odnosnik z liczba niepowiazanych bez zakonczonych', async () => {
    const karta = utworzKarte(db, { nazwa: 'Lampion srebrny' });
    oferta('A', 'ACTIVE');
    oferta('B', 'INACTIVE');
    oferta('C', 'ENDED');
    powiazProdukt(db, oferta('D', 'ACTIVE'), karta);
    const r = await get(serwer(), '/magazyn');
    expect(r.body).toContain('href="/magazyn/powiazania">Powiązania ofert (2 niepowiązane)</a>');
  });

  it('przy zerze zostaje bez liczby', async () => {
    utworzKarte(db, { nazwa: 'Lampion srebrny' });
    oferta('C', 'ENDED');
    const r = await get(serwer(), '/magazyn');
    expect(r.body).toContain('href="/magazyn/powiazania">Powiązania ofert</a>');
  });
});

describe('Komorka zaznaczania', () => {
  it('kazde pole listy siedzi w etykiecie komorki i ma opis', async () => {
    utworzKarte(db, { nazwa: 'Lampion srebrny' });
    utworzKarte(db, { nazwa: 'Kandelabr złoty' });
    const r = await get(serwer(), '/magazyn?zaznacz=1');
    const pola = [...r.body.matchAll(/<input\b[^>]*name="zaznaczone"[^>]*>/g)].map((m) => m[0]);
    expect(pola).toHaveLength(2);
    for (const p of pola) {
      expect(p).toContain('checked');
      expect(p).toMatch(/aria-label="Zaznacz kartę [^"]+"/);
    }
    const obudowane = [
      ...r.body.matchAll(/<td class="kol-zazn">\s*<label class="kol-zazn-etykieta">\s*<input\b[^>]*name="zaznaczone"/g),
    ];
    expect(obudowane).toHaveLength(2);
    expect(r.body).toContain('<th class="kol-zazn">');
    expect(r.body).not.toContain('kol-zaznacz"');
  });

  it.each(['magazyn-przejecie-erli.ejs', 'magazyn-stany-kanaly.ejs'])('%s ma ten sam wzorzec', (plik) => {
    const zrodlo = readFileSync(new URL(`../../../src/moduly/magazyn/widoki/${plik}`, import.meta.url), 'utf8');
    // Szablon ma znaczniki `<%= %>` z `>` w srodku, wiec pole czytamy do konca linii, nie do pierwszego `>`.
    expect(zrodlo.match(/name="zaznaczone"/g)).toHaveLength(1);
    expect(zrodlo).toMatch(
      /<td class="kol-zazn">[^\n]*?<label class="kol-zazn-etykieta"><input[^\n]*name="zaznaczone"[^\n]*aria-label="[^"]+"[^\n]*<\/label>/,
    );
  });
});
