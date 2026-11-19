import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { planHurtu, podpisCen, polecenieZFormularza } from '../../../src/domena/magazyn-hurt.js';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';

// CENA KATALOGOWA HURTEM. Tryby względne („o %”, „o kwotę”) nie są idempotentne: ten sam formularz
// wysłany drugi raz dałby +21% zamiast +10%. Dlatego zatwierdzenie porównuje ceny z podpisem
// z podglądu, a podgląd i zapis liczą tę samą funkcją domeny.

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

const karta = (nazwa, cena_gr = null, reszta = {}) => {
  const id = utworzKarte(db, { nazwa, ...(cena_gr === null ? {} : { cena_gr }), ...reszta });
  db.prepare('UPDATE karty_produktow SET zmieniony_at = ? WHERE id = ?').run(STARY_ZNACZNIK, id);
  return id;
};
const cena = (id) => db.prepare('SELECT cena_gr FROM karty_produktow WHERE id = ?').get(id).cena_gr;
const ustawCene = (id, gr) => db.prepare('UPDATE karty_produktow SET cena_gr = ? WHERE id = ?').run(gr, id);
const post = (url, payload, h = headers) => app.inject({ method: 'POST', url, headers: h, payload });
const podglad = (payload) => post('/magazyn/hurt', payload);
const zFormularza = () => ({ ...headers, 'content-type': 'application/x-www-form-urlencoded' });
const zatwierdzFormularz = (dane) => post('/magazyn/hurt/zatwierdz', dane, zFormularza());
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
  return [...w.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) =>
    m[1]
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}
const tekst = (body) =>
  sekcja(body)
    .replace(/<[^>]*>/g, '')
    .replace(/&#34;|&quot;/g, '"')
    .replace(/\s+/g, ' ');

// Dokładnie to, co wysłałaby przeglądarka z podglądu: ukryte pola i zaznaczone pola wyboru kart.
function daneZPodgladu(body, odznaczone = []) {
  const dane = new URLSearchParams();
  for (const [input] of sekcja(body).matchAll(/<input\b[^>]*>/g)) {
    const atrybut = (nazwa) => new RegExp(`\\b${nazwa}="([^"]*)"`).exec(input)?.[1];
    const typ = atrybut('type');
    const wartosc = atrybut('value');
    if (typ === 'hidden' || (typ === 'checkbox' && /\schecked\b/.test(input) && !odznaczone.includes(wartosc))) {
      dane.append(atrybut('name'), wartosc);
    }
  }
  return dane.toString();
}

const ZMIENIONE_OD_PODGLADU = 'Ceny zmieniły się od podglądu — otwórz podgląd ponownie';

describe('cena katalogowa hurtem — formularz', () => {
  const polecenie = (pola) => polecenieZFormularza(pola);

  it.each([
    [
      { cena_tryb: 'o_procent', cena_wartosc: '10' },
      { tryb: 'o_procent', wartosc: 1000, zaokraglenie: 'grosz' },
    ],
    [
      { cena_tryb: 'o_procent', cena_wartosc: '+7,5' },
      { tryb: 'o_procent', wartosc: 750, zaokraglenie: 'grosz' },
    ],
    [
      { cena_tryb: 'o_procent', cena_wartosc: '-12.25', cena_zaokraglenie: '99' },
      { tryb: 'o_procent', wartosc: -1225, zaokraglenie: '99' },
    ],
    [
      { cena_tryb: 'o_kwote', cena_wartosc: '-5,50', cena_zaokraglenie: 'zloty' },
      { tryb: 'o_kwote', wartosc: -550, zaokraglenie: 'zloty' },
    ],
    [
      { cena_tryb: 'o_kwote', cena_wartosc: '+5' },
      { tryb: 'o_kwote', wartosc: 500, zaokraglenie: 'grosz' },
    ],
    // „Na kwotę” podaje cenę wprost — zaokrąglenie z formularza jest ignorowane.
    [
      { cena_tryb: 'na_kwote', cena_wartosc: '49,90', cena_zaokraglenie: '99' },
      { tryb: 'na_kwote', wartosc: 4990, zaokraglenie: 'grosz' },
    ],
  ])('%j → polecenie ceny', (pola, oczekiwane) => {
    const { polecenie: p, blad } = polecenie(pola);
    expect(blad).toBe(null);
    expect(p.cenaKatalogowa).toEqual(oczekiwane);
  });

  it('„nie zmieniaj” z domyślnym zaokrągleniem nie jest poleceniem ceny', () => {
    const { polecenie: p, blad } = polecenie({ cena_tryb: '', cena_wartosc: '', cena_zaokraglenie: 'grosz' });
    expect(blad).toBe(null);
    expect(p).toEqual({});
  });

  it.each([
    [{ cena_tryb: 'o_procent', cena_wartosc: '' }, /wpisz/i],
    [{ cena_tryb: '', cena_wartosc: '10' }, /wybierz/i],
    [{ cena_tryb: 'o_dwa', cena_wartosc: '10' }, /tryb|wybierz/i],
    [{ cena_tryb: 'o_procent', cena_wartosc: 'dużo' }, /procent/i],
    [{ cena_tryb: 'o_procent', cena_wartosc: '10,123' }, /procent/i],
    [{ cena_tryb: 'o_procent', cena_wartosc: '-100' }, /−99% a \+1000%/],
    [{ cena_tryb: 'o_procent', cena_wartosc: '1000,01' }, /−99% a \+1000%/],
    [{ cena_tryb: 'o_kwote', cena_wartosc: '5 zł' }, /kwot/i],
    [{ cena_tryb: 'na_kwote', cena_wartosc: '-5' }, /kwot/i],
    [{ cena_tryb: 'o_kwote', cena_wartosc: '5', cena_zaokraglenie: 'do_setki' }, /zaokrągl/i],
    [{ cena_tryb: ['o_procent', 'o_kwote'], cena_wartosc: '5' }, /dwa razy/],
    [{ cena_tryb: 'o_kwote', cena_wartosc: ['5', '6'] }, /dwa razy/],
  ])('%j → odmowa całości', (pola, komunikat) => {
    const { polecenie: p, blad } = polecenie({ stawka_vat: '23', ...pola });
    expect(p).toBe(null);
    expect(blad).toMatch(komunikat);
  });

  it('procent na granicach zakresu jest przyjęty', () => {
    expect(polecenie({ cena_tryb: 'o_procent', cena_wartosc: '-99' }).polecenie.cenaKatalogowa.wartosc).toBe(-9900);
    expect(polecenie({ cena_tryb: 'o_procent', cena_wartosc: '1000' }).polecenie.cenaKatalogowa.wartosc).toBe(100000);
  });
});

describe('cena katalogowa hurtem — plan (domena)', () => {
  it('wynik ≤ 0 na jednej karcie: odmowa całości z nazwą karty i rachunkiem, plan pusty', () => {
    const karty = [
      { id: 1, nazwa: 'Lampa Duża', sku: 'AAE001', cena_gr: 2000 },
      { id: 2, nazwa: 'Lampa Mała', sku: 'AAE007', cena_gr: 499 },
    ];
    const wynik = planHurtu(karty, { cenaKatalogowa: { tryb: 'o_kwote', wartosc: -1000, zaokraglenie: 'grosz' } });
    expect(wynik.plan).toEqual([]);
    expect(wynik.blad).toContain('Lampa Mała');
    expect(wynik.blad).toContain('4,99 zł − 10,00 zł = −5,01 zł');
  });
});

describe('cena katalogowa hurtem — podgląd i zatwierdzenie', () => {
  it('pasek „Edytuj” ma tryb, wartość ze znakiem i zaokrąglenie', async () => {
    const r = await app.inject({ method: 'GET', url: '/magazyn', headers });
    const pasek = /<details[^>]*id="hurt-pasek"[\s\S]*?<\/details>/.exec(r.body)[0];
    // Wiersz ceny pojawia się dopiero po wybraniu pozycji, więc tryb nie potrzebuje pustej opcji.
    expect(pasek).toMatch(
      /<select name="cena_tryb"[^>]*>\s*<option value="o_procent">zmień o %<\/option>\s*<option value="o_kwote">zmień o kwotę \(zł\)<\/option>\s*<option value="na_kwote">ustaw kwotę \(zł\)<\/option>/,
    );
    expect(pasek).toMatch(/<input type="text" name="cena_wartosc"/);
    // Klawiatura „decimal” na iOS nie ma minusa, a pole przyjmuje obniżkę („-5,50”).
    expect(pasek).not.toMatch(/name="cena_wartosc"[^>]*inputmode=/);
    expect(pasek).toMatch(
      /<select name="cena_zaokraglenie">\s*<option value="grosz" selected>do grosza<\/option>\s*<option value="99">końcówka ,99<\/option>\s*<option value="zloty">do pełnej złotówki<\/option>/,
    );
  });

  it('podgląd „+10%”: wiersz z procentem, karty bez ceny pominięte i policzone, nic nie zapisane', async () => {
    const z = karta('Lampa Kula', 4999);
    const d = karta('Lampa Stożek', 1000);
    const bez = Array.from({ length: 5 }, (_, i) => karta(`Lampa bez ceny ${i}`));
    const r = await podglad({ zaznaczone: zaznacz(z, d, ...bez), cena_tryb: 'o_procent', cena_wartosc: '10' });

    expect(r.statusCode).toBe(200);
    expect(ileNaEkranie(r.body)).toBe('2');
    expect(nazwyWPodgladzie(r.body)).toEqual(['Lampa Kula', 'Lampa Stożek']);
    expect(wierszZmiany(r.body, 'Lampa Kula').slice(1)).toEqual(['Cena katalogowa', '49,99 zł', '54,99 zł (+10,0%)']);
    expect(wierszZmiany(r.body, 'Lampa Stożek').slice(1)).toEqual(['Cena katalogowa', '10,00 zł', '11,00 zł (+10,0%)']);
    const t = tekst(r.body);
    expect(t).toContain(
      'Pominięte: 5 kart bez ceny katalogowej — zmiana o % i o kwotę potrzebuje ceny. Ustaw im cenę trybem „zmień na kwotę”.',
    );
    expect(t).toContain(
      'Zmienia cenę katalogową w OMS. Oferty Allegro wystawione z OMS przeliczą się same przy przebiegu pętli (narzut konta); do sklepów i pozostałych ofert cena pójdzie dopiero przyciskiem „Wyślij ceny do kanałów”.',
    );
    expect(t).not.toContain('duża zmiana');
    expect([cena(z), cena(d), ...bez.map(cena)]).toEqual([4999, 1000, null, null, null, null, null]);
  });

  it('zatwierdzenie z podglądu zapisuje te same ceny co podgląd, karta bez ceny zostaje bez ceny', async () => {
    const z = karta('Lampa Kula', 5120);
    const bez = karta('Lampa Klosz');
    const r = await podglad({
      zaznaczone: zaznacz(z, bez),
      cena_tryb: 'o_procent',
      cena_wartosc: '-7,5',
      cena_zaokraglenie: '99',
    });
    // 51,20 × 0,925 = 47,36 → końcówka ,99 = 47,99
    expect(wierszZmiany(r.body, 'Lampa Kula').slice(1)).toEqual(['Cena katalogowa', '51,20 zł', '47,99 zł (−6,3%)']);

    const zapis = await zatwierdzFormularz(daneZPodgladu(r.body));
    expect(zapis.statusCode).toBe(200);
    expect(ileNaEkranie(zapis.body)).toBe('1');
    expect(cena(z)).toBe(4799);
    expect(cena(bez)).toBe(null);
    const reczne = db.prepare("SELECT reczne FROM karty_zrodla_pol WHERE karta_id = ? AND pole = 'cena_gr'").get(z);
    expect(reczne).toEqual({ reczne: 1 });
  });

  it('ponowne wysłanie tego samego formularza „+10%” po zapisie = odmowa, cena nie rośnie drugi raz', async () => {
    const z = karta('Lampa Kula', 4999);
    const d = karta('Lampa Stożek', 1000);
    const r = await podglad({ zaznaczone: zaznacz(z, d), cena_tryb: 'o_procent', cena_wartosc: '10' });
    const dane = daneZPodgladu(r.body);

    expect((await zatwierdzFormularz(dane)).statusCode).toBe(200);
    expect([cena(z), cena(d)]).toEqual([5499, 1100]);

    const drugi = await zatwierdzFormularz(dane);
    expect(drugi.statusCode).toBe(400);
    expect(tekst(drugi.body)).toContain(ZMIENIONE_OD_PODGLADU);
    expect([cena(z), cena(d)]).toEqual([5499, 1100]);
  });

  it('cena zmieniona między podglądem a zatwierdzeniem = odmowa całości', async () => {
    const z = karta('Lampa Kula', 4999);
    const d = karta('Lampa Stożek', 1000);
    const r = await podglad({ zaznaczone: zaznacz(z, d), cena_tryb: 'o_kwote', cena_wartosc: '+5' });
    ustawCene(d, 2000);

    const zapis = await zatwierdzFormularz(daneZPodgladu(r.body));
    expect(zapis.statusCode).toBe(400);
    expect(tekst(zapis.body)).toContain(ZMIENIONE_OD_PODGLADU);
    expect([cena(z), cena(d)]).toEqual([4999, 2000]);
  });

  it('karta w planie za inne pole, pominięta przy cenie, dostała cenę po podglądzie = odmowa całości', async () => {
    const z = karta('Lampa Kula', 4999);
    const bez = karta('Lampa Klosz', null, { stawka_vat: '23' });
    const r = await podglad({
      zaznaczone: zaznacz(z, bez),
      stawka_vat: '8',
      cena_tryb: 'o_kwote',
      cena_wartosc: '+5',
    });
    expect(nazwyWPodgladzie(r.body)).toEqual(['Lampa Klosz', 'Lampa Kula']);
    ustawCene(bez, 2000);

    const zapis = await zatwierdzFormularz(daneZPodgladu(r.body));
    expect(zapis.statusCode).toBe(400);
    expect(tekst(zapis.body)).toContain(ZMIENIONE_OD_PODGLADU);
    expect([cena(z), cena(bez)]).toEqual([4999, 2000]);
  });

  it('zatwierdzenie ceny bez podpisu z podglądu = odmowa', async () => {
    const z = karta('Lampa Kula', 4999);
    const zapis = await post('/magazyn/hurt/zatwierdz', {
      zaznaczone: zaznacz(z),
      cena_tryb: 'o_procent',
      cena_wartosc: '10',
    });
    expect(zapis.statusCode).toBe(400);
    expect(tekst(zapis.body)).toContain(ZMIENIONE_OD_PODGLADU);
    expect(cena(z)).toBe(4999);
  });

  it('odznaczona w podglądzie karta nie dostaje nowej ceny, reszta tak', async () => {
    const z = karta('Lampa Kula', 4999);
    const d = karta('Lampa Stożek', 1000);
    const r = await podglad({ zaznaczone: zaznacz(z, d), cena_tryb: 'o_kwote', cena_wartosc: '1' });
    const zapis = await zatwierdzFormularz(daneZPodgladu(r.body, [String(d)]));
    expect(zapis.statusCode).toBe(200);
    expect([cena(z), cena(d)]).toEqual([5099, 1000]);
  });

  it('„na kwotę” ustawia cenę także kartom bez ceny; karta z tą samą ceną nie wchodzi', async () => {
    const z = karta('Lampa Kula', 4999);
    const juzMa = karta('Lampa Walec', 3000);
    const bez = karta('Lampa Klosz');
    const r = await podglad({
      zaznaczone: zaznacz(z, juzMa, bez),
      cena_tryb: 'na_kwote',
      cena_wartosc: '30',
      cena_zaokraglenie: '99',
    });
    expect(nazwyWPodgladzie(r.body)).toEqual(['Lampa Klosz', 'Lampa Kula']);
    expect(wierszZmiany(r.body, 'Lampa Klosz').slice(1)).toEqual(['Cena katalogowa', '—', '30,00 zł']);
    expect(wierszZmiany(r.body, 'Lampa Kula').slice(1)).toEqual(['Cena katalogowa', '49,99 zł', '30,00 zł (−40,0%)']);
    expect(tekst(r.body)).not.toContain('Pominięte');

    expect((await zatwierdzFormularz(daneZPodgladu(r.body))).statusCode).toBe(200);
    expect([cena(z), cena(juzMa), cena(bez)]).toEqual([3000, 3000, 3000]);
  });

  it('zmiana > 50% w którąkolwiek stronę jest oznaczona „duża zmiana”, dokładnie 50% nie', async () => {
    // Próg liczy się z faktycznej zmiany ceny, nie z zaokrąglonego procentu na ekranie.
    const w = karta('Lampa Wysoka', 10000);
    const r = await podglad({ zaznaczone: zaznacz(w), cena_tryb: 'o_procent', cena_wartosc: '50' });
    expect(wierszZmiany(r.body, 'Lampa Wysoka')[3]).toBe('150,00 zł (+50,0%)');
    expect(tekst(r.body)).not.toContain('duża zmiana');

    const g = await podglad({ zaznaczone: zaznacz(w), cena_tryb: 'o_procent', cena_wartosc: '50,01' });
    expect(wierszZmiany(g.body, 'Lampa Wysoka')[3]).toBe('150,01 zł (+50,0%) duża zmiana');

    const d = await podglad({ zaznaczone: zaznacz(w), cena_tryb: 'o_kwote', cena_wartosc: '-50,01' });
    expect(wierszZmiany(d.body, 'Lampa Wysoka')[3]).toBe('49,99 zł (−50,0%) duża zmiana');

    const n = await podglad({ zaznaczone: zaznacz(w), cena_tryb: 'o_kwote', cena_wartosc: '-50' });
    expect(wierszZmiany(n.body, 'Lampa Wysoka')[3]).toBe('50,00 zł (−50,0%)');
  });

  it('wynik ≤ 0 na jednej karcie: odmowa całości z nazwą i rachunkiem, żadna karta nie zmieniona', async () => {
    const duza = karta('Lampa Duża', 2000);
    const mala = karta('Lampa Mała', 499, { sku: 'AAE007' });
    const r = await podglad({ zaznaczone: zaznacz(duza, mala), cena_tryb: 'o_kwote', cena_wartosc: '-10' });
    expect(r.statusCode).toBe(400);
    const t = tekst(r.body);
    expect(t).toContain('Lampa Mała');
    expect(t).toContain('4,99 zł − 10,00 zł = −5,01 zł');
    expect(r.body).not.toContain('id="zatwierdz-hurt"');
    expect([cena(duza), cena(mala)]).toEqual([2000, 499]);
  });

  it('wynik ≤ 0 przy zatwierdzeniu (z poprawnym podpisem cen) = odmowa całości, druga karta też nie zmieniona', async () => {
    const duza = karta('Lampa Duża', 2000);
    const mala = karta('Lampa Mała', 499);
    const zapis = await post('/magazyn/hurt/zatwierdz', {
      zaznaczone: zaznacz(duza, mala),
      cena_tryb: 'o_kwote',
      cena_wartosc: '-10',
      cena_podpis: podpisCen([
        { id: duza, cena_gr: 2000 },
        { id: mala, cena_gr: 499 },
      ]),
    });
    expect(zapis.statusCode).toBe(400);
    expect(tekst(zapis.body)).toContain('4,99 zł − 10,00 zł = −5,01 zł');
    expect([cena(duza), cena(mala)]).toEqual([2000, 499]);
  });

  it('procent poza zakresem −99…+1000 = odmowa całości także podglądu', async () => {
    const z = karta('Lampa Kula', 4999);
    const r = await podglad({ zaznaczone: zaznacz(z), cena_tryb: 'o_procent', cena_wartosc: '-99,5' });
    expect(r.statusCode).toBe(400);
    expect(tekst(r.body)).toContain('−99% a +1000%');
    expect(cena(z)).toBe(4999);
  });
});
