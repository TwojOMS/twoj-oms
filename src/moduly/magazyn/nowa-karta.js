import multipart from '@fastify/multipart';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { utworzKarte } from '../../oms/db/magazyn.js';
import { STAWKI_VAT } from '../../domena/vat.js';
import { cenaSprzedazyZFormularza } from '../../domena/cena-sprzedazy.js';
import { wpisZFormularza } from '../../domena/cena-zakupu.js';
import { dzienWarszawa } from '../../domena/format-daty.js';
import { zl } from '../../domena/kwoty.js';
import { zapiszCeneZakupu } from '../../oms/db/ceny-zakupu.js';
import { polaSlownikowZFormularza } from './karta.js';
import { dopiszDoSlownikow, nazwySlownika } from './services/slowniki-kart.js';
import { daneOpisu, odczytajOpis, opisDoZapisu, walidujOpis, zmienSekcje } from './opis.js';
import { wgrajZdjecia } from './galeria.js';
import { LIMIT } from './services/zdjecia-pliki.js';
import { listaProducentow, przypisaniaMarek } from '../../oms/db/producenci.js';
import { producentKarty } from '../../domena/producenci.js';
import { markaZFormularza } from '../../domena/marka-karty.js';

const POLA = [
  'nazwa',
  'sku',
  'ean',
  'cena_zakupu_netto',
  'cena_netto_zl',
  'cena_zl',
  'stawka_vat',
  'marka',
  'marka_nowa',
  'kategoria_glowna',
  'kategoria_glowna_nowa',
];
const MAKS_ZDJEC = 20;
const TYPY_ZDJEC = ['image/jpeg', 'image/png', 'image/webp'];
const LIMIT_POL_BAJTY = 1024 * 1024;
// Dane karty, 200 sekcji opisu po maks. dwa elementy, liczniki, akcja i znaczniki zdjęć.
const MAKS_POL = POLA.length + 200 * (1 + 2 * 3) + 2 + MAKS_ZDJEC;
const pustyOpis = () => ({ sekcje: [{ elementy: [{ typ: 'tekst', html: '' }] }] });
const WYBIERZ_ZDJECIA = 'Jeśli dodano zdjęcia, wybierz ponownie pliki i zaznacz AI.';

/**
 * Producent nowej karty — tylko podgląd, bo producent wynika z marki i nie zapisuje się na karcie.
 * `dane` jadą do skryptu, który odświeża pole po wyborze marki; `stan` to pole bez JavaScriptu
 * (pierwszy ekran i powrót po błędzie), z tymi samymi tekstami co skrypt.
 */
function producentNowejKarty(db, wpisane) {
  const producenci = listaProducentow(db);
  const marki = {};
  for (const p of producenci) for (const marka of p.marki) marki[marka] = p.nazwa;
  const domyslny = producenci.find((p) => p.domyslny) ?? null;
  const dane = { marki, domyslny: domyslny?.nazwa ?? null };
  // Ta sama marka, którą zapisze POST: wpisana nowa wygrywa z wyborem z listy.
  const marka = markaZFormularza(wpisane).marka ?? '';
  if (!marka) return { dane, stan: { tekst: 'Wybierz markę — producent wynika z marki.', link: false } };
  const w = producentKarty({ karta: { marka }, przypisania: przypisaniaMarek(db), producenci, domyslny });
  const stan =
    w.zrodlo === 'marka'
      ? { tekst: `Producent: ${w.producent.nazwa} (z marki ${marka})`, link: false }
      : w.producent
        ? { tekst: `Producent: ${w.producent.nazwa} (producent domyślny)`, link: false }
        : { tekst: 'Marka bez producenta — ', link: true };
  return { dane, stan };
}

async function odczytajFormularz(req, pliki, katalogRoboczy) {
  if (!req.isMultipart()) return { body: req.body ?? {}, blad: null };
  const body = Object.create(null);
  let blad = null;
  let liczbaPlikow = 0;
  let rozmiarPol = 0;
  try {
    for await (const part of req.parts()) {
      if (part.type === 'field') {
        if (typeof part.value !== 'string') continue;
        rozmiarPol += Buffer.byteLength(part.fieldname) + Buffer.byteLength(part.value);
        if (part.valueTruncated || part.fieldnameTruncated || rozmiarPol > LIMIT_POL_BAJTY) {
          blad ??= 'Przekroczono limit długości pól formularza.';
          break;
        }
        body[part.fieldname] = part.value;
        continue;
      }
      const bufor = await part.toBuffer();
      if (part.fieldname === 'zdjecie' && !part.filename && !bufor.length) continue;
      const nazwa = part.filename || 'Zdjęcie';
      if (++liczbaPlikow > MAKS_ZDJEC) blad ??= `${nazwa}: Karta może mieć najwyżej 20 zdjęć.`;
      else if (part.file.truncated || bufor.length > LIMIT) blad ??= `${nazwa}: Limit zdjęcia: 10 MB.`;
      else if (part.fieldname !== 'zdjecie' || !dozwolonyTyp(part.mimetype, nazwa))
        blad ??= `${nazwa}: Wybierz plik JPEG, PNG lub WebP.`;
      else if (!blad) {
        const sciezka = join(await katalogRoboczy(), String(liczbaPlikow - 1));
        await writeFile(sciezka, bufor);
        pliki.push({ nazwa, sciezka });
      }
    }
  } catch (e) {
    if (e.code?.startsWith('FST_') || e.message === 'Unexpected end of multipart data')
      blad ??= 'Nie udało się odczytać formularza lub przekroczono limit przesyłania.';
    else throw e;
  }
  return { body, blad };
}

function dozwolonyTyp(typ, nazwa) {
  return TYPY_ZDJEC.includes(typ) || (typ === 'application/octet-stream' && /\.(jpe?g|png|webp)$/i.test(nazwa));
}

export function registerNowaKartaMagazynu(app, { db, pomoc, magazyn, katalog, komunikatyNowychKart }) {
  const formularz = (reply, { wpisane = {}, opis = pustyOpis(), blad = null, ponowZdjecia = false } = {}) =>
    reply.code(blad ? 400 : 200).view('magazyn-nowa-karta.ejs', {
      title: 'Nowy produkt',
      szerokosc: 'tabela',
      wpisane,
      blad,
      notatkaZdjec: blad || ponowZdjecia ? WYBIERZ_ZDJECIA : null,
      marki: nazwySlownika(db, 'marki'),
      kategorie: nazwySlownika(db, 'kategorie'),
      producent: producentNowejKarty(db, wpisane),
      opisKarty: daneOpisu(db, null, { opis }),
      stawkiVat: STAWKI_VAT,
      maksZdjec: MAKS_ZDJEC,
      limitZdjecia: LIMIT,
      typyZdjec: TYPY_ZDJEC.join(','),
    });
  // Jak lista i karta: magazyn niegotowy (brak sklepów) → nic nie zapisujemy, wracamy na listę.
  const niegotowy = (reply) => (magazyn?.gotowy?.() === false ? reply.redirect('/magazyn') : null);
  app.get('/magazyn/nowa-karta', async (_req, reply) => niegotowy(reply) ?? formularz(reply));
  // Rola magazyn i CSRF (Origin/Referer) są sprawdzane przez globalne haki panelu.
  async function utworz(req, reply, body, pliki, bladPlikow) {
    const wpisane = Object.fromEntries(POLA.map((pole) => [pole, typeof body[pole] === 'string' ? body[pole] : '']));
    let opis = pustyOpis();
    const pokaz = (blad = null, ponowZdjecia = false) => formularz(reply, { wpisane, opis, blad, ponowZdjecia });
    if (body.opis_liczba !== undefined || body.opis_sekcje_json !== undefined) {
      try {
        opis = odczytajOpis(body);
      } catch {
        return pokaz('Nieprawidłowy opis. Sprawdź listę sekcji i elementów.');
      }
    }
    if (bladPlikow) return pokaz(bladPlikow);
    const { czysty, blad: bladOpisu } = walidujOpis(opis, []);
    if (bladOpisu) return pokaz(bladOpisu);
    const akcja = body.akcja ?? 'zapisz';
    if (akcja === 'podglad' || (typeof akcja === 'string' && zmienSekcje(opis, akcja)))
      return pokaz(null, pliki.length > 0);
    if (akcja !== 'zapisz') return pokaz('Nieznana operacja edytora opisu.');
    // Netto i stawka to tylko wejście: zapisujemy brutto, tą samą funkcją, którą formularz liczy na żywo.
    const cena = cenaSprzedazyZFormularza({
      netto: wpisane.cena_netto_zl,
      brutto: wpisane.cena_zl,
      stawka: wpisane.stawka_vat,
    });
    if (cena.blad) return pokaz(cena.blad);
    // Dalej walidacja karty bez wyjątków — policzone brutto przechodzi tę samą drogę, co wpisane na karcie.
    const { cena_zakupu_netto: _zakup, cena_netto_zl: _netto, ...polaKarty } = wpisane;
    const { zmiany, blad } = pomoc.zmianyZFormularza(
      db,
      {},
      {
        ...polaKarty,
        cena_zl: cena.cena_gr === null ? '' : zl(cena.cena_gr),
      },
    );
    if (blad) return pokaz(blad);
    const at = new Date().toISOString();
    const zakup = wpisZFormularza({ cena_zakupu_netto: wpisane.cena_zakupu_netto }, dzienWarszawa(at));
    if (zakup.blad) return pokaz(zakup.blad);
    Object.assign(zmiany, polaSlownikowZFormularza(wpisane));
    const zapisOpisu = opisDoZapisu(czysty);
    if (zapisOpisu.sekcje.length) zmiany.opis_sekcje_json = JSON.stringify(zapisOpisu);
    // Tworzenie i oznaczenie wszystkich wpisanych pól są jedną operacją. Stan początkowy
    // wynika z braku ruchów magazynowych — formularz nigdy nie zapisuje stanu.
    db.exec('SAVEPOINT nowa_karta');
    let id;
    try {
      const wypelnione = Object.fromEntries(Object.entries(zmiany).filter(([, wartosc]) => wartosc !== null));
      id = utworzKarte(db, wypelnione, { zrodlo: 'reczne' });
      dopiszDoSlownikow(db, wypelnione, { at });
      // Cena zakupu „od dziś” w tej samej operacji: karta bez niej albo wpis bez karty to pół zapisu.
      if (zakup.wpis) zapiszCeneZakupu(db, id, zakup.wpis, { kto: req.konto?.login ?? null, zrodlo: 'karta', at });
      db.exec('RELEASE nowa_karta');
    } catch (error) {
      db.exec('ROLLBACK TO nowa_karta');
      db.exec('RELEASE nowa_karta');
      throw error;
    }
    if (!pliki.length) return reply.code(303).redirect(`/magazyn/${id}`);
    async function* doWgrania() {
      for (const [i, { nazwa, sciezka }] of pliki.entries())
        yield { nazwa, bufor: await readFile(sciezka), ai: body[`zdjecie_ai_${i}`] === '1' ? 1 : 0 };
    }
    let odrzucone;
    try {
      odrzucone = await wgrajZdjecia(db, id, katalog, doWgrania(), { pominUszkodzone: true });
    } catch (e) {
      req.log.error({ err: e }, 'Nie udało się zapisać zdjęć nowej karty.');
      odrzucone = pliki.map(({ nazwa }) => ({ nazwa, powod: 'Nie udało się zapisać zdjęcia. Spróbuj ponownie.' }));
    }
    if (!odrzucone.length) return reply.code(303).redirect(`/magazyn/${id}`);
    const szczegoly = odrzucone.map(({ nazwa, powod }) => `${nazwa} — ${powod}`).join(' ');
    const rzeczownik = odrzucone.length === 1 ? 'zdjęcia' : 'zdjęć';
    // Komunikat jest jednorazowy, a adres przekierowania krótki także dla 20 długich nazw plików.
    if (komunikatyNowychKart.size >= 100) komunikatyNowychKart.delete(komunikatyNowychKart.keys().next().value);
    komunikatyNowychKart.set(id, `Utworzono kartę; nie wgrałem ${odrzucone.length} ${rzeczownik}: ${szczegoly}`);
    return reply.code(303).redirect(`/magazyn/${id}?wynik=zdjecia`);
  }

  app.register(async (scoped) => {
    await scoped.register(multipart, {
      throwFileSizeLimit: false,
      limits: {
        files: MAKS_ZDJEC + 1,
        fileSize: LIMIT + 1,
        fieldSize: LIMIT_POL_BAJTY,
        fields: MAKS_POL,
        parts: MAKS_POL + MAKS_ZDJEC + 2,
      },
    });
    scoped.post('/magazyn/nowa-karta', async (req, reply) => {
      if (niegotowy(reply)) return reply;
      let roboczy;
      const pliki = [];
      try {
        const { body, blad } = await odczytajFormularz(req, pliki, async () => {
          roboczy ??= await mkdtemp(join(tmpdir(), 'oms-nowa-karta-'));
          return roboczy;
        });
        return await utworz(req, reply, body, pliki, blad);
      } finally {
        if (roboczy) await rm(roboczy, { recursive: true, force: true });
      }
    });
  });
}
