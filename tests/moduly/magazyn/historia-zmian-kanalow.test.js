import { afterEach, beforeEach, expect, it } from 'vitest';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import { historiaZmianKanalow } from '../../../src/moduly/magazyn/historia-zmian-kanalow.js';
import { zapiszZmianeWKanale } from '../../../src/oms/db/ceny-kanalow.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { powiazProdukt, utworzKarte, zapiszProduktSklepowy } from '../../../src/oms/db/magazyn.js';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';

const kanal = 'sklep_polcien';
const definicje = [{ klucz: kanal, typ: 'woo', etykieta: 'Sklep Półcień' }];
let db, app, karta, innaKarta, admin;

const minuta = (n) => new Date(Date.UTC(2026, 10, 18, 10, n)).toISOString();

function wpis(pola) {
  return zapiszZmianeWKanale(db, {
    kanal,
    kartaId: karta,
    cel: 'produkt:101',
    pole: 'cena',
    stara: 10000,
    nowa: 11000,
    kto: 'operator-polcien',
    at: minuta(0),
    wynik: 'ok',
    ...pola,
  });
}

beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({
    db,
    config: {
      auth: { user: 'serwis-testowy', pass: 'atrapa-testowa' },
      definicje,
      sklepy: { [kanal]: {} },
      kanaly: {},
    },
    magazyn: {},
  });
  await app.ready();
  const login = 'administrator-testowy';
  const id = zalozKonto(db, { login, imie: login, haslo: 'atrapa-testowa', rola: 'operator', admin: true });
  ustawUprawnienia(db, id, ['magazyn']);
  admin = { cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz(login, wczytajSekret(db), Date.now(), 0)}` };
  karta = utworzKarte(db, { nazwa: 'Lampa Półcień', cena_gr: 10000 });
  innaKarta = utworzKarte(db, { nazwa: 'Kinkiet Zmierzch', cena_gr: 5000 });
  powiazProdukt(
    db,
    zapiszProduktSklepowy(db, {
      kanal,
      produkt_id: '101',
      nazwa: 'Lampa Półcień',
      cena_gr: 11000,
      status_publikacji: 'publish',
      adres: 'https://example.test/produkt/101',
      odczytane_at: minuta(0),
    }),
    karta,
  );
});

afterEach(async () => {
  await app?.close();
  db?.close();
});

async function historia(kartaId = karta) {
  const r = await app.inject({ url: `/magazyn/${kartaId}`, headers: admin });
  expect(r.statusCode).toBe(200);
  return { body: r.body, sekcja: r.body.match(/<details[^>]*id="historia-kanalow"[\s\S]*?<\/details>/)?.[0] ?? '' };
}

const wiersze = (sekcja) => sekcja.match(/<tr data-zmiana="\d+">/g) ?? [];

it('bez wpisów karta nie pokazuje sekcji historii', async () => {
  wpis({ kartaId: innaKarta });
  expect(historiaZmianKanalow(db, karta, definicje)).toBeNull();
  const { body } = await historia();
  expect(body).not.toContain('Historia zmian w kanałach');
});

it('najnowsze wpisy są na górze, także przy tej samej chwili (późniejszy id wyżej)', async () => {
  const a = wpis({ at: minuta(1), nowa: 11100 });
  const b = wpis({ at: minuta(3), nowa: 11300 });
  const c = wpis({ at: minuta(2), nowa: 11200 });
  const d = wpis({ at: minuta(3), nowa: 11400 });
  const model = historiaZmianKanalow(db, karta, definicje);
  expect(model.wpisy.map((w) => w.id)).toEqual([d, b, c, a]);
  const { sekcja } = await historia();
  expect(wiersze(sekcja)).toEqual([d, b, c, a].map((id) => `<tr data-zmiana="${id}">`));
});

it('pokazuje najwyżej 50 najnowszych, a w nagłówku liczbę wszystkich', async () => {
  const ids = Array.from({ length: 55 }, (_, i) => wpis({ at: minuta(i) }));
  const model = historiaZmianKanalow(db, karta, definicje);
  expect(model.lacznie).toBe(55);
  expect(model.wpisy).toHaveLength(50);
  const { sekcja } = await historia();
  expect(sekcja).toMatch(/Historia zmian w kanałach \(55\)/);
  expect(sekcja).toContain('pokazano 50 najnowszych');
  expect(wiersze(sekcja)).toHaveLength(50);
  for (const id of ids.slice(0, 5)) expect(sekcja).not.toContain(`data-zmiana="${id}"`);
  expect(sekcja).toContain(`data-zmiana="${ids[54]}"`);
});

it('przy 50 wpisach i mniej nie dopisuje „pokazano”', async () => {
  for (let i = 0; i < 3; i++) wpis({ at: minuta(i) });
  const { sekcja } = await historia();
  expect(sekcja).toMatch(/Historia zmian w kanałach \(3\)/);
  expect(sekcja).not.toContain('pokazano');
});

it('wpisy innej karty są niewidoczne', async () => {
  wpis({ cel: 'produkt:101', at: minuta(1) });
  wpis({ kartaId: innaKarta, cel: 'produkt:999', at: minuta(2) });
  wpis({ kartaId: null, cel: 'produkt:998', at: minuta(3) });
  const model = historiaZmianKanalow(db, karta, definicje);
  expect(model.lacznie).toBe(1);
  const { sekcja } = await historia();
  expect(wiersze(sekcja)).toHaveLength(1);
  expect(sekcja).not.toContain('999');
  expect(sekcja).not.toContain('998');
});

it('pokazuje kto, kiedy, kanał, ofertę, pole, było → jest w zł i wynik', async () => {
  wpis({ at: '2026-11-18T10:05:00Z', stara: 10000, nowa: 1234567, kto: 'operator-polcien' });
  const { sekcja } = await historia();
  expect(sekcja).toContain('operator-polcien');
  expect(sekcja).toContain('2026-11-18 11:05');
  expect(sekcja).toContain('Sklep Półcień');
  expect(sekcja).toContain('produkt 101');
  expect(sekcja).toMatch(/100,00\s*zł/);
  expect(sekcja).toMatch(/12\s345,67\s*zł/);
  expect(sekcja).toContain('zapisano');
});

it('ręczna cena z karty ma czytelny opis, a brak ceny ręcznej to narzut konta', async () => {
  const r = await app.inject({
    method: 'POST',
    url: `/magazyn/${karta}/cena-kanalu`,
    headers: { ...admin, origin: 'http://localhost' },
    payload: { kanal, cena_zl: '149,90' },
  });
  expect(r.statusCode).toBeLessThan(400);
  const { sekcja } = await historia();
  expect(sekcja).toContain('ręczna cena na karcie');
  expect(sekcja).toContain('narzut konta');
  expect(sekcja).toMatch(/149,90\s*zł/);
  expect(sekcja).toContain('administrator-testowy');
});

it('błąd kanału pokazuje treść, a oferta i błąd z HTML-em nie wykonują się', async () => {
  wpis({ cel: 'oferta:<script>alert(1)</script>', wynik: 'blad', blad: '<script>alert(2)</script> odrzucono' });
  wpis({ pole: 'status', stara: 'publish', nowa: 'draft', wynik: 'w_toku', at: minuta(5) });
  const { body, sekcja } = await historia();
  expect(body).not.toContain('<script>alert(1)');
  expect(body).not.toContain('<script>alert(2)');
  expect(sekcja).toContain('&lt;script&gt;alert(2)&lt;/script&gt; odrzucono');
  expect(sekcja).toContain('oferta &lt;script&gt;alert(1)&lt;/script&gt;');
  expect(sekcja).toContain('błąd');
  expect(sekcja).toContain('w toku');
  expect(sekcja).toContain('publish');
});
