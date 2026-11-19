import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { utworzKarte, kartyZKanalami, zliczeniaBrakow } from '../../../src/oms/db/magazyn.js';
import { dodajParametr, ustawWartoscKarty, listaParametrow } from '../../../src/oms/db/parametry-kart.js';
import { filtryZZapytania, adresMagazynu, saJakiesFiltry } from '../../../src/domena/magazyn-filtry.js';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { wykonajMigracje } from '../../../src/core/baza.ts';

// Filtr „Parametr” na liście Magazynu i braki liczone z wymaganych parametrów własnych.
// Dane zmyślone: lampy „Pracowni Półcień”, parametry Kolor (lista), Moc żarówki (liczba),
// Materiał (tekst) i wymagany Gwint (lista).

const KANALY = ['pro', 'swietlik'];
const config = { auth: { user: 'adam', pass: 'x' } };
const auth = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`, origin: 'http://localhost' };
const magazyn = {
  start: () => ({ wystartowal: true }),
  stan: () => ({ trwa: false, zaczety_at: null, skonczony_at: null, postep: null, kanaly: [], blad: null }),
};

let db;
beforeEach(() => {
  db = openOmsDb(':memory:');
});

const parametr = (dane) => {
  const r = dodajParametr(db, dane);
  if (!r.ok) throw new Error(r.blad);
  return r.id;
};
// Karta kompletna w polach stałych — jedyne braki pochodzą wtedy z parametrów.
const kartaKompletna = (sku) => {
  const id = utworzKarte(db, {
    sku,
    nazwa: `Lampa Półcień ${sku}`,
    szerokosc_mm: 200,
    wysokosc_mm: 300,
    kategoria_glowna: 'Lampy',
  });
  db.prepare('UPDATE karty_produktow SET opis_sekcje_json = ? WHERE id = ?').run(
    JSON.stringify({ sekcje: [{ elementy: [{ typ: 'tekst', html: '<p>Opis</p>' }] }] }),
    id,
  );
  db.prepare(
    "INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at) VALUES (?, 0, 'reczne', 'https://example.org/l.png', '2026-11-19')",
  ).run(id);
  return id;
};
const ustaw = (karta, param, wartosc) => {
  const r = ustawWartoscKarty(db, karta, param, wartosc);
  if (!r.ok) throw new Error(r.blad);
};
const skuZ = (zapytanie) =>
  kartyZKanalami(db, {
    fraza: zapytanie.fraza ?? null,
    filtry: filtryZZapytania(zapytanie, KANALY, listaParametrow(db)),
    sort: 'sku',
  }).map((w) => w.sku);

describe('filtr parametru w zapytaniu listy', () => {
  let kolor, moc, material;
  beforeEach(() => {
    kolor = parametr({ nazwa: 'Kolor', typ: 'lista', wartosci: ['czarny', 'biały'] });
    moc = parametr({ nazwa: 'Moc żarówki', typ: 'liczba', jednostka: 'W' });
    material = parametr({ nazwa: 'Materiał', typ: 'tekst' });
    const a = kartaKompletna('A1');
    const b = kartaKompletna('B2');
    const c = kartaKompletna('C3');
    kartaKompletna('D4');
    ustaw(a, kolor, 'czarny');
    ustaw(b, kolor, 'czarny');
    ustaw(c, kolor, 'biały');
    ustaw(a, moc, '100');
    ustaw(b, moc, '60');
    ustaw(c, moc, '7,5');
    ustaw(a, material, 'mosiądz szczotkowany');
    ustaw(b, material, 'szkło');
  });

  it('lista: wartość, wielkość liter z listy, bez wartości i sam parametr', () => {
    expect(skuZ({ parametr: String(kolor), pw: 'czarny' })).toEqual(['A1', 'B2']);
    expect(skuZ({ parametr: String(kolor), pw: 'CZARNY' })).toEqual(['A1', 'B2']);
    expect(skuZ({ parametr: String(kolor), pw: 'zielony' })).toEqual([]);
    expect(skuZ({ parametr: String(kolor), pbez: '1' })).toEqual(['D4']);
    // „bez wartości” wygrywa z wartością — to dwa wykluczające się pytania.
    expect(skuZ({ parametr: String(kolor), pw: 'czarny', pbez: '1' })).toEqual(['D4']);
    expect(skuZ({ parametr: String(kolor) })).toEqual(['A1', 'B2', 'C3']);
  });

  it('liczba: od–do porównuje liczby, nie napisy, i przyjmuje przecinek', () => {
    // Napisowo „100” < „60” < „7.5” — porównanie bez CAST dałoby inny zbiór.
    expect(skuZ({ parametr: String(moc), pod: '50' })).toEqual(['A1', 'B2']);
    expect(skuZ({ parametr: String(moc), pdo: '60' })).toEqual(['B2', 'C3']);
    expect(skuZ({ parametr: String(moc), pod: '7,5', pdo: '60' })).toEqual(['B2', 'C3']);
    expect(skuZ({ parametr: String(moc), pbez: '1' })).toEqual(['D4']);
    // Nieczytelna liczba z adresu nie zawęża (jak cena), parametr dalej działa.
    expect(skuZ({ parametr: String(moc), pod: 'abc' })).toEqual(['A1', 'B2', 'C3']);
  });

  it('tekst: „zawiera”, a znak % z adresu nie jest dziką kartą', () => {
    expect(skuZ({ parametr: String(material), pw: 'mosi' })).toEqual(['A1']);
    expect(skuZ({ parametr: String(material), pw: 'MOSI' })).toEqual(['A1']);
    expect(skuZ({ parametr: String(material), pw: '%' })).toEqual([]);
    expect(skuZ({ parametr: String(material), pbez: '1' })).toEqual(['C3', 'D4']);
  });

  it('łączy się z frazą i innym filtrem', () => {
    expect(skuZ({ parametr: String(kolor), pw: 'czarny', fraza: 'B2' })).toEqual(['B2']);
    expect(skuZ({ parametr: String(kolor), pw: 'czarny', brak: 'komplet' })).toEqual(['A1', 'B2']);
  });

  it('nieznany parametr w adresie daje pustą listę, a wartości bez parametru są zrzucane', () => {
    // Filtr niezrozumiany nie może poszerzyć zbioru: parametr spoza listy definicji to nic, nie cały katalog.
    const f = filtryZZapytania({ parametr: '999', pw: 'czarny' }, KANALY, listaParametrow(db));
    expect(f.pw).toBe(null);
    expect(saJakiesFiltry(f)).toBe(true);
    expect(skuZ({ parametr: '999', pw: 'czarny' })).toEqual([]);
    expect(skuZ({ parametr: '999' })).toEqual([]);
    expect(skuZ({ pw: 'czarny', pbez: '1' })).toEqual(['A1', 'B2', 'C3', 'D4']);
    // Bez listy definicji (zawężenie hurtu) nieczytelny numer daje pusto, nigdy cały katalog.
    const surowe = filtryZZapytania({ parametr: 'abc' }, KANALY);
    expect(kartyZKanalami(db, { fraza: null, filtry: surowe })).toEqual([]);
  });

  it('po zmianie parametru bez JS wartość poprzedniego nie przechodzi na nowy', () => {
    // `pz` = parametr, dla którego formularz narysował pola wartości.
    expect(skuZ({ parametr: String(material), pw: 'czarny', pz: String(kolor) })).toEqual(['A1', 'B2']);
    expect(skuZ({ parametr: String(moc), pod: '50', pz: String(kolor) })).toEqual(['A1', 'B2', 'C3']);
    expect(skuZ({ parametr: String(kolor), pbez: '1', pz: String(material) })).toEqual(['A1', 'B2', 'C3']);
    expect(skuZ({ parametr: String(kolor), pw: 'czarny', pz: String(kolor) })).toEqual(['A1', 'B2']);
  });

  it('adres listy niesie filtr parametru (strony, sortowanie, hurt)', () => {
    const f = filtryZZapytania({ parametr: String(moc), pod: '7,5', pdo: '60' }, KANALY, listaParametrow(db));
    expect(adresMagazynu(f, { sort: 'nazwa', kier: 'asc' })).toBe(
      `/magazyn?parametr=${moc}&pod=7.5&pdo=60&sort=nazwa&kier=asc`,
    );
    // Zawężenie hurtu wraca bez listy parametrów (inna trasa) — i daje ten sam zbiór.
    const zHurtu = filtryZZapytania(Object.fromEntries(new URLSearchParams(adresMagazynu(f).split('?')[1])), KANALY);
    expect(kartyZKanalami(db, { fraza: null, filtry: zHurtu, sort: 'sku' }).map((w) => w.sku)).toEqual(['B2', 'C3']);
  });
});

describe('stare adresy paczkomatu', () => {
  it('z parametrem „Paczkomat” tłumaczone na filtr parametru', () => {
    const p = parametr({ nazwa: 'paczkomat', typ: 'lista', wartosci: ['tak', 'nie'], wymagany: true });
    const a = kartaKompletna('A1');
    const b = kartaKompletna('B2');
    kartaKompletna('C3');
    ustaw(a, p, 'tak');
    ustaw(b, p, 'nie');
    expect(skuZ({ paczkomat: 'tak' })).toEqual(['A1']);
    expect(skuZ({ paczkomat: 'nie' })).toEqual(['B2']);
    expect(skuZ({ paczkomat: 'brak' })).toEqual(['C3']);
    expect(skuZ({ paczkomat: 'nieoznaczone' })).toEqual(['C3']);
    expect(skuZ({ brak: 'paczkomat' })).toEqual(['C3']);
    const f = filtryZZapytania({ paczkomat: 'tak' }, KANALY, listaParametrow(db));
    expect(adresMagazynu(f)).toBe(`/magazyn?parametr=${p}&pw=tak`);
  });

  it('bez takiego parametru ignorowane — lista niezawężona, nie pusta', () => {
    parametr({ nazwa: 'Kolor', typ: 'lista', wartosci: ['czarny'] });
    kartaKompletna('A1');
    kartaKompletna('B2');
    expect(skuZ({ paczkomat: 'tak' })).toEqual(['A1', 'B2']);
    expect(skuZ({ brak: 'paczkomat' })).toEqual(['A1', 'B2']);
    expect(saJakiesFiltry(filtryZZapytania({ paczkomat: 'brak' }, KANALY, listaParametrow(db)))).toBe(false);
  });

  it('bez listy definicji (zawężenie hurtu) stary adres daje pusto, nigdy cały katalog', () => {
    parametr({ nazwa: 'Paczkomat', typ: 'lista', wartosci: ['tak', 'nie'] });
    kartaKompletna('A1');
    for (const q of [{ paczkomat: 'nieoznaczone' }, { paczkomat: 'tak' }, { brak: 'paczkomat' }]) {
      expect(kartyZKanalami(db, { fraza: null, filtry: filtryZZapytania(q, KANALY) })).toEqual([]);
    }
  });
});

describe('braki liczą wymagane parametry', () => {
  let gwint, kolor, a, b, c;
  beforeEach(() => {
    gwint = parametr({ nazwa: 'Gwint', typ: 'lista', wartosci: ['E27', 'E14'], wymagany: true });
    kolor = parametr({ nazwa: 'Kolor', typ: 'lista', wartosci: ['czarny'] });
    a = kartaKompletna('A1');
    b = kartaKompletna('B2');
    c = kartaKompletna('C3');
    ustaw(a, gwint, 'E27');
    ustaw(a, kolor, 'czarny');
    ustaw(b, gwint, 'E14');
  });

  it('karta bez wymaganego parametru ma brak, nieobowiązkowy się nie liczy', () => {
    const braki = Object.fromEntries(
      kartyZKanalami(db, { fraza: null, filtry: {}, sort: 'sku' }).map((w) => [w.sku, Number(w.liczba_brakow)]),
    );
    expect(braki).toEqual({ A1: 0, B2: 0, C3: 1 });
  });

  it('komplet = zero braków, ta sama liczba w kaflu i w filtrze', () => {
    expect(skuZ({ brak: 'komplet' })).toEqual(['A1', 'B2']);
    expect(zliczeniaBrakow(db).komplet).toBe(2);
    expect(zliczeniaBrakow(db)).not.toHaveProperty('bezPaczkomatu');
  });

  it('filtr „bez: <parametr>” tylko dla wymaganych', () => {
    expect(skuZ({ brak: `parametr-${gwint}` })).toEqual(['C3']);
    // Nieobowiązkowy nie jest brakiem — pozycja spoza listy nie zawęża.
    expect(filtryZZapytania({ brak: `parametr-${kolor}` }, KANALY, listaParametrow(db)).brak).toBe(null);
    // Bez listy (zawężenie hurtu) baza sama odmawia nieobowiązkowego: pusto, nigdy szerzej.
    const surowe = filtryZZapytania({ brak: `parametr-${kolor}` }, KANALY);
    expect(kartyZKanalami(db, { fraza: null, filtry: surowe })).toEqual([]);
  });
});

describe('ekran listy', () => {
  const get = (url) => buildOmsServer({ db, config, magazyn }).inject({ method: 'GET', url, headers: auth });
  const zaznaczone = (body) =>
    [...body.matchAll(/<input\b([^>]*\bname="zaznaczone"[^>]*)>/g)].filter((m) => /\bchecked\b/.test(m[1])).length;
  const wiersze = (body) => [...body.matchAll(/<input\b[^>]*\bname="zaznaczone"/g)].length;

  it('filtr parametru działa ze stronami i „zaznacz wszystkie”', async () => {
    const kolor = parametr({ nazwa: 'Kolor', typ: 'lista', wartosci: ['czarny', 'biały'] });
    db.exec('BEGIN');
    for (let i = 0; i < 160; i++) {
      const id = utworzKarte(db, { sku: `L${String(i).padStart(3, '0')}`, nazwa: `Lampa ${i}` });
      ustaw(id, kolor, i < 150 ? 'czarny' : 'biały');
    }
    db.exec('COMMIT');
    const r = await get(`/magazyn?parametr=${kolor}&pw=czarny`);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Karty 1–100 z 150');
    expect(r.body).toContain(`/magazyn?parametr=${kolor}&amp;pw=czarny&amp;sort=nazwa&amp;kier=asc&amp;strona=2`);
    const druga = await get(`/magazyn?parametr=${kolor}&pw=czarny&strona=2`);
    expect(wiersze(druga.body)).toBe(50);
    const wszystkie = await get(`/magazyn?parametr=${kolor}&pw=czarny&zaznacz=1`);
    expect(zaznaczone(wszystkie.body)).toBe(150);
    // Pole wyboru parametru i jego wartości stoją w formularzu filtrów.
    expect(r.body).toMatch(new RegExp(`<option value="${kolor}" selected>Kolor</option>`));
    expect(r.body).toMatch(/<select name="pw"[^>]*>[\s\S]*?<option value="czarny" selected>czarny<\/option>/);
    // Pasek hurtu ma własne pole „paczkomat” (wartość do ustawienia) — sprawdzamy sam formularz filtrów.
    const filtryForm = r.body.slice(r.body.indexOf('<form class="filtry"'), r.body.indexOf('<form class="szukajka"'));
    expect(filtryForm).not.toMatch(/name="paczkomat"/);
    expect(filtryForm).toMatch(/name="parametr"/);
    expect(r.body).toMatch(new RegExp(`<input type="hidden" name="pz" value="${kolor}">`));
  });

  it('liczba ma pola od–do z jednostką, tekst pole „zawiera”', async () => {
    const moc = parametr({ nazwa: 'Moc żarówki', typ: 'liczba', jednostka: 'W' });
    const material = parametr({ nazwa: 'Materiał', typ: 'tekst' });
    const l = await get(`/magazyn?parametr=${moc}&pod=40`);
    expect(l.body).toMatch(/<input[^>]*name="pod"[^>]*value="40"/);
    expect(l.body).toMatch(/<input[^>]*name="pdo"/);
    const t = await get(`/magazyn?parametr=${material}&pw=mosi`);
    expect(t.body).toMatch(/<input[^>]*name="pw"[^>]*value="mosi"/);
    expect(t.body).not.toMatch(/<input[^>]*name="pod"/);
  });

  it('stary adres bez parametru „Paczkomat” pokazuje całą listę', async () => {
    kartaKompletna('A1');
    kartaKompletna('B2');
    const r = await get('/magazyn?paczkomat=tak');
    expect(r.statusCode).toBe(200);
    expect(wiersze(r.body)).toBe(2);
  });

  it('rozkład 4/9/965 po przeniesieniu: 965 kart „bez: Paczkomat”', async () => {
    db = openOmsDb(':memory:', {
      moduly: [{ ...modulRdzen, migracje: modulRdzen.migracje.filter((m) => m.numer !== 22) }],
    });
    const wstaw = db.prepare(
      "INSERT INTO karty_produktow (sku, nazwa, paczkomat, utworzony_at, zmieniony_at) VALUES (?, ?, ?, '2026-11-19', '2026-11-19')",
    );
    db.exec('BEGIN');
    for (let i = 0; i < 978; i++) wstaw.run(`P${i}`, `Lampa ${i}`, i < 4 ? 'tak' : i < 13 ? 'nie' : null);
    db.exec('COMMIT');
    wykonajMigracje(db, [modulRdzen]);
    const [p] = listaParametrow(db);
    expect(p).toMatchObject({ typ: 'lista', wymagany: true });
    expect(skuZ({ brak: `parametr-${p.id}` })).toHaveLength(965);
    expect(skuZ({ brak: 'paczkomat' })).toHaveLength(965);
    expect(skuZ({ paczkomat: 'tak' })).toHaveLength(4);
    expect(skuZ({ paczkomat: 'nie' })).toHaveLength(9);
    const r = await get(`/magazyn?brak=parametr-${p.id}&wszystkie=1`);
    expect(r.body).toMatch(new RegExp(`<option value="parametr-${p.id}" selected>bez: ${p.nazwa}</option>`));
    expect(wiersze(r.body)).toBe(965);
  });
});
