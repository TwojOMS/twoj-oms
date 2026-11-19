// Ustawienia → Magazyn → Parametry kart na prawdziwym serwerze: lista, dodanie, zmiana, kolejność, usunięcie
// z potwierdzeniem i odmowy, które chronią wartości zapisane na kartach. Dane zmyślone: lampy „Pracowni Półcień”.
import { describe, it, expect } from 'vitest';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { dodajParametr, listaParametrow, parametrPoId, ustawWartoscKarty } from '../../../src/oms/db/parametry-kart.js';
import { nowyPanel, jako, get, post } from '../../pomoc/panel-konta-testowe.js';

const ADRES = '/magazyn/ustawienia/parametry';

function panel() {
  const p = nowyPanel();
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'ewa').id, ['zamowienia', 'magazyn']);
  return { ...p, admin: jako(p.db, 'adam'), ewa: jako(p.db, 'ewa') };
}

function parametr(db, dane) {
  const w = dodajParametr(db, dane);
  if (!w.ok) throw new Error(w.blad);
  return w.id;
}

/** Karta z wartością parametru — tak jak zapisze ją karta produktu. */
function kartaZ(db, n, parametrId, wartosc) {
  const karta = utworzKarte(db, { nazwa: `Lampa Półcień LMP-${n}`, sku: `LMP-${n}` });
  const id = Number(karta?.id ?? karta);
  const w = ustawWartoscKarty(db, id, parametrId, wartosc);
  if (!w.ok) throw new Error(w.blad);
  return id;
}

const tabela = (html) => /<table[^>]*id="parametry-kart"[\s\S]*?<\/table>/u.exec(html)?.[0] ?? '';
const wiersz = (html, nazwa) =>
  [...tabela(html).matchAll(/<tr[\s\S]*?<\/tr>/gu)].map((m) => m[0]).find((t) => t.includes(`>${nazwa}<`)) ?? '';
const tresc = (html) => /<main[\s\S]*<\/main>/u.exec(html)?.[0] ?? html;

describe('Ustawienia → Parametry kart', () => {
  it('pusta firma widzi zachętę i przycisk dodania; Magazyn i menu Ustawień prowadzą do podstrony', async () => {
    const { app, admin } = panel();
    const r = await get(app, ADRES, admin);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toContain('Firma nie ma jeszcze własnych parametrów. Dodaj pierwszy — np. kolor, materiał, moc.');
    expect(r.body).not.toContain('id="parametry-kart"');
    expect(r.body).toContain(`href="${ADRES}/nowy"`);
    expect(r.body).toContain(`<a href="/magazyn/ustawienia" aria-current="true">Ustawienia</a>`);

    const magazyn = await get(app, '/magazyn/ustawienia', admin);
    expect(tresc(magazyn.body)).toContain(`<a href="${ADRES}">Parametry kart</a>`);
  });

  it('dodanie liczby zapisuje jednostkę, a wartości listy z formularza bez JS ignoruje', async () => {
    const { db, app, admin } = panel();
    const formularz = await get(app, `${ADRES}/nowy`, admin);
    expect(formularz.statusCode).toBe(200);
    expect(formularz.body).toContain('name="typ" value="liczba"');
    expect(formularz.body).toContain('Wymagany — brak wartości liczy się do braków karty');

    const r = await post(app, ADRES, admin, {
      nazwa: 'Moc żarówki',
      typ: 'liczba',
      jednostka: 'W',
      wartosci: 'czarny\nbiały',
      wymagany: '1',
    });
    expect(r.statusCode, r.body).toBe(303);
    expect(r.headers.location).toMatch(/^\/magazyn\/ustawienia\/parametry\?/u);
    const [p] = listaParametrow(db);
    expect(p).toMatchObject({ nazwa: 'Moc żarówki', typ: 'liczba', jednostka: 'W', wartosci: null, wymagany: true });

    const lista = await get(app, r.headers.location, admin);
    const w = wiersz(lista.body, 'Moc żarówki');
    expect(w).toContain('liczba (W)');
    expect(w).toMatch(/<td>tak<\/td>/u);
    expect(w).toContain(`href="/magazyn?parametr=${p.id}"`);
    expect(w).toContain(`href="${ADRES}/${p.id}"`);
    expect(w).toContain(`href="${ADRES}/${p.id}/usun"`);
  });

  it('lista pokazuje skrót wartości do 60 znaków, a niepoprawna nazwa wraca formularzem z wpisanymi danymi', async () => {
    const { db, app, admin } = panel();
    parametr(db, {
      nazwa: 'Kolor',
      typ: 'lista',
      wartosci: 'czarny\nbiały\nmosiądz\nzłoty\nsrebrny\nmiedziany\ngrafitowy\nbeżowy',
    });
    const lista = await get(app, ADRES, admin);
    const w = wiersz(lista.body, 'Kolor');
    const skrot = /<td>(lista: [^<]*)<\/td>/u.exec(w)?.[1] ?? '';
    expect(skrot.startsWith('lista: czarny, biały, mosiądz')).toBe(true);
    expect(skrot.endsWith('…')).toBe(true);
    expect([...skrot].length).toBeLessThanOrEqual(60);
    expect(w).toMatch(/<td>—<\/td>/u);

    const r = await post(app, ADRES, admin, { nazwa: 'waga', typ: 'tekst' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('value="waga"');
    expect(r.body).toMatch(/role="alert"/u);
    expect(listaParametrow(db)).toHaveLength(1);
  });

  it('zmiana nazwy, jednostki i „wymagany” zapisuje się; nieznany parametr to 404', async () => {
    const { db, app, admin } = panel();
    const id = parametr(db, { nazwa: 'Moc', typ: 'liczba', jednostka: 'W', wymagany: '1' });
    const f = await get(app, `${ADRES}/${id}`, admin);
    expect(f.statusCode).toBe(200);
    expect(f.body).toContain('value="Moc"');
    const r = await post(app, `${ADRES}/${id}`, admin, { nazwa: 'Moc żarówki', typ: 'liczba', jednostka: 'kW' });
    expect(r.statusCode, r.body).toBe(303);
    expect(parametrPoId(db, id)).toMatchObject({ nazwa: 'Moc żarówki', jednostka: 'kW', wymagany: false });

    expect((await get(app, `${ADRES}/999`, admin)).statusCode).toBe(404);
    expect((await post(app, `${ADRES}/999`, admin, { nazwa: 'X', typ: 'tekst' })).statusCode).toBe(404);
  });

  it('typu nie da się zmienić, gdy karty mają wartości (409, nic się nie zmienia)', async () => {
    const { db, app, admin } = panel();
    const id = parametr(db, { nazwa: 'Moc', typ: 'liczba', jednostka: 'W' });
    kartaZ(db, 1, id, '40');
    const r = await post(app, `${ADRES}/${id}`, admin, { nazwa: 'Moc', typ: 'tekst' });
    expect(r.statusCode).toBe(409);
    expect(r.body).toContain('Parametr ma wartości na 1 karcie — typu nie da się zmienić');
    expect(parametrPoId(db, id)).toMatchObject({ typ: 'liczba', jednostka: 'W' });
  });

  it('usunięcie z listy wartości używanej na kartach odmawia z liczbą kart (409)', async () => {
    const { db, app, admin } = panel();
    const id = parametr(db, { nazwa: 'Kolor', typ: 'lista', wartosci: 'czarny\nmosiadz' });
    kartaZ(db, 1, id, 'mosiadz');
    kartaZ(db, 2, id, 'mosiadz');
    const r = await post(app, `${ADRES}/${id}`, admin, { nazwa: 'Kolor', typ: 'lista', wartosci: 'czarny' });
    expect(r.statusCode).toBe(409);
    expect(r.body).toContain('Wartość „mosiadz” jest na 2 kartach — zmień je najpierw');
    expect(parametrPoId(db, id).wartosci).toEqual(['czarny', 'mosiadz']);
  });

  it('zmiana nazwy wartości listy przepisuje karty', async () => {
    const { db, app, admin } = panel();
    const id = parametr(db, { nazwa: 'Kolor', typ: 'lista', wartosci: 'czarny\nmosiadz' });
    const k1 = kartaZ(db, 1, id, 'mosiadz');
    const k2 = kartaZ(db, 2, id, 'czarny');
    const f = await get(app, `${ADRES}/${id}`, admin);
    expect(f.body).toMatch(/<select[^>]*name="wartosc_z"[\s\S]*<option value="mosiadz">mosiadz<\/option>/u);
    expect(f.body).toContain('name="wartosc_na"');

    const r = await post(app, `${ADRES}/${id}`, admin, {
      nazwa: 'Kolor',
      typ: 'lista',
      wartosci: 'czarny\nmosiadz',
      wartosc_z: 'mosiadz',
      wartosc_na: 'mosiądz',
    });
    expect(r.statusCode, r.body).toBe(303);
    expect(parametrPoId(db, id).wartosci).toEqual(['czarny', 'mosiądz']);
    const wartosc = (k) =>
      db.prepare('SELECT wartosc FROM karty_parametry WHERE karta_id = ? AND parametr_id = ?').get(k, id)?.wartosc;
    expect(wartosc(k1)).toBe('mosiądz');
    expect(wartosc(k2)).toBe('czarny');
    expect((await get(app, r.headers.location, admin)).body).toContain('na 1 karcie');
  });

  it('strzałki zmieniają kolejność', async () => {
    const { db, app, admin } = panel();
    const a = parametr(db, { nazwa: 'Kolor', typ: 'tekst' });
    const b = parametr(db, { nazwa: 'Moc', typ: 'liczba' });
    const r = await post(app, `${ADRES}/${b}/przesun`, admin, { kierunek: 'gora' });
    expect(r.statusCode, r.body).toBe(303);
    expect(listaParametrow(db).map((p) => p.id)).toEqual([b, a]);
    expect((await post(app, `${ADRES}/${b}/przesun`, admin, { kierunek: 'bok' })).statusCode).toBe(400);
  });

  it('usunięcie idzie przez ekran potwierdzenia i zabiera wartości kart', async () => {
    const { db, app, admin } = panel();
    const id = parametr(db, { nazwa: 'Kolor', typ: 'tekst' });
    kartaZ(db, 1, id, 'czarny');
    kartaZ(db, 2, id, 'biały');
    const pusty = parametr(db, { nazwa: 'Materiał', typ: 'tekst' });

    const ekran = await get(app, `${ADRES}/${id}/usun`, admin);
    expect(ekran.statusCode).toBe(200);
    expect(ekran.body).toContain('Usunąć „Kolor”? Wartości znikną z 2 kart.');
    expect(ekran.body).toMatch(new RegExp(`<form[^>]*method="post"[^>]*action="${ADRES}/${id}/usun"`, 'u'));
    expect(tresc(ekran.body)).not.toContain('confirm(');
    expect(listaParametrow(db)).toHaveLength(2); // samo wejście na ekran niczego nie kasuje

    const bezWartosci = await get(app, `${ADRES}/${pusty}/usun`, admin);
    expect(bezWartosci.body).toContain('Usunąć „Materiał”?');
    expect(bezWartosci.body).not.toContain('Wartości znikną');

    const r = await post(app, `${ADRES}/${id}/usun`, admin, {});
    expect(r.statusCode, r.body).toBe(303);
    expect(parametrPoId(db, id)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM karty_parametry').get().n).toBe(0);
    expect((await post(app, `${ADRES}/${id}/usun`, admin, {})).statusCode).toBe(404);
  });

  it('konto bez prawa do Ustawień dostaje 403 i niczego nie zmienia', async () => {
    const { db, app, ewa } = panel();
    const id = parametr(db, { nazwa: 'Kolor', typ: 'tekst' });
    expect((await get(app, ADRES, ewa)).statusCode).toBe(403);
    expect((await get(app, `${ADRES}/${id}`, ewa)).statusCode).toBe(403);
    expect((await post(app, ADRES, ewa, { nazwa: 'Moc', typ: 'liczba' })).statusCode).toBe(403);
    expect((await post(app, `${ADRES}/${id}`, ewa, { nazwa: 'Kolor2', typ: 'tekst' })).statusCode).toBe(403);
    expect((await post(app, `${ADRES}/${id}/usun`, ewa, {})).statusCode).toBe(403);
    expect(listaParametrow(db).map((p) => p.nazwa)).toEqual(['Kolor']);
  });
});
