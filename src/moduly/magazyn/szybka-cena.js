// Szybka zmiana ceny karty z listy magazynu (ołówek w kolumnie „Cena”, skrypt public/szybka-cena.js).
//
// ⚠️ TA SAMA DROGA CO FORMULARZ KARTY, BEZ DRUGIEGO PARSERA. Kwotę czyta `zmianyZFormularza` z polem `cena_zl`
// (przecinek dziesiętny, grosze po cyfrach, napis niezrozumiały = odmowa całości), zapisuje `zapiszKarte`
// ze źródłem ręcznym — tak jak `POST /magazyn/:id`. Druga kopia reguły rozjechałaby się z kartą przy pierwszej
// zmianie i lista przyjmowałaby kwoty, których karta nie przyjmuje (albo odwrotnie).
//
// Uprawnienia i CSRF są w hakach rdzenia (ekran z prefiksu `/magazyn`, sprawdzanie Origin/Referer), wspólnych
// dla wszystkich tras modułu — fetch z tej samej strony niesie Origin sam. Ostatni zapis wygrywa, jak na karcie.
//
// Odpowiedź to JSON: skrypt podmienia jedną komórkę i nie potrzebuje do tego fragmentu HTML.

import { cenaDodatnia } from '../../domena/cena-kanalu.js';
import { cenaListy } from './lista.js';

const PUSTA = 'Wpisz cenę albo anuluj';
const NIEDODATNIA = 'Cena musi być większa od zera.';

export function registerSzybkaCenaMagazynu(app, { db, magazyn, pomoc }) {
  const { kartaPoId, zmianyZFormularza, zapiszKarte, pole, BEZ_SKLEPOW_ODMOWA } = pomoc;

  // Oferty, których cenę pętla ofert liczy z ceny karty. Obserwowane (przejęte) OMS tylko czyta — ich zmiana
  // ceny karty nie rusza, więc nie wchodzą do ostrzeżenia.
  const zarzadzane = (kartaId) =>
    Number(
      db.prepare("SELECT COUNT(*) AS n FROM oferty_kanalow WHERE karta_id = ? AND tryb = 'zarzadzana'").get(kartaId)
        ?.n ?? 0,
    );
  const ostrzezenie = (n) =>
    n > 0 ? `Zmieni cenę w ${n} ${n === 1 ? 'ofercie' : 'ofertach'} przy najbliższym przebiegu` : null;

  app.post('/magazyn/:id/cena', async (req, reply) => {
    if (!magazyn || magazyn.gotowy?.() === false) return reply.code(503).send({ blad: BEZ_SKLEPOW_ODMOWA });
    const karta = kartaPoId(db, req.params.id);
    if (!karta) return reply.code(404).send({ blad: 'Nie ma takiej karty produktu — odśwież listę.' });

    // ⚠️ PUSTE NIE CZYŚCI CENY (inaczej niż na karcie): przypadkowy Enter w pustym polu na liście zdjąłby cenę,
    // od której liczą się oferty. Czyszczenie zostaje świadomym ruchem na karcie.
    const surowa = pole(req.body, 'cena_zl');
    if (surowa === null || !surowa.trim()) return reply.code(400).send({ blad: PUSTA });

    // Minus parser karty odrzuca jako „to nie jest cena”; tu mówimy wprost, czego brakuje — jak przy zerze.
    if (/^\s*[-−–]/.test(surowa)) return reply.code(400).send({ blad: NIEDODATNIA });

    const { zmiany, blad } = zmianyZFormularza(db, karta, { cena_zl: surowa });
    // Komunikat jest wspólny z kartą, ale jego końcówka o kasowaniu ceny pustym polem tu nie obowiązuje.
    if (blad)
      return reply.code(400).send({ blad: blad.replace(/ albo zostaw pole puste, żeby skasować cenę\.$/, '.') });

    // Parser karty przepuszcza 0 (na karcie to świadomy wpis), ale z listy zero zdjęłoby ofertom cenę jednym Enterem.
    if (!cenaDodatnia(zmiany.cena_gr)) return reply.code(400).send({ blad: NIEDODATNIA });

    zapiszKarte(db, karta.id, { cena_gr: zmiany.cena_gr });
    const cenaGr = kartaPoId(db, karta.id).cena_gr;
    return reply.send({
      cena_gr: cenaGr,
      // Ten sam formater co komórka listy: po zapisie kwota nie może zmienić wyglądu (np. zgubić odstępu tysięcy).
      cena: cenaListy(cenaGr / 100),
      ostrzezenie: ostrzezenie(zarzadzane(karta.id)),
    });
  });
}
