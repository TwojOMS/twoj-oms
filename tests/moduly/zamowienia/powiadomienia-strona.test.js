// Strona /powiadomienia: zakładki Aktualne i Archiwum, filtr rodzaju, akcje z powrotem na tę samą stronę,
// stronicowanie archiwum oraz prawo konta do „Ignoruj”.
import { afterEach, it, expect } from 'vitest';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { nowyPanel, jako, get, post } from '../../pomoc/panel-konta-testowe.js';

const T0 = '2026-11-18T10:00:00.000Z';
const T1 = '2026-11-19T08:30:00.000Z';
const panele = [];
afterEach(async () => {
  for (const p of panele.splice(0)) {
    await p.app.close();
    p.db.close();
  }
});

function panel() {
  const p = nowyPanel();
  panele.push(p);
  zalozKonto(p.db, { login: 'admin-test', imie: 'Administrator', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, {
    login: 'pakowacz-test',
    imie: 'Pakowacz',
    haslo: 'h',
    rola: 'produkcja',
    ekrany: ['zamowienia'],
  });
  // Konto bez Zamówień: widzi tylko to, co dotyczy jego ekranu.
  zalozKonto(p.db, {
    login: 'magazynier-test',
    imie: 'Magazynier',
    haslo: 'h',
    rola: 'produkcja',
    ekrany: ['magazyn'],
  });
  const wstaw = p.db.prepare(
    `INSERT INTO powiadomienia (klucz, typ, tekst, href, etykieta_przycisku, etykieta_odrzucenia, pilne,
      pierwszy_raz_at, ostatnio_at, rozwiazane_at) VALUES (?, ?, ?, ?, 'Pokaż', ?, ?, ?, ?, ?)`,
  );
  const wiersz = (klucz, typ, href, { pilne = 0, odrzucenie = 'Ignoruj', rozwiazane = null, ostatnio = T0 } = {}) =>
    wstaw.run(klucz, typ, `Sprawa ${klucz}`, href, odrzucenie, pilne, T0, ostatnio, rozwiazane);
  return {
    ...p,
    wiersz,
    admin: jako(p.db, 'admin-test'),
    pakowacz: jako(p.db, 'pakowacz-test'),
    magazynier: jako(p.db, 'magazynier-test'),
  };
}

const strona = async (app, url, konto) => {
  const r = await get(app, url, konto);
  expect(r.statusCode).toBe(200);
  // Dzwonek w nagłówku też wypisuje sprawy, więc sprawdzamy tylko treść strony.
  const poczatek = r.body.indexOf('<section class="prz065-tabele powiadomienia">');
  expect(poczatek).toBeGreaterThan(-1);
  return r.body.slice(poczatek);
};

it('Aktualne to domyślna zakładka z licznikiem, rodzajem, treścią i akcjami wskazującymi tę stronę', async () => {
  const { app, wiersz, pakowacz } = panel();
  wiersz('kanal:allegro_polcien:pilne', 'kanal', '/ustawienia/integracje', { pilne: 1, odrzucenie: null });
  wiersz('przesylka:p1:lampa', 'przesylka', '/zamowienia/1');
  wiersz('przesylka:p2:lampa', 'przesylka', '/zamowienia/2', { rozwiazane: T1 });
  const html = await strona(app, '/powiadomienia?rodzaj=przesylka', pakowacz);
  expect(html).toContain('Aktualne (2)');
  expect(html).toContain('Archiwum');
  expect(html).toContain('Sprawa przesylka:p1:lampa');
  expect(html).not.toContain('Sprawa przesylka:p2:lampa');
  expect(html).not.toContain('Sprawa kanal:allegro_polcien:pilne');
  expect(html).toContain('Przesyłki bez ruchu');
  expect(html).toContain('Oznacz wszystkie jako przeczytane');
  // Każdy formularz niesie adres bieżącej strony (z filtrem) jako powrót.
  const powroty = [...html.matchAll(/name="powrot" value="([^"]*)"/g)].map((m) => m[1]);
  expect(powroty.length).toBeGreaterThanOrEqual(3);
  for (const p of powroty) expect(p.replaceAll('&amp;', '&')).toBe('/powiadomienia?rodzaj=przesylka');
  expect(html).toContain('action="/ostrzezenia/odrzuc"');
  expect(html).toContain('action="/powiadomienia/przeczytane"');
});

it('pilnego kanału nie da się zignorować na stronie, a przeczytane znika z przycisku', async () => {
  const { app, db, wiersz, pakowacz } = panel();
  wiersz('kanal:allegro_polcien:pilne', 'kanal', '/ustawienia/integracje', { pilne: 1, odrzucenie: null });
  const pakowaczId = db.prepare("SELECT id FROM konta WHERE login = 'pakowacz-test'").get().id;
  let html = await strona(app, '/powiadomienia', pakowacz);
  expect(html.match(/class="powiadomienie[^"]*powiadomienie--pilne/g)).toHaveLength(1);
  expect(html).not.toContain('action="/ostrzezenia/odrzuc"');
  expect(html).toContain('Oznacz jako przeczytane');
  await post(app, '/powiadomienia/przeczytane', pakowacz, { klucz: 'kanal:allegro_polcien:pilne' });
  html = await strona(app, '/powiadomienia', pakowacz);
  expect(pakowaczId).toBeGreaterThan(0);
  expect(html).not.toContain('Oznacz jako przeczytane');
});

it('filtr rodzaju zawęża listę, a nieznany rodzaj jest pomijany', async () => {
  const { app, wiersz, admin } = panel();
  wiersz('przesylka:p1:lampa', 'przesylka', '/zamowienia/1');
  wiersz('faktura-ksef:FV-1', 'faktura-ksef', '/faktury');
  let html = await strona(app, '/powiadomienia?rodzaj=faktura-ksef', admin);
  expect(html).toContain('Sprawa faktura-ksef:FV-1');
  expect(html).not.toContain('Sprawa przesylka:p1:lampa');
  html = await strona(app, '/powiadomienia?rodzaj=nie-ma-takiego', admin);
  expect(html).toContain('Sprawa faktura-ksef:FV-1');
  expect(html).toContain('Sprawa przesylka:p1:lampa');
});

it('konto bez magazynu nie widzi niskiego stanu ani rodzaju admina, ani w filtrze', async () => {
  const { app, wiersz, pakowacz, magazynier, admin } = panel();
  wiersz('niski-stan:l1', 'niski-stan', '/magazyn');
  wiersz('automatyzacja:wstrzymana:1:x', 'automatyzacja', '/ustawienia/automatyzacje');
  let html = await strona(app, '/powiadomienia', pakowacz);
  expect(html).not.toContain('Sprawa niski-stan:l1');
  expect(html).not.toContain('Sprawa automatyzacja');
  expect(html).not.toContain('value="niski-stan"');
  expect(html).not.toContain('value="automatyzacja"');
  html = await strona(app, '/powiadomienia', magazynier);
  expect(html).toContain('Sprawa niski-stan:l1');
  html = await strona(app, '/powiadomienia', admin);
  expect(html).toContain('Sprawa automatyzacja:wstrzymana:1:x');
  expect(html).toContain('value="automatyzacja"');
});

it('Archiwum pokazuje statusy i nie ma żadnych formularzy akcji', async () => {
  const { app, db, wiersz, admin } = panel();
  wiersz('faktura-ksef:FV-1', 'faktura-ksef', '/faktury', { rozwiazane: T1, pilne: 1 });
  wiersz('przesylka:p1:lampa', 'przesylka', '/zamowienia/1');
  wiersz('integracja:sklep:x', 'integracja', '/ustawienia/integracje');
  await post(app, '/ostrzezenia/odrzuc', admin, { klucz: 'przesylka:p1:lampa' });
  await post(app, '/ostrzezenia/odrzuc', admin, { klucz: 'integracja:sklep:x' });
  expect(db.prepare('SELECT COUNT(*) AS n FROM ostrzezenia_odrzucone').get().n).toBe(2);
  const html = await strona(app, '/powiadomienia?widok=archiwum', admin);
  expect(html).toMatch(/Rozwiązane \d{4}-\d{2}-\d{2}/);
  expect(html).toMatch(/Zignorowane przez Administrator \d{4}-\d{2}-\d{2}/);
  expect(html).toMatch(/Wyciszone do \d{4}-\d{2}-\d{2}/);
  expect(html).not.toContain('action="/powiadomienia/');
  expect(html).not.toContain('action="/ostrzezenia/odrzuc"');
  expect(html).toContain('Archiwum trzyma 30 dni.');
  // Rozwiązana pilna sprawa w Archiwum nie świeci już na czerwono.
  expect(html).not.toContain('powiadomienie--pilne');
});

it('Archiwum dzieli się na strony po 50 z odnośnikami zachowującymi filtr', async () => {
  const { app, wiersz, admin } = panel();
  for (let i = 0; i < 120; i++) {
    wiersz(`przesylka:p${String(i).padStart(3, '0')}:lampa`, 'przesylka', '/zamowienia/1', {
      rozwiazane: new Date(Date.parse(T1) + i * 60000).toISOString(),
    });
  }
  const liczba = (html) => (html.match(/Sprawa przesylka:/g) ?? []).length;
  let html = await strona(app, '/powiadomienia?widok=archiwum&rodzaj=przesylka', admin);
  expect(liczba(html)).toBe(50);
  expect(html).toContain('Strona 1 z 3');
  expect(html).toContain('Następna');
  expect(html).toContain('rodzaj=przesylka');
  html = await strona(app, '/powiadomienia?widok=archiwum&strona=3', admin);
  expect(liczba(html)).toBe(20);
  expect(html).toContain('Poprzednia');
  html = await strona(app, '/powiadomienia?widok=archiwum&strona=99', admin);
  expect(liczba(html)).toBe(20);
});

it('„Ignoruj” może konto bez Zamówień, ale tylko widoczny dla niego wiersz', async () => {
  const { app, db, wiersz, magazynier, pakowacz } = panel();
  wiersz('niski-stan:l1', 'niski-stan', '/magazyn');
  wiersz('automatyzacja:wstrzymana:1:x', 'automatyzacja', '/ustawienia/automatyzacje');
  wiersz('niski-stan:l2', 'niski-stan', '/magazyn');
  wiersz('faktura-ksef:FV-1', 'faktura-ksef', '/faktury');
  const r = await post(app, '/ostrzezenia/odrzuc', magazynier, { klucz: 'niski-stan:l1', powrot: '/powiadomienia' });
  expect([r.statusCode, r.headers.location]).toEqual([303, '/powiadomienia']);
  // Cudzy sprawa (admina) i sprawa spoza praw (niski stan bez magazynu) nie dają się schować innym.
  for (const [konto, klucz] of [
    [magazynier, 'automatyzacja:wstrzymana:1:x'],
    [pakowacz, 'niski-stan:l2'],
    [magazynier, 'nie-ma:1'],
    // Wiersz jest w migawce, ale przycisk prowadzi na ekran, którego pakowacz nie ma.
    [pakowacz, 'faktura-ksef:FV-1'],
    // Przewidywalne klucze spraw, których migawka jeszcze nie zna: nie wolno ich ukryć z góry.
    [magazynier, 'faktura-ksef:automat:2026-11-21'],
    [magazynier, 'przesylka:smiec'],
  ]) {
    const odp = await post(app, '/ostrzezenia/odrzuc', konto, { klucz, powrot: '/powiadomienia' });
    expect([klucz, [400, 403].includes(odp.statusCode)]).toEqual([klucz, true]);
  }
  const zapisane = db
    .prepare('SELECT klucz FROM ostrzezenia_odrzucone ORDER BY klucz')
    .all()
    .map((w) => w.klucz);
  expect(zapisane).toEqual(['niski-stan:l1']);
});
