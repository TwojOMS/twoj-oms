import { afterEach, beforeEach, expect, it } from 'vitest';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import { cenyReczneKarty } from '../../../src/oms/db/ceny-kanalow.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { kartaPoId, powiazProdukt, utworzKarte, zapiszProduktSklepowy } from '../../../src/oms/db/magazyn.js';
import { zapiszUstawieniaOfertKonta } from '../../../src/oms/db/oferty-kanalow.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';

const kanal = 'sklep_polcien';
const at = '2026-11-18T12:00:00Z';
let db, app, karta, url, admin, operator;

function lustro(id, status) {
  powiazProdukt(
    db,
    zapiszProduktSklepowy(db, {
      kanal,
      produkt_id: id,
      nazwa: 'Lampa Półcień',
      cena_gr: 9900,
      status_publikacji: status,
      adres: `https://example.test/produkt/${id}`,
      odczytane_at: at,
    }),
    karta,
  );
}

beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({
    db,
    config: {
      auth: { user: 'serwis-testowy', pass: 'atrapa-testowa' },
      definicje: [
        { klucz: kanal, typ: 'woo', etykieta: 'Sklep Półcień' },
        { klucz: 'sklep_drugi', typ: 'woo', etykieta: 'Sklep Drugi' },
      ],
      sklepy: { [kanal]: {}, sklep_drugi: {} },
      kanaly: {},
    },
    magazyn: {},
  });
  await app.ready();
  const konto = (login, czyAdmin) => {
    const id = zalozKonto(db, { login, imie: login, haslo: 'atrapa-testowa', rola: 'operator', admin: czyAdmin });
    ustawUprawnienia(db, id, ['magazyn']);
    return {
      origin: 'http://localhost',
      cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz(login, wczytajSekret(db), Date.now(), 0)}`,
    };
  };
  admin = konto('administrator-testowy', true);
  operator = konto('operator-testowy', false);
  karta = utworzKarte(db, { nazwa: 'Lampa Półcień', cena_gr: 10000 });
  url = `/magazyn/${karta}`;
  zapiszUstawieniaOfertKonta(db, kanal, { narzutProcent: 10 }, { aktor: 'administrator-testowy', teraz: at });
  lustro('1', 'draft');
});

afterEach(async () => {
  await app?.close();
  db?.close();
});

const post = (pola, headers = admin) =>
  app.inject({ method: 'POST', url: `${url}/cena-kanalu`, headers, payload: { kanal, ...pola } });

async function okienka(headers = admin) {
  const r = await app.inject({ url, headers });
  expect(r.statusCode).toBe(200);
  return r.body.match(/<section[^>]*id="sprzedaz-kanalow"[\s\S]*?<\/section>/)?.[0] ?? '';
}

it('pokazuje narzut konta oraz formularz podglądu dla tej karty', async () => {
  const html = await okienka();
  expect(html).toContain('z karty + 10% (110,00 zł)');
  expect(html).toContain('action="/magazyn/ceny-kanalow/podglad"');
  expect(html).toContain(`name="karty" value="${karta}"`);
});

it('zapisuje ręczną cenę w groszach, pokazuje ją zamiast narzutu i pozwala wrócić do narzutu', async () => {
  const zapis = await post({ cena_zl: '105,00' });
  expect(zapis.statusCode).toBe(303);
  expect(zapis.headers.location).toBe(`${url}#sprzedaz-kanalow`);
  expect(cenyReczneKarty(db, karta)).toEqual(new Map([[kanal, 10500]]));
  expect(kartaPoId(db, karta).cena_gr).toBe(10000);
  const html = await okienka();
  expect(html).toContain('ręczna 105,00 zł');
  expect(html).not.toContain('z karty + 10% (110,00 zł)');
  expect((await post({ wyczysc: '1' })).statusCode).toBe(303);
  expect(cenyReczneKarty(db, karta).size).toBe(0);
  expect(await okienka()).toContain('z karty + 10% (110,00 zł)');
  expect(db.prepare('SELECT stara, nowa FROM zmiany_w_kanalach ORDER BY id').all()).toEqual([
    { stara: null, nowa: '10500' },
    { stara: '10500', nowa: null },
  ]);
});

it('odrzuca zero i niepoprawną kwotę bez zmiany ustawień', async () => {
  for (const cena_zl of ['0', '0,00', '', '12 zł']) {
    expect((await post({ cena_zl })).statusCode).toBe(400);
  }
  expect(cenyReczneKarty(db, karta).size).toBe(0);
});

it('odmawia operatorowi, żądaniu bez Origin i edycji konta spoza karty', async () => {
  expect((await post({ cena_zl: '105' }, operator)).statusCode).toBe(403);
  expect((await post({ cena_zl: '105' }, { cookie: admin.cookie })).statusCode).toBe(403);
  expect((await post({ kanal: 'inne_konto', cena_zl: '105' })).statusCode).toBe(404);
  expect(await okienka(operator)).not.toContain('cena-kanalu');
  expect(await okienka(operator)).not.toContain('Wyślij ceny do kanałów');
  expect(cenyReczneKarty(db, karta).size).toBe(0);
});

it('opisuje szkic i preferuje odnośnik do opublikowanego produktu', async () => {
  expect(await okienka()).toContain('szkic w sklepie');
  lustro('2', 'publish');
  const html = await okienka();
  expect(html).toContain('1 szkic w sklepie');
  expect(html).toContain('href="https://example.test/produkt/2"');
  expect(html).not.toContain('href="https://example.test/produkt/1"');
});

it('odmawia kontu obsługującemu ceny, gdy karta nie ma w nim powiązania', async () => {
  expect((await post({ kanal: 'sklep_drugi', cena_zl: '105' })).statusCode).toBe(404);
  expect(cenyReczneKarty(db, karta).size).toBe(0);
});

it('nie dopisuje do dziennika, gdy cena się nie zmienia', async () => {
  expect((await post({ wyczysc: '1' })).statusCode).toBe(303);
  expect((await post({ cena_zl: '105' })).statusCode).toBe(303);
  expect((await post({ cena_zl: '105,00' })).statusCode).toBe(303);
  expect(db.prepare('SELECT stara, nowa FROM zmiany_w_kanalach').all()).toEqual([{ stara: null, nowa: '10500' }]);
});

it('cofa ręczną cenę, gdy zapis do dziennika się nie uda', async () => {
  db.exec('DROP TABLE zmiany_w_kanalach');
  expect((await post({ cena_zl: '105' })).statusCode).toBe(500);
  expect(db.isTransaction).toBe(false);
  expect(cenyReczneKarty(db, karta).size).toBe(0);
});
