// Magazyn → Cenniki — cenniki dostaw OMS (rozmiar, domyślny, tylko na karcie) z powiązaniami do cenników kont
// Allegro i ERLI oraz pobieranie list cenników z kont. Reguły i odmowy zapisu są w warstwie bazy
// (oms/db/cenniki-oms-zapis.ts); trasa czyta formularz, pilnuje, by nowy cennik kanału pochodził z pobranej listy
// konta, i zamienia odmowy na statusy HTTP.
//
// Uprawnienie, podgląd demo i ochrona przed CSRF przychodzą ze wspólnych haków: strażnik mapuje `/magazyn/cenniki`
// na uprawnienie „ustawienia” (tak jak Magazyn → Ustawienia), a hak demo blokuje POST gościa.
import { cennikiOms } from '../../oms/db/cenniki-oms.ts';
import { kartyCennikaOms, usunCennikOms, zapiszCennikOms } from '../../oms/db/cenniki-oms-zapis.ts';
import { ustawieniaOfertKonta } from '../../oms/db/oferty-kanalow.ts';
import { createOfertyAllegroUstawienia } from '../kanaly/services/oferty-allegro-ustawienia.ts';
import { cennikiAllegro } from './oferty.js';
import { adresKanalu } from '../../domena/kanaly.js';
import {
  centymetryZMilimetrow,
  gramyZKilogramow,
  kilogramyZGramow,
  milimetryZCentymetrow,
} from '../../domena/rozmiar.js';
import { stronaOdmowy } from '../../core/web/odmowa.js';

const ADRES = '/magazyn/cenniki';
const RODZAJE = ['rozmiar', 'domyslny', 'karta'];
// Powyżej tylu nazw lista cenników konta jest zwinięta — długie listy kurierów zasłaniałyby tabelę.
const ZWIN_OD = 5;

const KOMUNIKATY = {
  dodano: 'Cennik dodany.',
  zmieniono: 'Cennik zapisany.',
  usunieto: 'Cennik usunięty.',
};

const DATA = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', dateStyle: 'short', timeStyle: 'short' });
const data = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && Number.isFinite(d.getTime()) ? DATA.format(d) : null;
};
const przecinek = (s) => String(s).replace('.', ',');
const tekst = (w) => (typeof w === 'string' ? w : '');
const naKartach = (n) => (n === 1 ? 'na 1 karcie' : `na ${n} kartach`);
const cennikow = (n) =>
  n === 1
    ? '1 cennik'
    : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)
      ? `${n} cenniki`
      : `${n} cenników`;

/** „do 64 × 38 × 8 cm, 25 kg” / „domyślny — …” / „tylko na karcie” — kolumna Rozmiar. */
export function opisRozmiaru(c) {
  if (c.rodzaj === 'domyslny') return 'domyślny — produkty większe od cenników rozmiaru';
  if (c.rodzaj !== 'rozmiar' || !c.doMm) return 'tylko na karcie';
  const cm = c.doMm.map((mm) => przecinek(centymetryZMilimetrow(mm)));
  return `do ${cm.join(' × ')} cm, ${przecinek(kilogramyZGramow(c.doG))} kg`;
}

/** Ustawienia jawne konta ERLI (bez sekretów) — lista cenników i data ich pobrania. */
function cennikiKontaErli(db, klucz) {
  try {
    const w = db
      .prepare('SELECT ustawienia_json FROM konfiguracja_integracji WHERE integracja = ?')
      .get(`erli:${klucz}`);
    const u = JSON.parse(w?.ustawienia_json ?? '{}') ?? {};
    return {
      lista: Array.isArray(u.cennikiDostaw) ? u.cennikiDostaw.filter((n) => typeof n === 'string') : null,
      pobranoAt: typeof u.cennikiPobranoAt === 'string' ? u.cennikiPobranoAt : null,
    };
  } catch {
    return { lista: null, pobranoAt: null };
  }
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{ db: import('node:sqlite').DatabaseSync, kontaAllegro: () => any[], kontaErli: () => any[],
 *   definicje: () => readonly { klucz: string, etykieta?: string }[], sklepyErli: () => any, teraz: () => Date }} o
 */
export function registerCennikowOmsRoutes(app, o) {
  const { db } = o;
  const aktor = (req) => ({ id: req.konto?.id ?? 0, login: req.konto?.login ?? 'serwis' });

  /** Bieżące konta Allegro i ERLI z listą cenników (`null` = lista niepobrana) i stanem przycisku pobrania. */
  function kontaEkranu() {
    const definicje = o.definicje();
    const allegro = o.kontaAllegro().map((k) => {
      const slowniki = ustawieniaOfertKonta(db, k.klucz)?.slowniki ?? null;
      const pobrana = Array.isArray(slowniki?.cenniki);
      return {
        klucz: k.klucz,
        rodzaj: 'allegro',
        nazwaKanalu: 'Allegro',
        etykieta: `Allegro · ${adresKanalu(k.klucz, definicje)}`,
        lista: pobrana
          ? cennikiAllegro({ slowniki }).map((p) => ({ wartosc: p.id, nazwa: tekst(p.nazwa) || p.id }))
          : null,
        pobranoAt: pobrana ? data(slowniki.pobranoAt) : null,
        przycisk: 'Pobierz cenniki z Allegro',
        zablokowane: null,
      };
    });
    const sklepy = o.sklepyErli();
    const erli = o.kontaErli().map((k) => {
      const { lista, pobranoAt } = cennikiKontaErli(db, k.klucz);
      const stan = sklepy?.pobierz(k.klucz) ?? null;
      const gotowe =
        stan &&
        stan.zrodlo !== 'env' &&
        stan.ustawienia?.sprawdzono === true &&
        !stan.ustawienia?.kolizja &&
        stan.kluczZapisany === true;
      return {
        klucz: k.klucz,
        rodzaj: 'erli',
        nazwaKanalu: 'ERLI',
        etykieta: `ERLI · ${adresKanalu(k.klucz, definicje)}`,
        lista: lista ? lista.map((n) => ({ wartosc: n, nazwa: n })) : null,
        pobranoAt: data(pobranoAt),
        przycisk: 'Pobierz cenniki z ERLI',
        wersja: stan?.wersja ?? null,
        zablokowane: gotowe
          ? null
          : {
              napis:
                stan?.zrodlo === 'env'
                  ? 'Konto jest ustawione w pliku konfiguracji — cenniki pobiera się tam, gdzie je ustawiono.'
                  : 'Najpierw sprawdź połączenie konta ERLI.',
              adres: stan?.zrodlo === 'env' ? null : `/ustawienia/integracje/erli/${k.klucz}#erli-krok-dane`,
            },
      };
    });
    return [...allegro, ...erli];
  }

  /** Wiersz tabeli: komórka na każde bieżące konto (powiązanie z nazwą z listy albo oznaczeniem „nie ma już”). */
  function wierszListy(c, konta) {
    const powiazania = new Map(c.powiazania.map((p) => [p.konto, p.cennikKanalu]));
    return {
      ...c,
      opis: opisRozmiaru(c),
      kolumny: konta.map((k) => {
        const wartosc = powiazania.get(k.klucz) ?? null;
        if (!wartosc) return { nazwa: null };
        const z = k.lista?.find((p) => p.wartosc === wartosc);
        return { nazwa: z ? z.nazwa : wartosc, brak: Boolean(k.lista && !z), kanal: k.nazwaKanalu };
      }),
    };
  }

  function lista(req, reply, { status = 200, blad = null } = {}) {
    const konta = kontaEkranu();
    const cenniki = cennikiOms(db).map((c) => wierszListy(c, konta));
    const pobranoKonto = konta.find((k) => k.klucz === req.query?.pobrano);
    const pobrano = pobranoKonto
      ? `Pobrano cenniki konta ${pobranoKonto.etykieta}` +
        (pobranoKonto.lista ? ` — na liście ${cennikow(pobranoKonto.lista.length)}.` : '.')
      : null;
    return reply.code(status).view('magazyn-cenniki.ejs', {
      title: 'Cenniki',
      cenniki,
      konta,
      zapisano: KOMUNIKATY[req.query?.zapisano] ?? pobrano,
      blad,
      zwinOd: ZWIN_OD,
      adres: ADRES,
    });
  }

  /** Pola formularza z zapisanego cennika albo z ciała żądania — do ponownego pokazania po odmowie. */
  function polaZCennika(c, konta) {
    const cm = (i) => (c?.doMm ? przecinek(centymetryZMilimetrow(c.doMm[i]) ?? '') : '');
    const powiazania = new Map((c?.powiazania ?? []).map((p) => [p.konto, p.cennikKanalu]));
    return {
      nazwa: c?.nazwa ?? '',
      rodzaj: c?.rodzaj ?? '',
      a_cm: cm(0),
      b_cm: cm(1),
      c_cm: cm(2),
      waga_kg: c?.doG ? przecinek(kilogramyZGramow(c.doG) ?? '') : '',
      powiazania: Object.fromEntries(konta.map((k) => [k.klucz, powiazania.get(k.klucz) ?? ''])),
    };
  }
  function polaZBody(b, konta, dawne) {
    return {
      nazwa: tekst(b.nazwa),
      rodzaj: tekst(b.rodzaj),
      a_cm: tekst(b.a_cm),
      b_cm: tekst(b.b_cm),
      c_cm: tekst(b.c_cm),
      waga_kg: tekst(b.waga_kg),
      powiazania: Object.fromEntries(
        konta.map((k) => {
          const pole = b[`powiazanie:${k.klucz}`];
          return [k.klucz, pole === undefined ? (dawne.get(k.klucz) ?? '') : tekst(pole).trim()];
        }),
      ),
    };
  }

  const formularz = (reply, { status = 200, cennik = null, pola, konta, blad = null }) =>
    reply.code(status).view('magazyn-cennik.ejs', {
      title: cennik ? `Cennik „${cennik.nazwa}”` : 'Nowy cennik',
      cennik,
      pola,
      konta,
      dawne: new Map((cennik?.powiazania ?? []).map((p) => [p.konto, p.cennikKanalu])),
      blad,
      adres: ADRES,
    });

  const brak = (reply) =>
    stronaOdmowy(reply, 404, 'Nie ma takiego cennika — mógł zostać usunięty.', {
      tytul: 'Cenniki',
      wroc: ADRES,
      napisWroc: 'Wróć do cenników',
    });
  const cennikPoId = (id) => {
    const n = Number(id);
    return Number.isSafeInteger(n) && n > 0 ? (cennikiOms(db).find((c) => c.id === n) ?? null) : null;
  };

  /** Zapis z formularza: nowy cennik kanału musi być z pobranej listy konta; zapisany spoza listy może zostać. */
  function zapisz(req, reply, cennik) {
    const konta = kontaEkranu();
    const dawne = new Map((cennik?.powiazania ?? []).map((p) => [p.konto, p.cennikKanalu]));
    const b = req.body ?? {};
    const pola = polaZBody(b, konta, dawne);
    const odmowa = (blad) => formularz(reply, { status: 400, cennik, pola, konta, blad });
    for (const k of konta) {
      const w = pola.powiazania[k.klucz];
      if (w && k.lista && w !== dawne.get(k.klucz) && !k.lista.some((p) => p.wartosc === w))
        return odmowa(`Wybierz cennik z listy konta ${k.etykieta} albo „— brak powiązania —”.`);
      // Allegro przyjmuje w ofercie identyfikator cennika, więc bez pobranej listy nie ma czego bezpiecznie wpisać.
      if (w && !k.lista && k.rodzaj === 'allegro' && w !== dawne.get(k.klucz))
        return odmowa(`Pobierz najpierw listę cenników konta ${k.etykieta}.`);
    }
    const rozmiar = pola.rodzaj === 'rozmiar';
    const wynik = zapiszCennikOms(
      db,
      {
        id: cennik?.id ?? null,
        nazwa: pola.nazwa,
        rodzaj: RODZAJE.includes(pola.rodzaj) ? pola.rodzaj : /** @type {any} */ (''),
        doMm: rozmiar ? [pola.a_cm, pola.b_cm, pola.c_cm].map((t) => milimetryZCentymetrow(t)?.mm ?? null) : null,
        doG: rozmiar ? (gramyZKilogramow(pola.waga_kg)?.g ?? null) : null,
        powiazania: konta.map((k) => ({ konto: k.klucz, cennikKanalu: pola.powiazania[k.klucz] })),
      },
      { teraz: o.teraz().toISOString(), aktor: req.konto?.login ?? null },
    );
    if (!wynik.ok) return odmowa(wynik.blad);
    return reply.code(303).redirect(`${ADRES}?zapisano=${cennik ? 'zmieniono' : 'dodano'}`);
  }

  app.get(ADRES, async (req, reply) => lista(req, reply));

  app.get(`${ADRES}/nowy`, async (_req, reply) => {
    const konta = kontaEkranu();
    return formularz(reply, { pola: polaZCennika(null, konta), konta });
  });

  app.post(ADRES, async (req, reply) => zapisz(req, reply, null));

  app.get(`${ADRES}/:id`, async (req, reply) => {
    const cennik = cennikPoId(req.params.id);
    if (!cennik) return brak(reply);
    const konta = kontaEkranu();
    return formularz(reply, { cennik, pola: polaZCennika(cennik, konta), konta });
  });

  app.post(`${ADRES}/:id`, async (req, reply) => {
    const cennik = cennikPoId(req.params.id);
    if (!cennik) return brak(reply);
    return zapisz(req, reply, cennik);
  });

  // Potwierdzenie na osobnym ekranie, nie `confirm()` — działa bez JS i mówi, co usunięcie zmieni na kontach.
  function ekranUsun(reply, cennik, status = 200) {
    const karty = kartyCennikaOms(db, cennik.id);
    let ostrzezenie = null;
    if (cennik.rodzaj === 'domyslny') {
      const wszystkie = cennikiOms(db);
      const kontaRozmiaru = new Set(
        wszystkie.filter((c) => c.rodzaj === 'rozmiar').flatMap((c) => c.powiazania.map((p) => p.konto)),
      );
      const dotkniete = kontaEkranu().filter((k) => kontaRozmiaru.has(k.klucz));
      if (dotkniete.length)
        ostrzezenie = `Produkty większe od cenników rozmiaru dostaną odmowę na kontach: ${dotkniete
          .map((k) => k.etykieta)
          .join(', ')}.`;
    }
    return reply.code(status).view('magazyn-cennik-usun.ejs', {
      title: 'Usunąć cennik?',
      cennik,
      karty,
      odmowa: karty.length ? `Cennik jest wybrany ${naKartach(karty.length)} — zmień je najpierw.` : null,
      ostrzezenie,
      adres: ADRES,
    });
  }

  app.get(`${ADRES}/:id/usun`, async (req, reply) => {
    const cennik = cennikPoId(req.params.id);
    if (!cennik) return brak(reply);
    return ekranUsun(reply, cennik);
  });

  app.post(`${ADRES}/:id/usun`, async (req, reply) => {
    const cennik = cennikPoId(req.params.id);
    if (!cennik) return brak(reply);
    const wynik = usunCennikOms(db, cennik.id);
    if (!wynik.ok) return ekranUsun(reply, cennik, 409);
    return reply.code(303).redirect(`${ADRES}?zapisano=usunieto`);
  });

  // Pobranie listy to odczyt z kanału — dozwolone także przy koncie w trybie „tylko odczyt”.
  app.post(`${ADRES}/kanal/:klucz/pobierz`, async (req, reply) => {
    const klucz = String(req.params.klucz ?? '');
    const konto = kontaEkranu().find((k) => k.klucz === klucz);
    if (!konto)
      return stronaOdmowy(reply, 404, 'Nie ma takiego konta Allegro ani ERLI.', {
        tytul: 'Cenniki',
        wroc: ADRES,
        napisWroc: 'Wróć do cenników',
      });
    let wynik;
    if (konto.rodzaj === 'erli') {
      const sklepy = o.sklepyErli();
      wynik = sklepy
        ? await sklepy.operacja(klucz, 'pobierz-cenniki', { wersja: req.body?.wersja }, aktor(req))
        : { ok: false, status: 409, komunikat: 'Moduł kanałów nie obsługuje teraz kont ERLI.' };
    } else {
      wynik = await createOfertyAllegroUstawienia({
        db,
        teraz: o.teraz,
        klient: (k) => o.kontaAllegro().find((x) => x.klucz === k)?.klient,
        zgoda: (k) => o.kontaAllegro().find((x) => x.klucz === k)?.zgoda ?? null,
      }).pobierzSlowniki(klucz, aktor(req));
    }
    if (!wynik.ok) return lista(req, reply, { status: wynik.status ?? 400, blad: wynik.komunikat });
    return reply.code(303).redirect(`${ADRES}?pobrano=${encodeURIComponent(klucz)}#kanal-${encodeURIComponent(klucz)}`);
  });
}
