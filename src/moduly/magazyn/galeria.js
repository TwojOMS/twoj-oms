import multipart from '@fastify/multipart';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { constants, copyFileSync, linkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { zapiszZdjecie, LIMIT } from './services/zdjecia-pliki.js';
import { stronaOdmowy } from '../../core/web/odmowa.js';
import { ustawZnacznikAi } from './services/znacznik-ai.js';
import { adresKanalu, rodzajKanalu } from '../../domena/kanaly.js';

const zdjecia = (db, id) => db.prepare('SELECT * FROM zdjecia_kart WHERE karta_id = ? ORDER BY kolejnosc, id').all(id);

// Twarde dowiązanie jest niepodzielne; system plików bez dowiązań (SMB, część montowań Dockera) dostaje kopię,
// która tak samo odmawia nadpisania (EEXIST).
function publikuj(zrodlo, cel) {
  try {
    linkSync(zrodlo, cel);
  } catch (e) {
    if (!['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS'].includes(e.code)) throw e;
    copyFileSync(zrodlo, cel, constants.COPYFILE_EXCL);
  }
}
// Co dzieje się z ofertą po usunięciu zdjęcia z karty: pętle ofert wysyłają treść z bieżącej galerii karty,
// więc oferta zarządzana traci zdjęcie przy najbliższej aktualizacji treści, a obserwowana i sklep nie.
const SKUTEK_USUNIECIA_W_KANALE =
  'W ofercie zarządzanej z OMS zdjęcie zniknie przy następnym przebiegu pętli ofert (chyba że treść jest ' +
  'zamrożona albo czeka). Oferty obserwowane i sklep Woo bez zmian.';

// `wyslane_at` stawiają tylko dwie drogi: wgranie na konto Allegro (wiersz w `zdjecia_kart_allegro`) i treść
// wysłana do ERLI (zdjęcie razem z całą galerią karty). Konta ERLI nie zapisujemy przy zdjęciu, dlatego
// bierzemy oferty ERLI karty, które dostały już treść. Wysłane zdjęcie bez śladu konta i tak ostrzega.
function kanalyZdjec(db, kartaId, lista, definicje) {
  if (!lista.some((z) => z.wyslane_at)) return new Map();
  const nazwa = (klucz) => adresKanalu(klucz, definicje);
  const allegro = db
    .prepare(
      `SELECT a.zdjecie_id, a.konto FROM zdjecia_kart_allegro a JOIN zdjecia_kart z ON z.id = a.zdjecie_id
      WHERE z.karta_id = ? ORDER BY a.konto`,
    )
    .all(kartaId);
  const erli = db
    .prepare('SELECT kanal FROM oferty_kanalow WHERE karta_id = ? AND wyslany_skrot IS NOT NULL ORDER BY id')
    .all(kartaId)
    .filter((o) => rodzajKanalu(o.kanal, definicje)?.klucz === 'erli')
    .map((o) => nazwa(o.kanal));
  const wynik = new Map();
  for (const z of lista) {
    if (!z.wyslane_at) continue;
    const kanaly = [...new Set([...allegro.filter((a) => a.zdjecie_id === z.id).map((a) => nazwa(a.konto)), ...erli])];
    wynik.set(z.id, kanaly.length ? kanaly : ['kanału']);
  }
  return wynik;
}
const uwagaUsuwania = (kanaly) =>
  kanaly.length
    ? `Zdjęcie jest w ${kanaly.length > 1 ? 'ofertach' : 'ofercie'} ${kanaly.join(', ')} — zniknie z karty. ` +
      SKUTEK_USUNIECIA_W_KANALE
    : null;

// `adres` to oryginał (plik zapisany bez przeskalowania albo adres źródłowy), więc nadaje się do powiększenia.
export function daneGalerii(db, kartaId, definicje = []) {
  const lista = zdjecia(db, kartaId);
  const wKanalach = kanalyZdjec(db, kartaId, lista, definicje);
  return lista.map((z) => ({
    ...z,
    kanaly: wKanalach.get(z.id) ?? [],
    uwagaUsuwania: uwagaUsuwania(wKanalach.get(z.id) ?? []),
    adres: z.plik
      ? `/magazyn/zdjecia/${encodeURIComponent(z.plik)}`
      : typeof z.adres_zrodlowy === 'string' && /^https?:\/\//i.test(z.adres_zrodlowy)
        ? z.adres_zrodlowy
        : null,
    etykieta: z.zrodlo.startsWith('allegro:')
      ? 'z Allegro'
      : z.zrodlo.startsWith('woo:')
        ? 'ze sklepu'
        : z.zrodlo === 'api'
          ? 'przez API'
          : 'wgrane',
  }));
}
function oznaczReczne(db, id) {
  db.prepare(
    `INSERT INTO karty_zrodla_pol (karta_id, pole, zrodlo, reczne, zmieniono_at)
    VALUES (?, 'zdjecia', 'reczne', 1, ?) ON CONFLICT (karta_id, pole) DO UPDATE SET
    zrodlo = 'reczne', reczne = 1, zmieniono_at = excluded.zmieniono_at`,
  ).run(id, new Date().toISOString());
}
function transakcja(db, wykonaj) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const wynik = wykonaj();
    db.exec('COMMIT');
    return wynik;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const blad = (tekst) => Object.assign(new Error(tekst), { odmowa: true });
const limit = (plik) => blad(`${plik}: Karta może mieć najwyżej 20 zdjęć. Usuń zdjęcie, aby wgrać kolejne.`);
const bladDanychZdjecia = (e) => /^(Niedozwolon|Limit zdjęcia)/.test(e.message);

// Wspólny zapis galerii. Edycja karty odrzuca całą paczkę przy błędzie, nowa karta przyjmuje poprawne zdjęcia.
export async function wgrajZdjecia(db, kartaId, katalog, pliki, { aiPaczki, pominUszkodzone = false } = {}) {
  let roboczy;
  const paczka = [];
  const odrzucone = [];
  const utworzone = [];
  try {
    for await (const { bufor, nazwa, ai, indeks } of pliki) {
      if (!roboczy) {
        await mkdir(katalog, { recursive: true });
        roboczy = await mkdtemp(join(katalog, '.paczka-'));
      }
      try {
        const z = await zapiszZdjecie(bufor, { katalog: roboczy });
        if (!paczka.some((p) => p.sha256 === z.sha256)) paczka.push({ ...z, nazwa, ai, indeks });
      } catch (e) {
        if (!pominUszkodzone || !bladDanychZdjecia(e)) throw e;
        odrzucone.push({ nazwa, powod: e.message });
      }
    }
    if (!paczka.length) {
      if (odrzucone.length) return odrzucone;
      throw blad('Wybierz plik zdjęcia.');
    }
    const nowe = (lista) => paczka.filter((p) => !lista.some((z) => z.sha256 === p.sha256));
    const sprawdzLimit = (lista, pliki) => {
      if (lista.length + pliki.length > 20) throw limit(pliki[Math.max(0, 20 - lista.length)].nazwa);
    };
    const listaPrzed = zdjecia(db, kartaId);
    sprawdzLimit(listaPrzed, nowe(listaPrzed));
    // Po asynchronicznym przygotowaniu ponownie liczymy w transakcji.
    // Publikacja plików jest synchroniczna: nie oddajemy sterowania między nią a COMMIT.
    transakcja(db, () => {
      const lista = zdjecia(db, kartaId),
        pliki = nowe(lista);
      sprawdzLimit(lista, pliki);
      let n = lista.reduce((max, z) => Math.max(max, z.kolejnosc + 1), 0);
      for (const z of pliki) {
        const cel = join(katalog, z.plik);
        try {
          publikuj(join(roboczy, z.plik), cel);
          utworzone.push(cel);
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
        }
        db.prepare(
          `INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, plik, sha256, typ, rozmiar, szerokosc, wysokosc, utworzono_at, ai, ai_reczne)
          VALUES (?, ?, 'reczne', ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        ).run(
          kartaId,
          n++,
          z.plik,
          z.sha256,
          z.typ,
          z.rozmiar,
          z.szerokosc,
          z.wysokosc,
          new Date().toISOString(),
          z.ai ?? aiPaczki(z.indeks),
        );
      }
      if (pliki.length) oznaczReczne(db, kartaId);
    });
    return odrzucone;
  } catch (e) {
    for (const cel of utworzone) {
      try {
        unlinkSync(cel);
      } catch {
        /* sprzątanie nie zasłania błędu */
      }
    }
    throw e;
  } finally {
    if (roboczy) await rm(roboczy, { recursive: true, force: true });
  }
}

// CSRF i uprawnienie magazyn zapewniają wspólne haki panelu, także w zakresie multipart.
export function registerGaleriaMagazynu(app, { db, katalog }) {
  const odmowa = (req, reply, kod, tekst) =>
    stronaOdmowy(reply, kod, tekst, {
      tytul: 'Nie zmieniono zdjęć',
      wroc: `/magazyn/${encodeURIComponent(req.params.id)}#zdjecia-karty`,
      napisWroc: 'Wróć do zdjęć',
    });
  const powrot = (req, reply) =>
    reply.code(303).redirect(`/magazyn/${encodeURIComponent(req.params.id)}#zdjecia-karty`);
  const kartaIstnieje = (id) => Boolean(db.prepare('SELECT id FROM karty_produktow WHERE id = ?').get(id));
  const znajdzZdjecie = (kartaId, zdjecieId) =>
    db.prepare('SELECT * FROM zdjecia_kart WHERE id = ? AND karta_id = ?').get(zdjecieId, kartaId);

  // Skrypt galerii prosi o JSON, żeby zapisać zmianę bez przeładowania; formularz bez skryptu dostaje stronę.
  const chceJson = (req) => String(req.headers.accept ?? '').includes('application/json');
  const odmowaGalerii = (req, reply, kod, tekst) =>
    chceJson(req) ? reply.code(kod).send({ blad: tekst }) : odmowa(req, reply, kod, tekst);
  const zmienionaKolejnosc = (req, reply) =>
    chceJson(req)
      ? reply.code(200).send({ kolejnosc: zdjecia(db, req.params.id).map((z) => z.id) })
      : powrot(req, reply);
  const ustawKolejnosc = (kartaId, lista) => {
    // Normalizacja rozstrzyga też zastane remisy i luki w numeracji.
    lista.forEach((z, n) =>
      db.prepare('UPDATE zdjecia_kart SET kolejnosc = ? WHERE id = ? AND karta_id = ?').run(n, z.id, kartaId),
    );
    oznaczReczne(db, kartaId);
  };
  const ZMIENIONA_GALERIA = 'Galeria zmieniła się — odśwież stronę.';

  app.post('/magazyn/:id/zdjecia/kolejnosc', async (req, reply) => {
    const { zdjecieId, kierunek, kolejnosc } = req.body ?? {};
    if (kolejnosc !== undefined) {
      if (!kartaIstnieje(req.params.id)) return odmowaGalerii(req, reply, 404, 'Nie ma takiej karty produktu.');
      const ids = (Array.isArray(kolejnosc) ? kolejnosc : [kolejnosc]).map(String);
      // Przyjmujemy tylko permutację bieżącej galerii: lista zbudowana na starym widoku (zdjęcie dodane albo
      // usunięte w innej karcie przeglądarki) mogłaby zgubić zdjęcie z kolejności albo wciągnąć cudze.
      const zgodna = transakcja(db, () => {
        const lista = zdjecia(db, req.params.id);
        const poId = new Map(lista.map((z) => [String(z.id), z]));
        if (ids.length !== lista.length || new Set(ids).size !== ids.length || !ids.every((id) => poId.has(id)))
          return false;
        if (ids.some((id, n) => String(lista[n].id) !== id))
          ustawKolejnosc(
            req.params.id,
            ids.map((id) => poId.get(id)),
          );
        return true;
      });
      if (!zgodna) return odmowaGalerii(req, reply, 409, ZMIENIONA_GALERIA);
      return zmienionaKolejnosc(req, reply);
    }
    if (!znajdzZdjecie(req.params.id, zdjecieId ?? null))
      return odmowaGalerii(req, reply, 404, 'Nie ma takiego zdjęcia na tej karcie.');
    if (!['lewo', 'prawo'].includes(kierunek))
      return odmowaGalerii(req, reply, 400, 'Wybierz przesunięcie w lewo albo w prawo.');
    transakcja(db, () => {
      const lista = zdjecia(db, req.params.id);
      const i = lista.findIndex((z) => String(z.id) === String(zdjecieId));
      const j = i + (kierunek === 'lewo' ? -1 : 1);
      if (i < 0 || j < 0 || j >= lista.length) return;
      [lista[i], lista[j]] = [lista[j], lista[i]];
      ustawKolejnosc(req.params.id, lista);
    });
    return zmienionaKolejnosc(req, reply);
  });
  app.post('/magazyn/:id/zdjecia/:zdjecieId/usun', async (req, reply) => {
    if (!znajdzZdjecie(req.params.id, req.params.zdjecieId))
      return odmowa(req, reply, 404, 'Nie ma takiego zdjęcia na tej karcie.');
    transakcja(db, () => {
      db.prepare('DELETE FROM zdjecia_kart WHERE id = ? AND karta_id = ?').run(req.params.zdjecieId, req.params.id);
      oznaczReczne(db, req.params.id);
    });
    return powrot(req, reply);
  });
  app.post('/magazyn/:id/zdjecia/:zdjecieId/ai', async (req, reply) => {
    const z = znajdzZdjecie(req.params.id, req.params.zdjecieId);
    if (!z) return odmowaGalerii(req, reply, 404, 'Nie ma takiego zdjęcia na tej karcie.');
    if (z.wyslane_at)
      return odmowaGalerii(req, reply, 409, 'Nie można zmienić znacznika AI zdjęcia wysłanego do kanału.');
    const wartosc = req.body?.ai;
    if (wartosc !== undefined && wartosc !== '1')
      return odmowaGalerii(req, reply, 400, 'Wybierz poprawny znacznik AI zdjęcia.');
    const ai = wartosc === '1' ? 1 : 0;
    ustawZnacznikAi(db, { kartaId: req.params.id, zdjecieId: req.params.zdjecieId, ai });
    return chceJson(req) ? reply.code(200).send({ id: z.id, ai }) : powrot(req, reply);
  });
  app.register(async (scoped) => {
    // Jedno dodatkowe miejsce (plik i jego znacznik) pozwala nazwać plik przekraczający limit 20.
    // Pola: `ai` dla całej paczki i `zdjecie_ai_<i>` przy i-tym pliku; CSRF sprawdzany jest przez Origin/Referer.
    await scoped.register(multipart, { limits: { files: 21, fileSize: LIMIT + 1, fields: 22, parts: 43 } });
    scoped.post('/magazyn/:id/zdjecia/wgraj', async (req, reply) => {
      if (!kartaIstnieje(req.params.id)) return odmowa(req, reply, 404, 'Nie ma takiej karty produktu.');
      let ai = 0,
        nazwa = '',
        odpowiedz;
      const aiPliku = new Map();
      async function* pliki() {
        let ilePlikow = 0;
        for await (const part of req.parts()) {
          if (part.type === 'field') {
            const indeks = /^zdjecie_ai_(\d{1,2})$/.exec(part.fieldname)?.[1];
            if ((part.fieldname !== 'ai' && !(Number(indeks) <= 20)) || !['0', '1'].includes(part.value))
              throw blad('Wybierz poprawny znacznik AI zdjęcia.');
            if (indeks === undefined) ai = part.value === '1' ? 1 : 0;
            else aiPliku.set(Number(indeks), part.value === '1' ? 1 : 0);
            continue;
          }
          nazwa = part.filename || 'Zdjęcie';
          if (part.type !== 'file' || part.fieldname !== 'zdjecie')
            throw blad(`${nazwa}: Wybierz pliki zdjęć w polu zdjecie.`);
          if (++ilePlikow > 20) throw limit(nazwa);
          const bufor = await part.toBuffer();
          if (part.file.truncated || bufor.length > LIMIT) throw blad(`${nazwa}: Limit zdjęcia: 10 MB.`);
          yield { bufor, nazwa, indeks: ilePlikow - 1 };
        }
      }
      try {
        await wgrajZdjecia(db, req.params.id, katalog, pliki(), { aiPaczki: (indeks) => aiPliku.get(indeks) ?? ai });
      } catch (e) {
        const zNazwa = (m) => (nazwa ? `${nazwa}: ${m}` : m);
        if (e.odmowa) odpowiedz = [400, e.message];
        else if (e.code === 'FST_REQ_FILE_TOO_LARGE') odpowiedz = [400, zNazwa('Limit zdjęcia: 10 MB.')];
        else if (bladDanychZdjecia(e)) odpowiedz = [400, zNazwa(e.message)];
        else if (e.code?.startsWith('FST_')) odpowiedz = [400, zNazwa('Wybierz pliki JPEG, PNG lub WebP.')];
        else {
          req.log.error({ err: e }, 'Nie udało się zapisać zdjęcia karty.');
          odpowiedz = [500, 'Nie udało się zapisać zdjęcia. Spróbuj ponownie.'];
        }
      }
      if (odpowiedz) return odmowa(req, reply, ...odpowiedz);
      return powrot(req, reply);
    });
  });
}
