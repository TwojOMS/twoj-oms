// Magazyn → Producenci (/magazyn/producenci): słownik producentów potrzebny do GPSR — nazwa, adres pocztowy,
// e-mail albo strona www. Dodanie, edycja, usunięcie (odmowa, gdy producent ma marki albo jest domyślny),
// wybór producenta domyślnego i przypisanie producentów do marek ze słownika marek.
// Reguły pól są w domenie (walidujProducenta), zapis w db/producenci.js — tu tylko formularze.
// Uprawnienie: ekran „magazyn” (prefiks /magazyn), jak Kategorie i Marki.
import { listaSlownika } from './services/slowniki-kart.js';
import {
  listaProducentow,
  producentPoId,
  dodajProducenta,
  zmienProducenta,
  usunProducenta,
  ustawDomyslnego,
  przypiszMarki,
  przypisaniaMarek,
} from '../../oms/db/producenci.js';
import { LIMITY_PRODUCENTA, opisProducenta } from '../../domena/producenci.js';

const ADRES = '/magazyn/producenci';

const KOMUNIKATY = Object.freeze({
  dodano: 'Dodano producenta.',
  zmieniono: 'Zapisano zmiany producenta.',
  usunieto: 'Usunięto producenta.',
  domyslny: 'Zapisano producenta domyślnego.',
  marki: 'Zapisano przypisania marek.',
});

const PUSTY = Object.freeze({ nazwa: '', adres: '', email: '', www: '' });

// Pole formularza jako tekst — pole podane dwa razy (tablica) traktujemy jak puste, walidacja je odrzuci.
const pole = (w) => (typeof w === 'string' ? w : '');
const id = (w) => (typeof w === 'string' && /^\d{1,9}$/.test(w) ? Number(w) : null);
// Jedno pole formularza przychodzi jako tekst, powtórzone — jako tablica.
const lista = (w) => (Array.isArray(w) ? w : w === undefined ? [] : [w]);

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{ db: any }} opcje
 */
export function registerProducenciMagazynu(app, { db }) {
  function ekran(reply, { kod = 200, blad = null, komunikat = null, formularz = null } = {}) {
    const producenci = listaProducentow(db);
    const przypisania = przypisaniaMarek(db);
    const marki = listaSlownika(db, 'marki')
      .pozycje.filter((p) => p.wSlowniku)
      .map((p) => ({ nazwa: p.nazwa, producentId: przypisania.get(p.nazwa) ?? null }));
    return reply.code(kod).view('magazyn-producenci.ejs', {
      title: 'Magazyn — producenci',
      szerokosc: 'tabela',
      producenci,
      domyslny: producenci.find((p) => p.domyslny) ?? null,
      marki,
      blad,
      komunikat,
      // Formularz: dodanie (bez id) albo edycja; `bledy` przy polach, `wartosci` — to, co wpisał człowiek.
      formularz: formularz ?? { id: null, wartosci: PUSTY, bledy: {} },
      limity: LIMITY_PRODUCENTA,
      adresJednaLinia: (p) => opisProducenta({ adres: p.adres }),
    });
  }

  const wpisane = (body) => ({
    nazwa: pole(body?.nazwa),
    adres: pole(body?.adres),
    email: pole(body?.email),
    www: pole(body?.www),
  });

  app.get(ADRES, async (req, reply) => {
    const q = req.query ?? {};
    if (q.edytuj !== undefined) {
      const p = id(q.edytuj) === null ? null : producentPoId(db, id(q.edytuj));
      if (!p) return ekran(reply, { kod: 404, blad: 'Nie ma takiego producenta.' });
      const wartosci = { nazwa: p.nazwa, adres: p.adres, email: p.email ?? '', www: p.www ?? '' };
      return ekran(reply, { formularz: { id: p.id, wartosci, bledy: {} } });
    }
    return ekran(reply, { komunikat: KOMUNIKATY[q.ok] ?? null });
  });

  app.post(`${ADRES}/dodaj`, async (req, reply) => {
    const wynik = dodajProducenta(db, req.body ?? {});
    if (!wynik.ok) {
      return ekran(reply, { kod: 400, formularz: { id: null, wartosci: wpisane(req.body), bledy: wynik.bledy } });
    }
    return reply.code(303).redirect(`${ADRES}?ok=dodano`);
  });

  app.post(`${ADRES}/:id/zmien`, async (req, reply) => {
    const nr = id(req.params.id);
    if (nr === null || !producentPoId(db, nr)) return ekran(reply, { kod: 404, blad: 'Nie ma takiego producenta.' });
    const wynik = zmienProducenta(db, nr, req.body ?? {});
    if (wynik.blad) return ekran(reply, { kod: 404, blad: wynik.blad });
    if (!wynik.ok) {
      return ekran(reply, { kod: 400, formularz: { id: nr, wartosci: wpisane(req.body), bledy: wynik.bledy } });
    }
    return reply.code(303).redirect(`${ADRES}?ok=zmieniono`);
  });

  app.post(`${ADRES}/:id/usun`, async (req, reply) => {
    const nr = id(req.params.id);
    if (nr === null || !producentPoId(db, nr)) return ekran(reply, { kod: 404, blad: 'Nie ma takiego producenta.' });
    const wynik = usunProducenta(db, nr);
    if (wynik.blad) return ekran(reply, { kod: 409, blad: wynik.blad });
    return reply.code(303).redirect(`${ADRES}?ok=usunieto`);
  });

  app.post(`${ADRES}/domyslny`, async (req, reply) => {
    const wybor = pole(req.body?.producent);
    const wynik = ustawDomyslnego(db, wybor === '' ? null : (id(wybor) ?? -1));
    if (wynik.blad) return ekran(reply, { kod: 400, blad: wynik.blad });
    return reply.code(303).redirect(`${ADRES}?ok=domyslny`);
  });

  app.post(`${ADRES}/marki`, async (req, reply) => {
    const marki = lista(req.body?.marka);
    const wybory = lista(req.body?.producent);
    // Pary marka–producent idą w kolejności pól; różna liczba oznacza uszkodzony formularz — nic nie zapisujemy.
    if (marki.length !== wybory.length || [...marki, ...wybory].some((w) => typeof w !== 'string')) {
      return ekran(reply, { kod: 400, blad: 'Formularz przypisań jest niepełny. Odśwież stronę i zapisz ponownie.' });
    }
    const zmiany = marki.map((marka, i) => ({
      marka,
      producentId: wybory[i] === '' ? null : (id(wybory[i]) ?? -1),
    }));
    const wynik = przypiszMarki(db, zmiany);
    if (wynik.blad) return ekran(reply, { kod: 400, blad: wynik.blad });
    return reply.code(303).redirect(`${ADRES}?ok=marki#marki`);
  });
}
