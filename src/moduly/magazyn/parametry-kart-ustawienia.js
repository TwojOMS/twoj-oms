// Magazyn → Ustawienia → Parametry kart — definicje parametrów własnych (kolor, materiał, moc…).
// Reguły pól są w domenie, odmowy chroniące wartości kart w warstwie bazy (oms/db/parametry-kart.js); trasa tylko
// pokazuje, przekazuje formularz i zamienia kod odmowy na status HTTP.
//
// Uprawnienie, podgląd demo i ochrona przed CSRF (sprawdzenie Origin) przychodzą ze wspólnych haków:
// strażnik mapuje `/magazyn/ustawienia` na uprawnienie „ustawienia”, a hak demo blokuje POST gościa — nie powtarzamy ich tu.
import {
  dodajParametr,
  listaParametrow,
  parametrPoId,
  przesunParametr,
  usunParametr,
  zmienParametr,
} from '../../oms/db/parametry-kart.js';
import { stronaOdmowy } from '../../core/web/odmowa.js';

const ADRES = '/magazyn/ustawienia/parametry';
const SKROT_TYPU = 60;

// Odmowa, która chroni wartości zapisane na kartach, to konflikt ze stanem danych — formularz był poprawny.
const STATUS_ODMOWY = { NIE_MA: 404, NIEPOPRAWNE: 400, TYP_Z_WARTOSCIAMI: 409, WARTOSC_UZYWANA: 409 };

const KOMUNIKATY = {
  dodano: 'Dodano parametr.',
  zmieniono: 'Zapisano parametr.',
  usunieto: 'Usunięto parametr.',
};

/** Typ w tabeli: `liczba (W)`, `tekst`, `lista: czarny, biały, …` — najwyżej 60 znaków. */
export function opisTypu(p) {
  if (p.typ === 'liczba') return p.jednostka ? `liczba (${p.jednostka})` : 'liczba';
  if (p.typ !== 'lista') return p.typ;
  const pelny = `lista: ${(p.wartosci ?? []).join(', ')}`;
  const znaki = [...pelny];
  return znaki.length <= SKROT_TYPU
    ? pelny
    : `${znaki
        .slice(0, SKROT_TYPU - 1)
        .join('')
        .trimEnd()}…`;
}

// „na 1 karcie” / „z 2 kart” — miejscownik i dopełniacz liczby mnogiej mają po jednej formie.
const naKartach = (n) => (n === 1 ? 'na 1 karcie' : `na ${n} kartach`);
const zKart = (n) => (n === 1 ? 'z 1 karty' : `z ${n} kart`);

/** Pola formularza z ciała żądania (albo z zapisanej definicji) — do ponownego pokazania po odmowie. */
function polaFormularza(zrodlo) {
  const tekst = (w) => (typeof w === 'string' ? w : '');
  return {
    nazwa: tekst(zrodlo?.nazwa),
    typ: tekst(zrodlo?.typ),
    jednostka: tekst(zrodlo?.jednostka),
    wartosci: Array.isArray(zrodlo?.wartosci) ? zrodlo.wartosci.join('\n') : tekst(zrodlo?.wartosci),
    wymagany: zrodlo?.wymagany === true || ['1', 'on'].includes(zrodlo?.wymagany),
    wartosc_z: tekst(zrodlo?.wartosc_z),
    wartosc_na: tekst(zrodlo?.wartosc_na),
  };
}

const ktoZmienia = (req) => req.konto?.login ?? null;

export function registerParametrowKartRoutes(app, { db }) {
  const formularz = (req, reply, { status = 200, parametr = null, pola, blad = null }) =>
    reply.code(status).view('magazyn-parametr-kart.ejs', {
      title: parametr ? `Parametr „${parametr.nazwa}”` : 'Nowy parametr',
      parametr,
      pola,
      blad,
      adres: ADRES,
    });

  const brak = (reply) =>
    stronaOdmowy(reply, 404, 'Nie ma takiego parametru — mógł zostać usunięty.', {
      tytul: 'Parametry kart',
      wroc: ADRES,
      napisWroc: 'Wróć do parametrów kart',
    });

  app.get(ADRES, async (req, reply) => {
    const parametry = listaParametrow(db).map((p) => ({ ...p, opisTypu: opisTypu(p) }));
    const przepisane = Number(req.query?.przepisane);
    let zapisano = KOMUNIKATY[req.query?.zapisano] ?? null;
    if (zapisano && Number.isSafeInteger(przepisane) && przepisane > 0) {
      zapisano += ` Nowa nazwa wartości jest już ${naKartach(przepisane)}.`;
    }
    return reply.view('magazyn-parametry-kart.ejs', {
      title: 'Parametry kart',
      parametry,
      zapisano,
      adres: ADRES,
    });
  });

  app.get(`${ADRES}/nowy`, async (req, reply) => formularz(req, reply, { pola: polaFormularza(null) }));

  app.post(ADRES, async (req, reply) => {
    const wynik = dodajParametr(db, req.body ?? {});
    if (wynik.blad) {
      return formularz(req, reply, {
        status: STATUS_ODMOWY[wynik.kod] ?? 400,
        pola: polaFormularza(req.body),
        blad: wynik.blad,
      });
    }
    return reply.code(303).redirect(`${ADRES}?zapisano=dodano`);
  });

  app.get(`${ADRES}/:id`, async (req, reply) => {
    const parametr = parametrPoId(db, req.params.id);
    if (!parametr) return brak(reply);
    return formularz(req, reply, { parametr, pola: polaFormularza(parametr) });
  });

  app.post(`${ADRES}/:id`, async (req, reply) => {
    const parametr = parametrPoId(db, req.params.id);
    if (!parametr) return brak(reply);
    const wynik = zmienParametr(db, parametr.id, req.body ?? {}, { kto: ktoZmienia(req) });
    if (wynik.blad) {
      if (wynik.kod === 'NIE_MA') return brak(reply);
      return formularz(req, reply, {
        status: STATUS_ODMOWY[wynik.kod] ?? 400,
        parametr,
        pola: polaFormularza(req.body),
        blad: wynik.blad,
      });
    }
    const przepisane = wynik.przepisane > 0 ? `&przepisane=${wynik.przepisane}` : '';
    return reply.code(303).redirect(`${ADRES}?zapisano=zmieniono${przepisane}`);
  });

  app.post(`${ADRES}/:id/przesun`, async (req, reply) => {
    const wynik = przesunParametr(db, req.params.id, String(req.body?.kierunek ?? ''));
    if (wynik.blad) {
      if (wynik.kod === 'NIE_MA') return brak(reply);
      return stronaOdmowy(reply, 400, wynik.blad, {
        tytul: 'Nie udało się zmienić kolejności',
        wroc: ADRES,
        napisWroc: 'Wróć do parametrów kart',
      });
    }
    return reply.code(303).redirect(`${ADRES}#parametr-${Number(req.params.id)}`);
  });

  // Potwierdzenie na osobnym ekranie, nie `confirm()` — działa bez JS i mówi, ile kart straci wartość.
  app.get(`${ADRES}/:id/usun`, async (req, reply) => {
    const parametr = parametrPoId(db, req.params.id);
    if (!parametr) return brak(reply);
    const pytanie =
      `Usunąć „${parametr.nazwa}”?` + (parametr.karty > 0 ? ` Wartości znikną ${zKart(parametr.karty)}.` : '');
    return reply.view('magazyn-parametr-kart-usun.ejs', {
      title: 'Usunąć parametr?',
      parametr,
      pytanie,
      adres: ADRES,
    });
  });

  app.post(`${ADRES}/:id/usun`, async (req, reply) => {
    const wynik = usunParametr(db, req.params.id);
    if (wynik.blad) return brak(reply);
    return reply.code(303).redirect(`${ADRES}?zapisano=usunieto`);
  });
}
