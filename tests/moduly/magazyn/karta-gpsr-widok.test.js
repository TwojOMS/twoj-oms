// Widok sekcji „Bezpieczeństwo produktu (GPSR)” na karcie: HTML z prawdziwej trasy GET /magazyn/:id. Klienci
// Allegro to atrapy; dane zmyślone („Pracownia Półcień”, lampy).
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { zapiszUstawieniaOfertKonta } from '../../../src/oms/db/oferty-kanalow.ts';
import { dodajProducenta, przypiszMarki } from '../../../src/oms/db/producenci.js';
import { LIMIT_INFORMACJI_BEZPIECZENSTWA } from '../../../src/domena/allegro-oferta-z-karty.js';

const KONTO = 'allegro_polcien';
// Lista kont ekranu karty nie niesie nazwy konta, więc sekcja pokazuje klucz konta (tak jak treść oferty).
const NAZWA_KONTA = 'Półcień';
const MARKA = 'Pracownia Półcień';
const T0 = '2026-11-14T08:00:00.000Z';
const auth = {
  authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`,
  origin: 'http://localhost',
};
const ZALACZNIKI = JSON.stringify({ typ: 'ATTACHMENTS', konto: KONTO, zalaczniki: [{ id: 'zal-1' }, { id: 'zal-2' }] });

let db, app;

function ustawienia(pola = {}) {
  zapiszUstawieniaOfertKonta(
    db,
    KONTO,
    {
      narzutProcent: 0,
      stalaIlosc: 5,
      czasWysylkiDni: 2,
      cennikDostaw: 'cennik-1',
      stawkaVat: '23',
      zwrotyId: 'zwrot-1',
      reklamacjeId: 'rekl-1',
      producentId: 'prod-konta',
      bezpieczenstwoDomyslne: 'Tekst domyślny konta Półcień.',
      slowniki: {
        pobranoAt: T0,
        cenniki: [{ id: 'cennik-1', nazwa: 'Półcień — standard' }],
        zwroty: [],
        reklamacje: [],
        gwarancje: [],
        producenci: [{ id: 'prod-konta', nazwa: 'Pracownia Półcień sp. z o.o.' }],
        osoby: [],
      },
      ...pola,
    },
    { teraz: T0 },
  );
}

function karta(informacja = null, pola = {}) {
  const id = utworzKarte(
    db,
    { nazwa: 'Lampa Półcień Gliwka', sku: `GLW-${Math.random().toString(36).slice(2, 8)}`, marka: MARKA, ...pola },
    { at: T0 },
  );
  db.prepare('UPDATE karty_produktow SET informacja_bezpieczenstwa = ? WHERE id = ?').run(informacja, id);
  return id;
}

const tekst = (t) => JSON.stringify({ typ: 'TEXT', tekst: t });
const przypiszAllegro = (zrodlo) =>
  db
    .prepare(
      `INSERT OR REPLACE INTO allegro_marki_gpsr (marka, konto, zrodlo, producent_id, osoba_odpowiedzialna_id, zmieniono_at)
      VALUES (?, ?, ?, NULL, NULL, ?)`,
    )
    .run(MARKA, KONTO, zrodlo, T0);

async function ekran(url) {
  const r = await app.inject({ method: 'GET', url, headers: auth });
  expect(r.statusCode).toBe(200);
  return r.body;
}

/** Sama sekcja GPSR (partial nie zagnieżdża innych `<section>`). */
function sekcja(html) {
  const m = html.match(/<section[^>]*id="gpsr-karty"[\s\S]*?<\/section>/);
  expect(m, 'brak sekcji #gpsr-karty').not.toBeNull();
  return m[0];
}

beforeEach(async () => {
  db = openOmsDb(':memory:');
  const atrapa = { utworzOferte: vi.fn(), zmienOferte: vi.fn(), pobierzOferte: vi.fn() };
  app = buildOmsServer({
    db,
    config: { auth: { user: 'operator', pass: 'atrapa' } },
    magazyn: { stan: () => ({ trwa: false, kanaly: [] }) },
    nadpisania: {
      'kanaly.klienciKanalow': { [KONTO]: atrapa },
      'kanaly.repozytoriumKanalow': {
        listaTypu: (typ) =>
          typ === 'allegro'
            ? [{ klucz: KONTO, nazwa: NAZWA_KONTA, autoryzacja: 'polaczone', srodowisko: 'produkcja' }]
            : [],
        zapisyZablokowane: () => false,
        konfliktKlucza: () => false,
      },
    },
  });
  await app.ready();
  db.prepare('INSERT OR IGNORE INTO marki (nazwa, utworzona_at) VALUES (?, ?)').run(MARKA, T0);
  ustawienia();
});
afterEach(async () => {
  await app.close();
  db.close();
});

describe('sekcja GPSR na karcie', () => {
  it('stoi zaraz pod danymi karty, z nagłówkiem', async () => {
    const html = await ekran(`/magazyn/${karta(tekst('Nie zostawiaj lampy bez nadzoru.'))}`);
    const dane = html.indexOf('id="dane-karty"');
    const gpsr = html.indexOf('id="gpsr-karty"');
    expect(dane).toBeGreaterThan(-1);
    expect(gpsr).toBeGreaterThan(dane);
    // Pierwsza sekcja po danych karty to GPSR — nic nie wcisnęło się pomiędzy.
    const nastepna = html.slice(dane).search(/<section[^>]*id="(?!dane-karty)/);
    expect(html.slice(dane + nastepna).startsWith('<section')).toBe(true);
    expect(html.slice(dane + nastepna, dane + nastepna + 200)).toContain('id="gpsr-karty"');
    expect(sekcja(html)).toContain('Bezpieczeństwo produktu (GPSR)');
  });

  it('bez producenta: komunikat braku z odnośnikiem do słownika producentów', async () => {
    const s = sekcja(await ekran(`/magazyn/${karta()}`));
    expect(s).toContain(`Przypisz producenta marce ${MARKA}`);
    expect(s).toMatch(/<a href="\/magazyn\/producenci">/);
  });

  it('producent z marki: nazwa, źródło i odnośnik do słownika', async () => {
    const p = dodajProducenta(db, {
      nazwa: 'Pracownia Półcień',
      adres: 'ul. Cienista 2, 00-002 Miasto',
      email: 'kontakt@polcien.example.invalid',
    }).id;
    przypiszMarki(db, [{ marka: MARKA, producentId: p }]);
    const s = sekcja(await ekran(`/magazyn/${karta()}`));
    expect(s).toMatch(/Producent:\s*<strong>Pracownia Półcień<\/strong>/);
    expect(s).toContain(`z marki ${MARKA}`);
    expect(s).toContain('ul. Cienista 2');
    expect(s).toMatch(/<a href="\/magazyn\/producenci">/);
    expect(s).not.toContain('Brak producenta');
  });

  it('linia konta Allegro: nazwa producenta Allegro, a przy braku przypisania tekst błędu', async () => {
    przypiszAllegro('konto');
    const id = karta();
    let s = sekcja(await ekran(`/magazyn/${id}`));
    expect(s).toMatch(/Allegro allegro_polcien:\s*producent <strong>Pracownia Półcień sp\. z o\.o\.<\/strong>/);

    db.prepare('DELETE FROM allegro_marki_gpsr').run();
    s = sekcja(await ekran(`/magazyn/${id}`));
    const linia = s.match(/<p[^>]*data-konto="allegro_polcien"[^>]*>[\s\S]*?<\/p>/)[0];
    expect(linia).toContain('class="pasek-uwaga');
    expect(linia).toContain(MARKA);
    expect(linia).not.toContain('<strong>Pracownia Półcień sp. z o.o.</strong>');
  });

  it('licznik znaków: maxlength = limit, aria-live, liczba znaków tekstu', async () => {
    const s = sekcja(await ekran(`/magazyn/${karta(tekst('Abc de'))}`));
    const pole = s.match(/<textarea[^>]*>/)[0];
    expect(pole).toContain(`maxlength="${LIMIT_INFORMACJI_BEZPIECZENSTWA}"`);
    expect(pole).toContain('name="tekst"');
    expect(pole).toMatch(/aria-describedby="[^"]*gpsr-licznik/);
    expect(s).toMatch(/<[^>]*id="gpsr-licznik"[^>]*aria-live="polite"[^>]*>6 \/ 5000 znaków</);
    expect(s).toMatch(/<form method="post" action="\/magazyn\/\d+\/bezpieczenstwo"/);
  });

  it('pusty tekst: zwinięty tekst domyślny konta', async () => {
    const s = sekcja(await ekran(`/magazyn/${karta()}`));
    expect(s).toMatch(/<details[^>]*>\s*<summary>Używany tekst domyślny konta Allegro allegro_polcien<\/summary>/);
    expect(s).toContain('Tekst domyślny konta Półcień.');
    expect(s).not.toMatch(/<details[^>]* open/);
    expect(s).toContain('pusty = tekst domyślny konta');
  });

  it('załączniki z Allegro: liczba i „Zamień na tekst” w zwiniętym formularzu', async () => {
    const s = sekcja(await ekran(`/magazyn/${karta(ZALACZNIKI)}`));
    expect(s).toContain('Załączniki z Allegro allegro_polcien (2)');
    expect(s).toMatch(/<button[^>]*name="zastap"[^>]*value="zalaczniki"[^>]*>Zamień na tekst<\/button>/);
    // Pole tekstu dopiero po rozwinięciu — w środku <details>, nie obok.
    const zwiniete = s.match(/<details[^>]*>[\s\S]*?<\/details>/)[0];
    expect(zwiniete).toContain('<textarea');
    expect(s.replace(zwiniete, '')).not.toContain('<textarea');
    // Pusty tekst przy zamianie załączników to odmowa — podpowiedź o tekście domyślnym nie pasuje.
    expect(s).not.toContain('pusty = tekst domyślny konta');
  });

  it('po zapisie: komunikat', async () => {
    const id = karta(tekst('Nie zostawiaj lampy bez nadzoru.'));
    expect(sekcja(await ekran(`/magazyn/${id}`))).not.toContain('Zapisano informację o bezpieczeństwie');
    const s = sekcja(await ekran(`/magazyn/${id}?zapisano=bezpieczenstwo`));
    expect(s).toMatch(/role="status"[^>]*>Zapisano informację o bezpieczeństwie/);
  });

  it('odmowa 400: błąd przy polu i wpisany tekst wraca do pola', async () => {
    const id = karta(tekst('Stary tekst.'));
    const za = `${'x'.repeat(LIMIT_INFORMACJI_BEZPIECZENSTWA)}NOWY`;
    const r = await app.inject({
      method: 'POST',
      url: `/magazyn/${id}/bezpieczenstwo`,
      payload: { tekst: za },
      headers: auth,
    });
    expect(r.statusCode).toBe(400);
    const s = sekcja(r.body);
    const pole = s.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/);
    expect(pole[0]).toMatch(/aria-describedby="[^"]*gpsr-blad/);
    expect(pole[0]).toContain('aria-invalid="true"');
    expect(pole[1]).toBe(za);
    expect(s).toMatch(/id="gpsr-blad"[^>]*>Informacja o bezpieczeństwie ma 5004 znaków/);
    expect(s).not.toContain('Stary tekst.');
  });

  it('odmowa 400 przy załącznikach: formularz rozwinięty, z wpisanym tekstem', async () => {
    const id = karta(ZALACZNIKI);
    const za = 'y'.repeat(LIMIT_INFORMACJI_BEZPIECZENSTWA + 1);
    const r = await app.inject({
      method: 'POST',
      url: `/magazyn/${id}/bezpieczenstwo`,
      payload: { tekst: za, zastap: 'zalaczniki' },
      headers: auth,
    });
    expect(r.statusCode).toBe(400);
    const s = sekcja(r.body);
    expect(s).toMatch(/<details[^>]* open/);
    expect(s).toContain(za);
  });

  it('tekst użytkownika jest escapowany', async () => {
    const s = sekcja(await ekran(`/magazyn/${karta(tekst('<script>alert(1)</script> & „cudzysłów”'))}`));
    expect(s).not.toContain('<script>alert(1)</script>');
    expect(s).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp;');
  });
});
