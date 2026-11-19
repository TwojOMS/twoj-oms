// Sekcja „Parametry" karty produktu: wartości parametrów, które firma zdefiniowała w Ustawieniach.
// Edycja jak „Dane karty" — domyślnie odczyt, formularz po „Zmień" (`?edytuj=parametry`) albo po odmowie,
// żeby człowiek nie stracił tego, co wpisał. Reguły wartości są w domenie (`normalizujWartosc`).
import { kartaPoId, zapiszKarte } from '../../oms/db/magazyn.js';
import { listaParametrow, wartosciKarty, ustawWartoscKarty } from '../../oms/db/parametry-kart.js';
import { normalizujWartosc } from '../../domena/parametry-kart.js';
import { maDostepDoAdresu } from '../../domena/ekrany.js';

export const ADRES_USTAWIEN_PARAMETROW = '/magazyn/ustawienia/parametry';

// Stałe parametry karty: pola formularza w centymetrach i kilogramach (baza trzyma mm i g; przelicza
// `zmianyZFormularza`). Tylko te cztery klucze wolno podać do `zmianyZFormularza` z tego okna.
export const POLA_STALE = Object.freeze(['szerokosc_cm', 'wysokosc_cm', 'glebokosc_cm', 'waga_kg']);

const nazwaPola = (id) => `parametr_${id}`;

// Liczby baza trzyma z kropką (porównywalne i sortowalne); człowiek czyta i wpisuje przecinek.
const pokazWartosc = (parametr, wartosc) =>
  wartosc === null || wartosc === undefined ? null : parametr.typ === 'liczba' ? wartosc.replace('.', ',') : wartosc;

function przyslane(body, pole) {
  if (!body || typeof body !== 'object' || !Object.hasOwn(body, pole)) return undefined;
  return body[pole];
}

/**
 * Dane okna. Stałe pola (wymiary, waga) są zawsze, więc okno też; `lista` to parametry własne (może być pusta).
 * `stale` niesie odczyt (`wymiary`, `waga`) i wartości pól formularza (`wartosci`). `blad` + `body` — odmowa
 * zapisu: formularz otwarty z tym, co przysłano.
 */
export function daneParametrowKarty(
  db,
  kartaId,
  { konto, edytuj = false, blad = null, body = null, adresy, stale = {} },
) {
  const parametry = listaParametrow(db);
  const linkUstawien = maDostepDoAdresu(konto, ADRES_USTAWIEN_PARAMETROW) ? ADRES_USTAWIEN_PARAMETROW : null;
  const polaStale = Object.fromEntries(
    POLA_STALE.map((klucz) => {
      const wpisane = blad ? przyslane(body, klucz) : undefined;
      return [klucz, typeof wpisane === 'string' ? wpisane : (stale.wartosci?.[klucz] ?? '')];
    }),
  );
  const zStalymi = { wymiary: stale.wymiary ?? null, waga: stale.waga ?? null, polaStale };
  if (!parametry.length)
    return { lista: [], ...zStalymi, linkUstawien, edytuj: edytuj || Boolean(blad), blad, ...adresy };
  const zBazy = wartosciKarty(db, kartaId);
  const lista = parametry.map((p) => {
    const wartosc = zBazy.get(p.id) ?? null;
    const pokaz = pokazWartosc(p, wartosc);
    const wpisane = blad ? przyslane(body, nazwaPola(p.id)) : undefined;
    return {
      id: p.id,
      nazwa: p.nazwa,
      typ: p.typ,
      jednostka: p.jednostka || null,
      wartosci: p.wartosci ?? [],
      wymagany: p.wymagany,
      pokaz,
      brakWymaganego: p.wymagany && wartosc === null,
      pole: nazwaPola(p.id),
      wPolu: typeof wpisane === 'string' ? wpisane : (pokaz ?? ''),
    };
  });
  return { lista, ...zStalymi, linkUstawien, edytuj: edytuj || Boolean(blad), blad, ...adresy };
}

/**
 * Zapis wszystkich przysłanych pól naraz: najpierw walidacja każdego, potem zapis w jednej transakcji —
 * jedna zła wartość nie zostawia karty zapisanej w połowie. Pole, którego formularz nie przysłał, zostaje.
 */
export function registerParametryKarty(
  app,
  { db, magazyn, ekranKarty, brakKarty, bezSklepow, transakcja, adresPoZapisie, zmianyZFormularza },
) {
  app.post('/magazyn/:id/parametry', async (req, reply) => {
    if (!magazyn || magazyn.gotowy?.() === false) return reply.view('pusta-strona.ejs', bezSklepow);
    const karta = kartaPoId(db, req.params.id);
    if (!karta) return brakKarty(reply, req.params.id);
    // Do `zmianyZFormularza` idzie tylko wycinek z czterema polami stałymi: czyta ona też nazwę, SKU, EAN,
    // cenę i VAT, a to okno ich nie ma — całe ciało żądania pozwoliłoby je tu podmienić.
    const wycinek = {};
    for (const klucz of POLA_STALE) if (Object.hasOwn(req.body ?? {}, klucz)) wycinek[klucz] = req.body[klucz];
    const stale = zmianyZFormularza(db, karta, wycinek);
    const doZapisu = [];
    const bledy = [];
    if (stale.blad) bledy.push(stale.blad);
    for (const p of listaParametrow(db)) {
      const surowa = przyslane(req.body, nazwaPola(p.id));
      if (surowa === undefined) continue;
      const v = normalizujWartosc(p, surowa);
      if (v.blad) bledy.push(v.blad);
      else doZapisu.push([p.id, v.wartosc]);
    }
    if (bledy.length) {
      return ekranKarty(req, reply, { karta, kod: 400, parametry: { blad: bledy.join(' '), body: req.body } });
    }
    const kto = req.konto?.login ?? null;
    transakcja(db, () => {
      if (Object.keys(stale.zmiany).length) zapiszKarte(db, karta.id, stale.zmiany);
      for (const [id, wartosc] of doZapisu) {
        const w = ustawWartoscKarty(db, karta.id, id, wartosc ?? '', { kto });
        // Wartość przeszła walidację przed transakcją; odmowa tutaj to wyścig z Ustawieniami — cofamy całość.
        if (w.blad) throw new Error(w.blad);
      }
    });
    return reply.code(303).redirect(`${adresPoZapisie(karta.id, req.query?.wroc)}#parametry-karty`);
  });
}
