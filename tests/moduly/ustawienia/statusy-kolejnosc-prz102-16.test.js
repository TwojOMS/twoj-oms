import { it, expect } from 'vitest';
import { nowyPanel, BASIC, post, get, jako } from '../../pomoc/konta-prz068.js';
import { statusyWKolejnosci } from '../../../src/oms/db/statusy.js';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';

const klucze = db => statusyWKolejnosci(db).map(s => s.klucz);
const zapis = db => db.prepare("SELECT wartosc FROM ustawienia WHERE klucz='statusy.konfiguracja'").get();

it('zapisuje pełną permutację, zachowuje nazwy i kolory, menu na / od razu ma nową kolejność', async () => {
  const { db, app } = nowyPanel();
  try {
    await post(app, '/ustawienia/statusy', BASIC, { akcja: 'dodaj', etykieta: 'Pakowanie lamp', kolor: 'fioletowy', jak: 'nowe' });
    const przed = statusyWKolejnosci(db);
    const kolejnosc = klucze(db).reverse();
    const r = await post(app, '/ustawienia/statusy', BASIC, { akcja: 'kolejnosc', kolejnosc });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ komunikat: 'Zapisano kolejność' });
    expect(klucze(db)).toEqual(kolejnosc);
    expect(statusyWKolejnosci(db)).toEqual([...przed].reverse().map((s, kolejnosc) => ({ ...s, kolejnosc })));
    const menu = (await get(app, '/', BASIC)).body;
    const widoczne = kolejnosc.filter(k => k !== 'indywidualne');
    const pozycje = widoczne.map(k => menu.indexOf(`href="/?status=${k}"`));
    expect(pozycje.every(i => i >= 0)).toBe(true);
    expect(pozycje).toEqual([...pozycje].sort((a, b) => a - b));
  } finally { await app.close(); db.close(); }
});

it.each(['brakujacy', 'obcy', 'duplikat', 'tekst', 'brak'])('odrzuca %s klucz lub format: 400 bez zmiany zapisu', async przypadek => {
  const { db, app } = nowyPanel();
  try {
    await post(app, '/ustawienia/statusy', BASIC, { akcja: 'edytuj', klucz: 'nowe', etykieta: 'Nowe lampy', kolor: 'czerwony' });
    const przed = zapis(db);
    let kolejnosc = klucze(db);
    if (przypadek === 'brakujacy') kolejnosc.pop();
    if (przypadek === 'obcy') kolejnosc[0] = 'w_obcy';
    if (przypadek === 'duplikat') kolejnosc[0] = kolejnosc[1];
    if (przypadek === 'tekst') kolejnosc = kolejnosc.join(',');
    if (przypadek === 'brak') kolejnosc = undefined;
    const r = await post(app, '/ustawienia/statusy', BASIC, { akcja: 'kolejnosc', kolejnosc });
    expect(r.statusCode).toBe(400);
    expect(zapis(db)).toEqual(przed);
  } finally { await app.close(); db.close(); }
});

it('lista tej samej długości z duplikatem i brakującym kluczem dostaje błąd permutacji bez zmiany bazy', async () => {
  const { db, app } = nowyPanel();
  try {
    await post(app, '/ustawienia/statusy', BASIC, { akcja: 'dodaj', etykieta: 'Kontrola lamp', kolor: 'fioletowy', jak: 'nowe' });
    const przed = zapis(db);
    const oryginal = klucze(db);
    const kolejnosc = [...oryginal];
    kolejnosc[kolejnosc.length - 1] = kolejnosc[0];
    expect(kolejnosc).toHaveLength(oryginal.length);
    expect(new Set(kolejnosc).size).toBe(oryginal.length - 1);
    expect(kolejnosc).not.toContain('w_kontrola_lamp');

    const r = await post(app, '/ustawienia/statusy', BASIC, { akcja: 'kolejnosc', kolejnosc });
    expect(r.statusCode).toBe(400);
    expect(zapis(db)).toEqual(przed);
    // Błąd pełnej permutacji ma pochodzić z trasy, zanim zapis trafi do walidatora konfiguracji.
    expect(r.json().komunikat).toBe('Prześlij pełną kolejność istniejących statusów bez powtórzeń. Odśwież ekran.');
  } finally { await app.close(); db.close(); }
});

it('zapis kolejności wymaga prawa do Ustawień i własnego pochodzenia żądania', async () => {
  const { db, app } = nowyPanel();
  try {
    await app.ready();
    zalozKonto(db, { login: 'operator_lamp', imie: 'Operator', haslo: 'test', rola: 'sprzedaz' });
    const payload = { akcja: 'kolejnosc', kolejnosc: klucze(db).reverse() };
    expect((await post(app, '/ustawienia/statusy', jako(db, 'operator_lamp'), payload)).statusCode).toBe(403);
    expect((await post(app, '/ustawienia/statusy', { ...BASIC, origin: 'https://obca.example.invalid' }, payload)).statusCode).toBe(403);
    expect(zapis(db)).toBeUndefined();
  } finally { await app.close(); db.close(); }
});

it('widok ma przyciski uchwytów, instrukcję i aria-live, wersjonowany skrypt, bez dawnych strzałek', async () => {
  const { db, app } = nowyPanel();
  try {
    const { body } = await get(app, '/ustawienia/statusy', BASIC);
    expect(body.match(/class="ust-uchwyt"/g)).toHaveLength(6);
    expect(body).toContain('aria-live="polite"');
    expect(body).toContain('strzałkami w górę i w dół');
    expect(body).toMatch(/src="\/public\/statusy-kolejnosc.js\?v=[^"]+"/);
    expect(body).not.toContain('↑ W górę');
    expect(body).not.toContain('↓ W dół');
  } finally { await app.close(); db.close(); }
});
