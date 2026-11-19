// Sekcja GPSR karty produktu: producent ze słownika OMS, producent Allegro na każdym koncie i informacja
// o bezpieczeństwie. Producent Allegro liczy się tą samą funkcją co oferta (`producentAllegro`) i z tych samych
// danych — karta, która pokazuje innego producenta niż ten, który pójdzie do Allegro, byłaby gorsza niż żadna.
// Model czyta wyłącznie bazę: ekran karty nie woła sieci.
import { kartaPoId, zapiszKarte } from '../../oms/db/magazyn.js';
import { ustawieniaOfertKonta } from '../../oms/db/oferty-kanalow.ts';
import { producentPoId, przypisaniaMarek } from '../../oms/db/producenci.js';
import { producentKarty, opisProducenta } from '../../domena/producenci.js';
import { producentAllegro } from '../../domena/producent-allegro.js';
import { LIMIT_INFORMACJI_BEZPIECZENSTWA } from '../../domena/allegro-oferta-z-karty.js';
import { stronaOdmowy } from '../../core/web/odmowa.js';
import { ofertaAllegroKarty } from './services/tresc-oferty-allegro.js';

const ADRES_SLOWNIKA = '/magazyn/producenci';
const KATALOG = 'Allegro weźmie producenta z produktu w katalogu';
const PO_EAN = 'jeśli Allegro dopasuje produkt po EAN, producenta weźmie z produktu';
const ODSWIEZ = 'odśwież listę producentów w kroku Oferty konta';

// Ten sam odczyt napisu co w treści oferty — inaczej marka „ X” na karcie i w ofercie byłyby dwiema markami.
const napis = (w) => (typeof w === 'string' ? w.trim() : w == null ? '' : String(w).trim());

/** JSON z kolumny: `null` dla pustej, `undefined` dla uszkodzonej (jak w treści oferty). */
function json(w) {
  if (w == null || w === '') return null;
  try {
    return JSON.parse(w);
  } catch {
    return undefined;
  }
}

function producentOms(db, karta) {
  const przypisania = przypisaniaMarek(db);
  const marka = napis(karta.marka);
  const idMarki = marka ? przypisania.get(marka) : undefined;
  const zMarki = idMarki == null ? null : producentPoId(db, idMarki);
  const idDomyslnego = db.prepare('SELECT id FROM producenci WHERE domyslny = 1').get()?.id;
  const domyslny = idDomyslnego == null ? null : producentPoId(db, idDomyslnego);
  const w = producentKarty({ karta, przypisania, producenci: zMarki ? [zMarki] : [], domyslny });
  return {
    nazwa: w.producent?.nazwa ?? null,
    opis: w.producent ? opisProducenta(w.producent) : null,
    zrodlo: w.zrodlo === 'brak' ? null : w.zrodlo,
    marka: w.marka ?? null,
    dopisek: w.dopisek ?? null,
    brak: w.brak ?? null,
    adresSlownika: ADRES_SLOWNIKA,
  };
}

function wierszAllegro(db, konto, marka, droga) {
  // Nazwa konta jak w treści oferty — tekst błędu na karcie ma być tym samym tekstem co przy wystawianiu.
  const nazwaKonta = napis(konto.nazwa) || napis(konto.klucz) || 'Allegro';
  const ustawienia = ustawieniaOfertKonta(db, konto.klucz);
  const w = marka
    ? db
        .prepare(
          `SELECT zrodlo, producent_id, osoba_odpowiedzialna_id FROM allegro_marki_gpsr WHERE konto = ? AND marka = ?`,
        )
        .get(konto.klucz, marka)
    : null;
  const przypisanie = w
    ? { marka, zrodlo: w.zrodlo, producentId: w.producent_id, osobaOdpowiedzialnaId: w.osoba_odpowiedzialna_id }
    : null;
  const wynik = producentAllegro({ marka, droga, przypisanie, ustawienia, nazwaKonta });
  const slowniki = ustawienia.slowniki ?? null;
  const producentId = wynik.responsibleProducer?.id ?? null;
  const nazwaZListy = (lista, id) => (lista ?? []).find((x) => napis(x?.id) === id)?.nazwa ?? null;
  const producentNazwa = producentId ? nazwaZListy(slowniki?.producenci, producentId) : null;
  const osobaId = wynik.responsiblePerson?.id ?? null;
  const dopiski = [];
  if (wynik.zrodlo === 'katalog') dopiski.push(KATALOG);
  // Przy drodze EAN Allegro może znaleźć produkt w katalogu — wtedy producent z przypisania nie liczy się;
  // dopisek tylko tam, gdzie przy produkcie z katalogu oferta nie wysłałaby własnego producenta.
  if (
    droga === 'ean' &&
    producentAllegro({ marka, droga: 'katalog-id', przypisanie, ustawienia, nazwaKonta }).zrodlo === 'katalog'
  )
    dopiski.push(PO_EAN);
  if (producentId && !producentNazwa) dopiski.push(ODSWIEZ);
  return {
    konto: konto.klucz,
    nazwaKonta,
    zrodlo: wynik.zrodlo,
    producentNazwa,
    producentId,
    osoba: osobaId ? { id: osobaId, nazwa: nazwaZListy(slowniki?.osoby, osobaId) } : null,
    blad: wynik.blad ?? null,
    dopisek: dopiski.length ? dopiski.join('; ') : null,
  };
}

function bezpieczenstwoKarty(db, karta, konta, gpsr) {
  const informacja = json(karta.informacja_bezpieczenstwa);
  const uszkodzona = informacja === undefined;
  const typ = informacja?.typ === 'TEXT' || informacja?.typ === 'ATTACHMENTS' ? informacja.typ : null;
  let zalaczniki = null;
  if (typ === 'ATTACHMENTS') {
    const klucz = napis(informacja.konto);
    const konto = konta.find((k) => k.klucz === klucz);
    zalaczniki = {
      konto: klucz,
      nazwaKonta: napis(konto?.nazwa) || klucz || 'Allegro',
      liczba: Array.isArray(informacja.zalaczniki) ? informacja.zalaczniki.length : 0,
    };
  }
  return {
    typ,
    tekst: typ === 'TEXT' ? napis(informacja.tekst) : '',
    zalaczniki,
    domyslneKont: konta.map((k) => ({
      nazwaKonta: napis(k.nazwa) || napis(k.klucz) || 'Allegro',
      tekst: napis(ustawieniaOfertKonta(db, k.klucz).bezpieczenstwoDomyslne),
    })),
    limit: LIMIT_INFORMACJI_BEZPIECZENSTWA,
    uszkodzona,
    // Po odmowie zapisu: komunikat i to, co człowiek wpisał — żeby nie stracił tekstu.
    blad: gpsr?.blad ?? null,
    wpisane: gpsr?.tekst ?? null,
  };
}

/**
 * Model sekcji GPSR karty.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Record<string, any>} karta wiersz `karty_produktow`
 * @param {() => readonly {klucz: string, nazwa?: string, srodowisko?: string}[]} kontaAllegro
 * @param {{blad?: string, tekst?: string}|null} [gpsr] stan po odmowie zapisu
 */
export function daneGpsrKarty(db, karta, kontaAllegro, gpsr = null) {
  const konta = kontaAllegro();
  const marka = napis(karta.marka);
  // Droga produktu (katalog, EAN, nowy) zależy od środowiska konta: import, mapa kategorii i pamięć opisów są
  // per środowisko — jedna droga dla wszystkich kont pokazałaby przy sandboksie producenta z produkcji.
  const drogi = new Map();
  const drogaKonta = (konto) => {
    const srodowisko = konto?.srodowisko === 'sandbox' ? 'sandbox' : 'produkcja';
    if (!drogi.has(srodowisko)) drogi.set(srodowisko, ofertaAllegroKarty(db, karta.id, null, { srodowisko }).droga);
    return drogi.get(srodowisko) ?? null;
  };
  return {
    producent: producentOms(db, karta),
    allegro: konta.map((k) => wierszAllegro(db, k, marka, drogaKonta(k))),
    bezpieczenstwo: bezpieczenstwoKarty(db, karta, konta, gpsr),
  };
}

/**
 * Tekst z formularza: przycięty, końce linii `\n` (Allegro liczy znaki, a `\r\n` liczyłby się podwójnie).
 * `null`, gdy pole nie jest napisem (np. powtórzone `tekst` daje tablicę) — wtedy nic nie zapisujemy.
 */
const tekstZFormularza = (body) => {
  const w = body && Object.hasOwn(body, 'tekst') ? body.tekst : '';
  return typeof w === 'string' ? w.replace(/\r\n?/g, '\n').trim() : null;
};

/**
 * Zapis informacji o bezpieczeństwie karty. Osobna trasa, nie formularz karty: załączniki z Allegro
 * (ATTACHMENTS) zastępuje tylko świadome „Zamień na tekst”, a zwykły zapis karty kolumny nie dotyka.
 * CSRF i uprawnienie „magazyn” sprawdzają wspólne haki panelu.
 */
export function registerGpsrKarty(app, { db, magazyn, kontaAllegro, ekranKarty, brakKarty, bezSklepow }) {
  app.post('/magazyn/:id/bezpieczenstwo', async (req, reply) => {
    if (!magazyn || magazyn.gotowy?.() === false) return reply.view('pusta-strona.ejs', bezSklepow);
    const karta = kartaPoId(db, req.params.id);
    if (!karta) return brakKarty(reply, req.params.id);
    const tekst = tekstZFormularza(req.body);
    if (tekst == null) {
      return stronaOdmowy(reply, 400, 'Niepoprawne pole tekstu informacji o bezpieczeństwie.', {
        tytul: 'Nie zapisano informacji o bezpieczeństwie',
        wroc: `/magazyn/${karta.id}#gpsr-karty`,
        napisWroc: 'Wróć do karty',
      });
    }
    const zastap = req.body && Object.hasOwn(req.body, 'zastap') && req.body.zastap === 'zalaczniki';
    const obecna = json(karta.informacja_bezpieczenstwa);
    if (obecna?.typ === 'ATTACHMENTS' && !zastap) {
      const konto = kontaAllegro().find((k) => k.klucz === napis(obecna.konto));
      const nazwaKonta = napis(konto?.nazwa) || napis(obecna.konto) || 'Allegro';
      return stronaOdmowy(reply, 409, `Karta ma załączniki z Allegro (konto ${nazwaKonta}) — użyj Zamień na tekst.`, {
        tytul: 'Nie zapisano informacji o bezpieczeństwie',
        wroc: `/magazyn/${karta.id}#gpsr-karty`,
        napisWroc: 'Wróć do karty',
      });
    }
    // Pusty tekst zwykle czyści pole, ale przy „Zamień na tekst” skasowałby załączniki bez niczego w zamian.
    if (zastap && obecna?.typ === 'ATTACHMENTS' && !tekst) {
      return ekranKarty(req, reply, {
        karta,
        kod: 400,
        gpsr: { blad: 'Wpisz tekst, który zastąpi załączniki.', tekst },
      });
    }
    if (tekst.length > LIMIT_INFORMACJI_BEZPIECZENSTWA) {
      const blad = `Informacja o bezpieczeństwie ma ${tekst.length} znaków — Allegro przyjmie najwyżej ${LIMIT_INFORMACJI_BEZPIECZENSTWA}.`;
      return ekranKarty(req, reply, { karta, kod: 400, gpsr: { blad, tekst } });
    }
    zapiszKarte(db, karta.id, {
      informacja_bezpieczenstwa: tekst ? JSON.stringify({ typ: 'TEXT', tekst }) : null,
    });
    return reply.code(303).redirect(`/magazyn/${karta.id}?zapisano=bezpieczenstwo#gpsr-karty`);
  });
}
