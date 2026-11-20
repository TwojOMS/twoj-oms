import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import ejs from 'ejs';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { przelaczStany } from '../../../src/oms/db/stany-magazynowe.js';

// PANEL „EDYTUJ" NA LIŚCIE MAGAZYNU — lista zmian zamiast ściany pól.
// Serwer renderuje grupy pozycji i szablony wierszy; skrypt tylko klonuje szablony.
// Pola wiersza istnieją w formularzu dopiero po wybraniu pozycji (zawartość <template>
// nie jedzie z formularzem), więc to, czego użytkownik nie wybrał, nie może się wysłać.

const config = { auth: { user: 'adam', pass: 'x' } };
const auth = {
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
  origin: 'http://localhost',
};
const STAN_PUSTY = { trwa: false, zaczety_at: null, skonczony_at: null, postep: null, kanaly: [], blad: null };

let db;
beforeEach(() => {
  db = openOmsDb(':memory:');
  utworzKarte(db, { nazwa: 'Lampa Półcień' });
});

// Parametry kart i uprawnienie do ich ustawień dokłada do widoku trasa listy; tu podajemy je
// wprost przez kompilator szablonów, żeby sprawdzać sam widok niezależnie od trasy.
let dodatkiWidoku = {};
const kompiluj = ejs.compile;
beforeAll(() => {
  vi.spyOn(ejs, 'compile').mockImplementation((html, opcje) => {
    const szablonEjs = kompiluj.call(ejs, html, opcje);
    return (dane, ...reszta) => szablonEjs({ ...dane, ...dodatkiWidoku }, ...reszta);
  });
});
afterAll(() => vi.restoreAllMocks());

function serwer(dodatki = {}) {
  dodatkiWidoku = dodatki;
  return buildOmsServer({ db, config, magazyn: { start: vi.fn(), stan: () => STAN_PUSTY } });
}

async function panel(dodatki) {
  const r = await serwer(dodatki).inject({ method: 'GET', url: '/magazyn', headers: auth });
  expect(r.statusCode).toBe(200);
  const m = /<section[^>]*id="hurt-pasek"[\s\S]*?<\/section>/.exec(r.body);
  if (!m) throw new Error('Na ekranie nie ma panelu „hurt-pasek"');
  return m[0];
}

const pozycje = (html) =>
  [...html.matchAll(/<button type="button" class="btn hz-opcja" data-z="([^"]+)"[^>]*>([^<]*)</g)].map((m) => [
    m[1],
    m[2].trim(),
  ]);
const grupy = (html) => [...html.matchAll(/<div class="hz-grupa">\s*<p>([^<]*)<\/p>/g)].map((m) => m[1]);
const szablon = (html, klucz) => {
  const m = new RegExp(`<li data-zmiana="${klucz}"[\\s\\S]*?</li>`).exec(html);
  if (!m) throw new Error(`Brak szablonu wiersza „${klucz}"`);
  return m[0];
};

const PARAMETRY = [
  { id: 7, nazwa: 'Kolor <b>&"', typ: 'lista', jednostka: null, wartosci: ['biały', 'czarny <i>'], wymagany: false },
  { id: 9, nazwa: 'Moc', typ: 'liczba', jednostka: 'W', wartosci: [], wymagany: false },
  { id: 11, nazwa: 'Materiał', typ: 'tekst', jednostka: null, wartosci: [], wymagany: false },
];

describe('panel Edytuj — lista zmian', () => {
  it('grupy i pozycje w kolejności makiety, bez EAN, skracania nazwy i paczkomatu', async () => {
    przelaczStany(db, { wlacz: true, konto: { id: 1, login: 'tester' }, at: '2025-01-01T00:00:00Z' });
    const html = await panel();
    expect(grupy(html)).toEqual(['Ceny', 'Dane karty', 'Parametry', 'Inne']);
    expect(pozycje(html)).toEqual([
      ['cena', 'Cena katalogowa'],
      ['stawka', 'Stawka VAT'],
      ['zakup', 'Cena zakupu netto'],
      ['marka', 'Marka'],
      ['kategoria', 'Kategoria główna'],
      ['szerokosc', 'Szerokość (cm)'],
      ['wysokosc', 'Wysokość (cm)'],
      ['glebokosc', 'Głębokość (cm)'],
      ['waga', 'Waga (kg)'],
      ['bezpieczenstwo', 'Informacja o bezpieczeństwie'],
      ['prog', 'Próg niskiego stanu'],
    ]);
    expect(html).not.toMatch(/EAN|name="ean"/);
    expect(html).not.toMatch(/nazwa_bez_rozmiaru|Skróć nazwę/);
    expect(html).not.toMatch(/name="paczkomat"/);
  });

  it('każda pozycja ma swój szablon wiersza z ✕ opisanym nazwą zmiany', async () => {
    przelaczStany(db, { wlacz: true, konto: { id: 1, login: 'tester' }, at: '2025-01-01T00:00:00Z' });
    const html = await panel({ parametryKart: PARAMETRY });
    expect(html).toMatch(/<template id="hz-szablony">/);
    for (const [klucz, nazwa] of pozycje(html)) {
      const li = szablon(html, klucz);
      expect(li, klucz).toMatch(
        /<button type="button" class="btn hz-usun" aria-label="Usuń zmianę: [^"]+">✕<\/button>/,
      );
      if (!klucz.startsWith('parametr-')) expect(li, klucz).toContain(`aria-label="Usuń zmianę: ${nazwa}"`);
    }
    expect(szablon(html, 'parametr-7')).toContain('aria-label="Usuń zmianę: Kolor &lt;b&gt;&amp;&#34;"');
  });

  it('wymiary i waga z nowymi polami i „wyczyść wartość"', async () => {
    const html = await panel();
    for (const [klucz, pole] of [
      ['szerokosc', 'szerokosc_cm'],
      ['wysokosc', 'wysokosc_cm'],
      ['glebokosc', 'glebokosc_cm'],
      ['waga', 'waga_kg'],
    ]) {
      const li = szablon(html, klucz);
      expect(li).toMatch(new RegExp(`<input type="text" inputmode="decimal" name="${pole}"`));
      expect(li).toMatch(new RegExp(`<input type="checkbox" name="${pole}_wyczysc" value="tak"`));
      expect(li).toContain('wyczyść wartość');
    }
  });

  it('wiersz ceny: tryb bez pustej opcji, podpowiedź znaku, zaokrąglenie', async () => {
    const li = szablon(await panel(), 'cena');
    expect(li).toMatch(
      /<select name="cena_tryb">\s*<option value="o_procent">zmień o %<\/option>\s*<option value="o_kwote">zmień o kwotę \(zł\)<\/option>\s*<option value="na_kwote">ustaw kwotę \(zł\)<\/option>/,
    );
    expect(li).toContain('Bez znaku = w górę, „-” = w dół.');
    expect(li).toMatch(/class="[^"]*hurt-zaokraglenie/);
  });

  it('stopka ma JEDEN przycisk — dla zaznaczonych; bez „wszystkich pasujących" i bez zdania o podglądzie', async () => {
    const html = await panel();
    const przyciski = [...html.matchAll(/<button[^>]*type="submit"[^>]*>/g)].map((m) => m[0]);
    expect(przyciski).toEqual([
      expect.stringMatching(/class="btn btn--glowny" type="submit" name="zakres" value="zaznaczone"/),
    ]);
    expect(html).toMatch(/Pokaż, co się zmieni — <span data-hz-ile>/);
    expect(html).not.toMatch(/value="pasujace"|wszystkich pasujących|hurt-pasujace/);
    expect(html).not.toMatch(/Nic nie zapisuje/);
    expect(html).toMatch(/<input type="hidden" name="zawezenie"/);
  });

  it('bez JavaScriptu panel mówi, że go potrzebuje, a skrypt panelu jest podpięty', async () => {
    const html = await panel();
    expect(html).toMatch(/<noscript>[\s\S]*Edycja hurtowa wymaga włączonego JavaScriptu[\s\S]*<\/noscript>/);
    expect(html).toMatch(/<script type="module" src="\/[^"]*edycja-hurtowa[^"]*\.js[^"]*"><\/script>/);
  });

  it('próg niskiego stanu tylko przy włączonych stanach', async () => {
    const bez = await panel();
    expect(pozycje(bez).map(([k]) => k)).not.toContain('prog');
    expect(bez).not.toMatch(/name="prog_niskiego_stanu"/);
    przelaczStany(db, { wlacz: true, konto: { id: 1, login: 'tester' }, at: '2025-01-01T00:00:00Z' });
    const z = await panel();
    expect(pozycje(z).map(([k]) => k)).toContain('prog');
    expect(szablon(z, 'prog')).toMatch(/<input type="checkbox" name="prog_niskiego_stanu_bez" value="tak"/);
  });
});

describe('panel Edytuj — parametry własne', () => {
  it('pusta lista parametrów = brak grupy i brak linku', async () => {
    const html = await panel({ parametryKart: [], mozeUstawieniaMagazynu: true });
    expect(grupy(html)).not.toContain('Parametry własne');
    expect(html).not.toMatch(/parametr_\d/);
    expect(html).not.toContain('/magazyn/ustawienia/parametry');
  });

  it('parametry jako pozycje i szablony według typu, nazwy z bazy escapowane', async () => {
    const html = await panel({ parametryKart: PARAMETRY });
    expect(grupy(html)).toEqual(['Ceny', 'Dane karty', 'Parametry', 'Parametry własne', 'Inne']);
    expect(pozycje(html).filter(([k]) => k.startsWith('parametr-'))).toEqual([
      ['parametr-7', 'Kolor &lt;b&gt;&amp;&#34;'],
      ['parametr-9', 'Moc (W)'],
      ['parametr-11', 'Materiał'],
    ]);
    expect(html).not.toContain('Kolor <b>');
    const lista = szablon(html, 'parametr-7');
    expect(lista).toMatch(
      /<select name="parametr_7">\s*<option value="">— nie zmieniaj —<\/option>\s*<option value="biały">biały<\/option>\s*<option value="czarny &lt;i&gt;">czarny &lt;i&gt;<\/option>/,
    );
    expect(lista).toMatch(/<input type="checkbox" name="parametr_7_wyczysc" value="tak"/);
    expect(lista).toContain('parametr własny');
    expect(szablon(html, 'parametr-9')).toMatch(/<input type="text" inputmode="decimal" name="parametr_9"/);
    expect(szablon(html, 'parametr-9')).toContain('Nowa wartość (W)');
    expect(szablon(html, 'parametr-11')).toMatch(/<input type="text" name="parametr_11"/);
  });

  it('link „Magazyn → Ustawienia → Parametry kart" tylko dla uprawnionych', async () => {
    const bez = await panel({ parametryKart: PARAMETRY, mozeUstawieniaMagazynu: false });
    expect(bez).not.toContain('/magazyn/ustawienia/parametry');
    const z = await panel({ parametryKart: PARAMETRY, mozeUstawieniaMagazynu: true });
    expect(z).toMatch(
      /<a class="hz-ustawienia" href="\/magazyn\/ustawienia\/parametry">Magazyn → Ustawienia → Parametry kart<\/a>/,
    );
  });
});
