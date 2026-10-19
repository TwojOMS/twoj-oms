// PRZ-101.03: Ustawienia → Szablony wiadomości — edycja czterech maili wbudowanych i szablony własne.
//
// Kto może: strażnik po prefiksie `/ustawienia` wpuszcza tylko konto z uprawnieniem „ustawienia"; gościa demo
// w podglądzie zatrzymuje na każdym POST-cie (core/bezpieczenstwo/podglad-demo.js). CSRF sprawdza wspólny hak
// (core/bezpieczenstwo/csrf.js). Tu nie powtarzamy żadnej z tych blokad.
//
// PRG: zapis → 303 na ekran edycji; odmowa → 400 z wpisaną treścią i powodem (nic nie ginie).
// „Podgląd" to GET z treścią w adresie — niczego nie zapisuje, działa też u gościa demo.
import {
  WBUDOWANE, KONTA, MAKS, NOWY_WLASNY, polaSzablonu, rodzajSzablonu, sprawdzSzablon, szablonDoEdycji, zapiszSzablon, usunSzablon,
} from '../../../domena/szablony-wiadomosci.js';
import { wczytajSzablonyWiadomosci, zmienSzablonyWiadomosci } from '../../../oms/db/szablony-wiadomosci.js';
import { podgladSzablonu } from '../szablony.js';
import { nawigacjaUstawien } from '../../ustawienia/nawigacja.js';

const ADRES = '/ustawienia/szablony-wiadomosci';

const KOMUNIKATY = {
  przywrocono: 'Przywrócono treść domyślną.',
  usunieto: 'Szablon usunięty. Wysłane nim wiadomości zostają w historii zamówień.',
};

export function registerSzablonyWiadomosciRoutes(app, { db, oprawa, teraz = () => new Date() }) {
  // Podstrony edycji świecą w menu tą samą pozycją, co lista (podmenu zna wyłącznie adres listy).
  const nawigacja = (req, reply) => nawigacjaUstawien({ url: ADRES, konto: req.konto }, reply);

  /** Szablon pod adresem albo `null` (nieznany id, usunięty szablon własny). */
  function szablonPod(id) {
    if (id === 'nowy') return { ...NOWY_WLASNY, id: 'nowy', rodzaj: 'wlasny', wbudowany: false, nowy: true };
    return szablonDoEdycji(wczytajSzablonyWiadomosci(db), id);
  }

  function ekranEdycji(req, reply, s, { formularz = null, blad = null, podglad = null } = {}) {
    return reply.view('ustawienia-szablon.ejs', {
      nawigacja: nawigacja(req, reply),
      title: s.nowy ? 'Nowy szablon wiadomości' : `Szablon: ${s.nazwa}`,
      s, f: formularz ?? { nazwa: s.nazwa ?? '', temat: s.temat, tresc: s.tresc },
      pola: polaSzablonu(s.rodzaj), maks: MAKS, blad, podglad,
      zapisano: req.query?.zapisano === '1' ? 'Zapisano. Następny mail pójdzie z tą treścią.' : null,
    });
  }

  app.get(ADRES, async (req, reply) => {
    const stan = wczytajSzablonyWiadomosci(db);
    return reply.view('ustawienia-szablony.ejs', {
      nawigacja: nawigacja(req, reply),
      title: 'Szablony wiadomości',
      wbudowane: WBUDOWANE.map((id) => szablonDoEdycji(stan, id)),
      // PRZ-101.06: maile do pracowników — osobna sekcja, żeby nikt nie pomylił ich z mailami do klientów.
      zespol: KONTA.map((id) => szablonDoEdycji(stan, id)),
      wlasne: stan.wlasne, maks: MAKS,
      komunikat: KOMUNIKATY[req.query?.zapisano] ?? null,
    });
  });

  app.get(`${ADRES}/:id`, async (req, reply) => {
    const s = szablonPod(String(req.params.id));
    if (!s) return reply.code(404).type('text/plain; charset=utf-8').send('Nie ma takiego szablonu — mógł zostać usunięty.');
    if (req.query?.podglad === undefined) return ekranEdycji(req, reply, s);

    const formularz = {
      nazwa: String(req.query.nazwa ?? s.nazwa ?? ''), temat: String(req.query.temat ?? ''), tresc: String(req.query.tresc ?? ''),
    };
    const sprawdzony = sprawdzSzablon(s.rodzaj, formularz);
    if (!sprawdzony.ok) return ekranEdycji(req, reply, s, { formularz, blad: sprawdzony.blad });
    return ekranEdycji(req, reply, s, { formularz, podglad: podgladSzablonu(s.id, sprawdzony.szablon, { oprawa, teraz: teraz() }) });
  });

  app.post(`${ADRES}/:id`, async (req, reply) => {
    const id = String(req.params.id);
    const s = szablonPod(id);
    if (!s) return reply.code(404).type('text/plain; charset=utf-8').send('Nie ma takiego szablonu — mógł zostać usunięty.');
    const pola = req.body ?? {};
    const formularz = { nazwa: String(pola.nazwa ?? ''), temat: String(pola.temat ?? ''), tresc: String(pola.tresc ?? '') };
    const wynik = zmienSzablonyWiadomosci(db, (stan) => zapiszSzablon(stan, id, formularz, teraz().toISOString()));
    if (!wynik.ok) {
      reply.code(400);
      return ekranEdycji(req, reply, s, { formularz, blad: wynik.blad });
    }
    return reply.code(303).redirect(`${ADRES}/${encodeURIComponent(wynik.id)}?zapisano=1`);
  });

  // Wbudowany: „Przywróć domyślny" (kasuje zapis — mail wraca do treści dostarczonej z panelem).
  // Własny: „Usuń". Jedna trasa, bo w obu wypadkach znika wpis z zapisu.
  app.post(`${ADRES}/:id/usun`, async (req, reply) => {
    const id = String(req.params.id);
    const wynik = zmienSzablonyWiadomosci(db, (stan) => usunSzablon(stan, id));
    if (!wynik.ok) return reply.code(404).type('text/plain; charset=utf-8').send(wynik.blad);
    return reply.code(303).redirect(`${ADRES}?zapisano=${rodzajSzablonu(id) === 'wlasny' ? 'usunieto' : 'przywrocono'}`);
  });
}
