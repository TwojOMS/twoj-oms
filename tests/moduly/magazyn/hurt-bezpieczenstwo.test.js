import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { polecenieZFormularza, POLA_HURTU } from '../../../src/domena/magazyn-hurt.js';
import { LIMIT_INFORMACJI_BEZPIECZENSTWA } from '../../../src/domena/allegro-oferta-z-karty.js';

// INFORMACJA O BEZPIECZEŃSTWIE HURTEM. Jeden tekst GPSR zwykle pasuje do całej serii produktów,
// a wpisywanie go karta po karcie przy setkach kart to godziny klikania.
//
// Czego pilnuje ta suita:
//   - puste pole znaczy „nie ruszaj”, nigdy „wróć do tekstu domyślnego konta”;
//   - powrót do tekstu domyślnego (NULL) to osobne, jawne pole wyboru;
//   - tekst i powrót naraz, tekst ponad limit Allegro, pole wysłane dwa razy = odmowa całości;
//   - karta z załącznikami z Allegro je straci — podgląd mówi to wprost i liczy takie karty;
//   - podgląd i zatwierdzenie dają te same zmiany, a zapis oznacza pole jako ręczne.

const config = { auth: { user: 'adam', pass: 'x' } };
const auth = {
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
  origin: 'http://localhost',
};
const STAN_PUSTY = { trwa: false, zaczety_at: null, skonczony_at: null, postep: null, kanaly: [], blad: null };

let db;
const serwer = () => buildOmsServer({ db, config, magazyn: { start: vi.fn(), stan: () => STAN_PUSTY } });

beforeEach(() => {
  db = openOmsDb(':memory:');
});

const TEKST_STARY = 'Pracownia Półcień, ul. Zmyślona 1, 00-001 Miasto. Nie zostawiać włączonej bez nadzoru.';
const TEKST_NOWY = 'Lampa Półcień: używać wyłącznie z żarówką LED do 7 W.';
const tekstowa = (tekst) => JSON.stringify({ typ: 'TEXT', tekst });
const ZALACZNIKI = JSON.stringify({
  typ: 'ATTACHMENTS',
  konto: 'konto-pracowni',
  zalaczniki: [{ id: 'zal-1' }, { id: 'zal-2' }],
});

const kartaO = (nazwa, informacja = null) => {
  const id = utworzKarte(db, { nazwa });
  if (informacja !== null) {
    db.prepare('UPDATE karty_produktow SET informacja_bezpieczenstwa = ? WHERE id = ?').run(informacja, id);
  }
  return id;
};
const kolumna = (id) => db.prepare('SELECT informacja_bezpieczenstwa AS w FROM karty_produktow WHERE id = ?').get(id).w;
const reczne = (id) =>
  db.prepare("SELECT reczne FROM karty_zrodla_pol WHERE karta_id = ? AND pole = 'informacja_bezpieczenstwa'").get(id);
const zaznacz = (...id) => id.map(String);

const post = (app, url, payload, headers = auth) => app.inject({ method: 'POST', url, headers, payload });
const podglad = (app, payload) => post(app, '/magazyn/hurt', payload);
const zatwierdzFormularz = (app, dane) =>
  post(app, '/magazyn/hurt/zatwierdz', dane, { ...auth, 'content-type': 'application/x-www-form-urlencoded' });

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
function daneZPodgladu(body) {
  const dane = new URLSearchParams();
  for (const [input] of sekcja(body).matchAll(/<input\b[^>]*>/g)) {
    const atrybut = (nazwa) => new RegExp(`\\b${nazwa}="([^"]*)"`).exec(input)?.[1];
    const typ = atrybut('type');
    const odEncji = (s) =>
      s
        ?.replace(/&#10;/g, '\n')
        .replace(/&#34;|&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
    if (typ === 'hidden' || (typ === 'checkbox' && /\schecked\b/.test(input))) {
      dane.append(atrybut('name'), odEncji(atrybut('value')));
    }
  }
  return dane.toString();
}

const ETYKIETA = 'Informacja o bezpieczeństwie';
const ZA_DLUGI = (n) =>
  `Informacja o bezpieczeństwie ma ${n} znaków — Allegro przyjmie najwyżej ${LIMIT_INFORMACJI_BEZPIECZENSTWA}.`;

describe('informacja o bezpieczeństwie hurtem — formularz', () => {
  it('oba pola są na liście pól hurtu', () => {
    expect(POLA_HURTU).toContain('informacja_bezpieczenstwa');
    expect(POLA_HURTU).toContain('informacja_bezpieczenstwa_domyslna');
  });

  it('puste pole tekstu i brak pola wyboru = brak polecenia dla tej kolumny', () => {
    const { polecenie, blad } = polecenieZFormularza({
      informacja_bezpieczenstwa: '  \r\n ',
      stawka_vat: '23',
    });
    expect(blad).toBe(null);
    expect(Object.hasOwn(polecenie, 'informacja_bezpieczenstwa')).toBe(false);
  });

  it('tekst daje kształt TEXT, przycięty i z nowymi liniami bez \\r', () => {
    const { polecenie, blad } = polecenieZFormularza({ informacja_bezpieczenstwa: '  Linia 1\r\nLinia 2 \n' });
    expect(blad).toBe(null);
    expect(polecenie.informacja_bezpieczenstwa).toBe(tekstowa('Linia 1\nLinia 2'));
  });

  it('pole wyboru „wróć do tekstu domyślnego konta” daje NULL', () => {
    const { polecenie, blad } = polecenieZFormularza({ informacja_bezpieczenstwa_domyslna: 'tak' });
    expect(blad).toBe(null);
    expect(Object.hasOwn(polecenie, 'informacja_bezpieczenstwa')).toBe(true);
    expect(polecenie.informacja_bezpieczenstwa).toBe(null);
  });

  it('tekst i powrót do domyślnego naraz = odmowa', () => {
    const { polecenie, blad } = polecenieZFormularza({
      informacja_bezpieczenstwa: TEKST_NOWY,
      informacja_bezpieczenstwa_domyslna: 'tak',
    });
    expect(polecenie).toBe(null);
    expect(blad).toMatch(/naraz/);
  });

  it('tekst ponad limit Allegro = odmowa z tym samym komunikatem co na karcie', () => {
    const dlugi = 'a'.repeat(LIMIT_INFORMACJI_BEZPIECZENSTWA + 1);
    const { polecenie, blad } = polecenieZFormularza({ informacja_bezpieczenstwa: dlugi });
    expect(polecenie).toBe(null);
    expect(blad).toBe(ZA_DLUGI(LIMIT_INFORMACJI_BEZPIECZENSTWA + 1));
    const rowny = polecenieZFormularza({ informacja_bezpieczenstwa: 'a'.repeat(LIMIT_INFORMACJI_BEZPIECZENSTWA) });
    expect(rowny.blad).toBe(null);
  });

  it.each([
    [{ informacja_bezpieczenstwa: [TEKST_NOWY, TEKST_STARY] }],
    [{ informacja_bezpieczenstwa_domyslna: ['tak', 'tak'] }],
  ])('pole wysłane dwa razy = odmowa (%j)', (body) => {
    const { polecenie, blad } = polecenieZFormularza(body);
    expect(polecenie).toBe(null);
    expect(blad).toMatch(/dwa razy/);
  });
});

describe('informacja o bezpieczeństwie hurtem — podgląd i zapis', () => {
  it('pasek „Edytuj” ma pole tekstu z limitem Allegro i osobne pole powrotu do domyślnego', async () => {
    kartaO('Lampa Półcień Kula');
    const r = await serwer().inject({ method: 'GET', url: '/magazyn', headers: auth });
    expect(r.statusCode).toBe(200);
    const pasek = /<section[^>]*id="hurt-pasek"[\s\S]*?<\/section>/.exec(r.body)[0];
    const pole = /<textarea[^>]*name="informacja_bezpieczenstwa"[^>]*>/.exec(pasek)?.[0] ?? '';
    expect(pole).toContain(`maxlength="${LIMIT_INFORMACJI_BEZPIECZENSTWA}"`);
    expect(pasek).toMatch(/<textarea[^>]*name="informacja_bezpieczenstwa"[^>]*><\/textarea>/);
    expect(pasek).toMatch(/<input type="checkbox" name="informacja_bezpieczenstwa_domyslna" value="tak"/);
  });

  it('puste pole przy innej zmianie nie rusza informacji (ani na podglądzie, ani w bazie)', async () => {
    const z = kartaO('Lampa Półcień Kula', tekstowa(TEKST_STARY));
    const zal = kartaO('Lampa Półcień Walec', ZALACZNIKI);
    const app = serwer();
    const r = await podglad(app, {
      zaznaczone: zaznacz(z, zal),
      stawka_vat: '23',
      informacja_bezpieczenstwa: '',
    });
    expect(r.statusCode).toBe(200);
    expect(tekst(r.body)).not.toContain(ETYKIETA);
    expect(tekst(r.body)).not.toMatch(/stracą? załączniki/);

    const zapis = await zatwierdzFormularz(app, daneZPodgladu(r.body));
    expect(zapis.statusCode).toBe(200);
    expect(ileNaEkranie(zapis.body)).toBe('2');
    expect(kolumna(z)).toBe(tekstowa(TEKST_STARY));
    expect(kolumna(zal)).toBe(ZALACZNIKI);
  });

  it('tekst: podgląd „z/na”, zatwierdzenie zapisuje TEXT z reczne=1, ta sama treść nie jest zmianą', async () => {
    const z = kartaO('Lampa Półcień Kula', tekstowa(TEKST_STARY));
    const bez = kartaO('Lampa Półcień Stożek');
    const juz = kartaO('Lampa Półcień Walec', tekstowa(TEKST_NOWY));
    const app = serwer();
    const r = await podglad(app, {
      zaznaczone: zaznacz(z, bez, juz),
      informacja_bezpieczenstwa: `${TEKST_NOWY}\r\n`,
    });

    expect(r.statusCode).toBe(200);
    expect(ileNaEkranie(r.body)).toBe('2');
    expect(nazwyWPodgladzie(r.body)).toEqual(['Lampa Półcień Kula', 'Lampa Półcień Stożek']);
    const [, etykieta, zKula, naKula] = wierszZmiany(r.body, 'Lampa Półcień Kula');
    expect(etykieta).toBe(ETYKIETA);
    expect(zKula).toContain('Pracownia Półcień');
    expect(naKula).toBe(TEKST_NOWY);
    expect(wierszZmiany(r.body, 'Lampa Półcień Stożek').slice(1)).toEqual([
      ETYKIETA,
      'tekst domyślny konta',
      TEKST_NOWY,
    ]);
    expect(tekst(r.body)).not.toMatch(/stracą? załączniki/);
    expect(kolumna(z)).toBe(tekstowa(TEKST_STARY));

    const zapis = await zatwierdzFormularz(app, daneZPodgladu(r.body));
    expect(zapis.statusCode).toBe(200);
    expect(ileNaEkranie(zapis.body)).toBe('2');
    expect(kolumna(z)).toBe(tekstowa(TEKST_NOWY));
    expect(kolumna(bez)).toBe(tekstowa(TEKST_NOWY));
    expect(reczne(z)).toEqual({ reczne: 1 });
    expect(reczne(bez)).toEqual({ reczne: 1 });
  });

  it('powrót do domyślnego: NULL na kartach z tekstem i załącznikami, karta bez wartości nie jest zmianą', async () => {
    const z = kartaO('Lampa Półcień Kula', tekstowa(TEKST_STARY));
    const zal = kartaO('Lampa Półcień Walec', ZALACZNIKI);
    const bez = kartaO('Lampa Półcień Stożek');
    const app = serwer();
    const r = await podglad(app, {
      zaznaczone: zaznacz(z, zal, bez),
      informacja_bezpieczenstwa: '',
      informacja_bezpieczenstwa_domyslna: 'tak',
    });

    expect(r.statusCode).toBe(200);
    expect(ileNaEkranie(r.body)).toBe('2');
    expect(nazwyWPodgladzie(r.body)).toEqual(['Lampa Półcień Kula', 'Lampa Półcień Walec']);
    expect(wierszZmiany(r.body, 'Lampa Półcień Walec').slice(1)).toEqual([
      ETYKIETA,
      'załączniki z Allegro (2)',
      'tekst domyślny konta',
    ]);
    expect(tekst(r.body)).toContain('1 karta straci załączniki z Allegro');

    const zapis = await zatwierdzFormularz(app, daneZPodgladu(r.body));
    expect(zapis.statusCode).toBe(200);
    expect(ileNaEkranie(zapis.body)).toBe('2');
    expect([kolumna(z), kolumna(zal), kolumna(bez)]).toEqual([null, null, null]);
    expect(reczne(zal)).toEqual({ reczne: 1 });
  });

  it('tekst na kartach z załącznikami: ostrzeżenie liczy tylko karty z załącznikami', async () => {
    const zal1 = kartaO('Lampa Półcień Walec', ZALACZNIKI);
    const zal2 = kartaO('Lampa Półcień Kula', ZALACZNIKI);
    const z = kartaO('Lampa Półcień Stożek', tekstowa(TEKST_STARY));
    const r = await podglad(serwer(), {
      zaznaczone: zaznacz(zal1, zal2, z),
      informacja_bezpieczenstwa: TEKST_NOWY,
    });
    expect(r.statusCode).toBe(200);
    expect(ileNaEkranie(r.body)).toBe('3');
    expect(tekst(r.body)).toContain('2 karty stracą załączniki z Allegro');
    expect(tekst(r.body)).not.toContain('3 karty');
  });

  it('tekst ponad limit = odmowa przed podglądem, nic nie zapisano', async () => {
    const z = kartaO('Lampa Półcień Kula', tekstowa(TEKST_STARY));
    const dlugi = 'b'.repeat(LIMIT_INFORMACJI_BEZPIECZENSTWA + 3);
    const app = serwer();
    const r = await podglad(app, { zaznaczone: zaznacz(z), informacja_bezpieczenstwa: dlugi });
    expect(r.statusCode).toBe(400);
    expect(tekst(r.body)).toContain(ZA_DLUGI(LIMIT_INFORMACJI_BEZPIECZENSTWA + 3));
    expect(r.body).not.toContain('<div class="nazwa-karty">');

    const zapis = await post(app, '/magazyn/hurt/zatwierdz', {
      zaznaczone: zaznacz(z),
      informacja_bezpieczenstwa: dlugi,
    });
    expect(zapis.statusCode).toBe(400);
    expect(kolumna(z)).toBe(tekstowa(TEKST_STARY));
  });

  it('tekst i powrót do domyślnego naraz = odmowa całości', async () => {
    const z = kartaO('Lampa Półcień Kula', tekstowa(TEKST_STARY));
    const app = serwer();
    const zapis = await post(app, '/magazyn/hurt/zatwierdz', {
      zaznaczone: zaznacz(z),
      stawka_vat: '23',
      informacja_bezpieczenstwa: TEKST_NOWY,
      informacja_bezpieczenstwa_domyslna: 'tak',
    });
    expect(zapis.statusCode).toBe(400);
    expect(kolumna(z)).toBe(tekstowa(TEKST_STARY));
  });
});
