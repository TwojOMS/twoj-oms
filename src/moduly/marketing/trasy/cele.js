import { okresCelu, RYTMY } from '../../../domena/cele-okres.js';
import { postepCelu } from '../../../domena/postep-celu.js';
import { miernik, KLUCZE_MIERNIKOW } from '../../../domena/mierniki-celow.js';
import { nazwaOkresu } from '../../../domena/okresy-raportu.js';
import { dzienWarszawa } from '../../../domena/format-daty.js';
import {
  listaCelow, celPoId, zalozCel, zapiszCel, ustawCzynny,
  dopiszZdarzenie, cofnijOstatnie, zdarzeniaCelu,
} from '../../../oms/db/cele.js';
import { listaKont } from '../../../core/bezpieczenstwo/konta.js';
import { zmierz, progCelu } from '../uslugi/cele-pomiar.js';

// Zakladka CELE (spec 2026-09-13). Trasa jest CIENKA — wzorzec routes/statystyki.js:
// wybiera zakres, wola domene, renderuje.
//
// ⚠️ TEN MODUL NICZEGO NIE LICZY. Okres sklada `domain/cele-okres.js`, pomiar
// `services/cele-pomiar.js`, stan `domain/postep-celu.js`, nazwe okresu `okresy-raportu.js`.
// Druga sciezka liczaca to samo rozjechalaby sie przy pierwszej zmianie reguly.

// ⚠️ CZAS WARSZAWSKI, nie UTC. Klik o 23:30 czasu polskiego nalezy do dnia, w ktorym
// czlowiek go zrobil — `toISOString()` wrzucilby go do jutrzejszego tygodnia. Ta sama
// pulapka i to samo lekarstwo, co w routes/kampania.js i routes/raporty.js.
const dzisiaj = () => dzienWarszawa(new Date().toISOString());

/**
 * Sklada wiersz widoku dla jednego celu: okres → pomiar → stan.
 * Wspolne dla listy i dla karty celu, zeby kafel i karta nie mogly pokazac czegos innego.
 */
export function pozycjaCelu(db, cel, dzien, teraz) {
  const okres = okresCelu(cel.rytm, dzien, { odDnia: cel.od_dnia, doDnia: cel.do_dnia });
  const postep = postepCelu({
    celIle: cel.cel_ile,
    pomiar: zmierz(db, cel, okres),
    progSwiezosciH: progCelu(cel),
    teraz,
  });
  return { cel, okres, postep, nazwa: nazwaZakresu(okres) };
}

/**
 * Etykieta okresu na kaflu i w karcie.
 *
 * ⚠️ REGRESJA ZLAPANA NA DEMO (13.09.2026): pierwsza wersja skladala nazwe TYLKO wtedy,
 * gdy byly OBIE daty, a wszystko inne nazywala „bez terminu". Cel jednorazowy ma jednak
 * zwykle sam `do_dnia` — nikt nie wpisuje daty poczatku dla „uruchomic kampanie we
 * wrzesniu". Kafel mowil wiec „bez terminu" celowi, ktory termin MA, i to akurat temu,
 * od ktorego właściciel zaczal zgloszenie. Zaden test tego nie lapal; zobaczylo to dopiero oko.
 */
function nazwaZakresu({ od, do: doDnia }) {
  if (od && doDnia) return nazwaOkresu({ od, do: doDnia });
  if (doDnia) return `do ${doDnia}`;
  if (od) return `od ${od}`;
  return 'bez terminu';
}

export function zarejestrujTrasyCelow(app, { db }) {
  app.get('/cele', async (req, reply) => {
    const dzien = dzisiaj();
    const teraz = new Date().toISOString();
    const osoby = listaKont(db).map((k) => ({ id: k.id, imie: k.imie }));
    const imiona = new Map(osoby.map((o) => [o.id, o.imie]));

    // ⚠️ Filtr przyjmuje WYLACZNIE identyfikator istniejacego konta. Smiec w adresie ma dac
    // widok „Wszyscy", a nie pusta liste — pusta lista wygladalaby jak stan firmy („nie ma
    // celow"), a nie jak zly adres.
    const surowy = String(req.query?.kto ?? '').trim();
    const kto = imiona.has(Number(surowy)) ? Number(surowy) : null;

    const pozycje = listaCelow(db)
      .map((cel) => ({
        ...pozycjaCelu(db, cel, dzien, teraz),
        imie: cel.konto_id === null ? 'Wspólny' : (imiona.get(cel.konto_id) ?? 'Nieznane konto'),
      }))
      .filter((p) => kto === null || p.cel.konto_id === kto);

    return reply.view('cele.ejs', {
      pozycje,
      // Pas gorny: wylacznie czynne. Wygaszony cel nalezy do listy (historia), nie do kafli.
      kafle: pozycje.filter((p) => p.cel.czynny === 1),
      osoby,
      kto,
      dzisiaj: dzien,
    });
  });

  const osobyDoFormularza = () => listaKont(db).map((k) => ({ id: k.id, imie: k.imie }));

  /**
   * Czyta i waliduje formularz celu.
   *
   * ⚠️ JEDNA FUNKCJA DLA ZAKLADANIA I EDYCJI. Dwie kopie rozjechalyby sie przy pierwszej
   * zmianie reguly, a rozjazd widac dopiero wtedy, gdy ktos zapisze przez „ta druga"
   * sciezke — czyli po miesiacach.
   */
  function zCzytajCel(body) {
    const nazwa = String(body?.nazwa ?? '').trim();
    if (!nazwa) return { blad: 'Cel musi mieć nazwę.' };

    const rytm = String(body?.rytm ?? '');
    if (!RYTMY.includes(rytm)) return { blad: `Nieznany rytm: ${rytm}` };

    const kluczMiernika = String(body?.miernik ?? 'reczny');
    // ⚠️ Miernik spoza rejestru odrzucamy PRZY ZAPISIE, a nie dopiero na kaflu. Zapisany
    // cel z takim kluczem od pierwszej sekundy pokazywalby „nie wiem" i wygladal na awarie
    // panelu, a nie na literowke w formularzu.
    if (!miernik(kluczMiernika)) return { blad: `Nieznany miernik: ${kluczMiernika}` };

    // Puste pole = ZADANIE tak/nie. To jedyna droga do `cel_ile = NULL`.
    const surowe = String(body?.cel_ile ?? '').trim();
    let celIle = null;
    if (surowe !== '') {
      celIle = Number(surowe);
      // Baza i tak odrzuci 0 przez CHECK, ale wtedy czlowiek dostalby 500 zamiast komunikatu.
      if (!Number.isInteger(celIle) || celIle < 1) {
        return { blad: 'Liczba docelowa musi być całkowita i co najmniej 1.' };
      }
    }

    const kontoSurowe = String(body?.konto_id ?? '').trim();
    return {
      dane: {
        nazwa,
        rytm,
        celIle,
        miernik: kluczMiernika,
        // Puste = cel WSPOLNY.
        kontoId: kontoSurowe === '' ? null : Number(kontoSurowe),
        odDnia: String(body?.od_dnia ?? '').trim() || null,
        doDnia: String(body?.do_dnia ?? '').trim() || null,
      },
    };
  }

  app.get('/cele/nowy', async (_req, reply) => reply.view('cel-nowy.ejs', {
    osoby: osobyDoFormularza(), mierniki: KLUCZE_MIERNIKOW, rytmy: RYTMY, blad: null,
  }));

  app.post('/cele', async (req, reply) => {
    const { blad, dane } = zCzytajCel(req.body);
    if (blad) {
      return reply.code(400).view('cel-nowy.ejs', {
        osoby: osobyDoFormularza(), mierniki: KLUCZE_MIERNIKOW, rytmy: RYTMY, blad,
      });
    }
    zalozCel(db, dane);
    return reply.redirect('/cele');
  });

  app.get('/cele/:id', async (req, reply) => {
    const cel = celPoId(db, req.params.id);
    if (!cel) return reply.code(404).send('Nie ma takiego celu.');
    return reply.view('cel.ejs', {
      // TA SAMA funkcja, co na liscie — kafel i karta nie moga pokazac czegos innego.
      pozycja: pozycjaCelu(db, cel, dzisiaj(), new Date().toISOString()),
      zdarzenia: zdarzeniaCelu(db, cel.id),
      osoby: osobyDoFormularza(),
      mierniki: KLUCZE_MIERNIKOW,
      rytmy: RYTMY,
    });
  });

  app.post('/cele/:id', async (req, reply) => {
    const cel = celPoId(db, req.params.id);
    if (!cel) return reply.code(404).send('Nie ma takiego celu.');
    const { blad, dane } = zCzytajCel(req.body);
    if (blad) return reply.code(400).send(blad);
    zapiszCel(db, cel.id, dane);
    return reply.redirect(`/cele/${cel.id}`);
  });

  app.post('/cele/:id/zdarzenie', async (req, reply) => {
    const cel = celPoId(db, req.params.id);
    if (!cel) return reply.code(404).send('Nie ma takiego celu.');

    const ile = Number(String(req.body?.ile ?? '1').trim());
    // ⚠️ Zdarzenie „zero" niczego nie odnotowuje, a ujemne cicho odejmowaloby postep bez
    // sladu w historii — wygladaloby jak zwykly wpis. Cofniecie ma wlasna trase.
    if (!Number.isInteger(ile) || ile < 1) {
      return reply.code(400).send('„Ile" musi być liczbą całkowitą co najmniej 1.');
    }

    dopiszZdarzenie(db, {
      celId: cel.id,
      dzien: dzisiaj(),
      ile,
      // ⚠️⚠️ KONTO SERWISOWE NIE JEST CZLOWIEKIEM. `req.konto.serwisowe` to wspolne haslo
      // z `.env` — bootstrap przed pierwszym adminem, integracje panelu indywidualnego
      // i skrypty. Gdyby jego id trafialo tu jak id osoby, karta celu pokazywalaby konto
      // serwisowe w kolumnie „Kto" obok kont imiennych. Ta sama regula, ktora web/server.js
      // stosuje do `kto` w kontekscie zadania: konto serwisowe = BRAK kontekstu, nie
      // czwarta osoba. Zla wersja tej linii NIE zapala sie sama — id serwisowego jest
      // poprawna liczba — wiec pilnuje jej osobna asercja w cele-akcje.test.js.
      kontoId: req.konto && !req.konto.serwisowe ? req.konto.id : null,
      notatka: String(req.body?.notatka ?? '').trim() || null,
    });
    return reply.redirect(req.headers.referer ?? '/cele');
  });

  app.post('/cele/:id/cofnij', async (req, reply) => {
    const cel = celPoId(db, req.params.id);
    if (!cel) return reply.code(404).send('Nie ma takiego celu.');
    const okres = okresCelu(cel.rytm, dzisiaj(), { odDnia: cel.od_dnia, doDnia: cel.do_dnia });
    // Brak czego cofac nie jest bledem — przycisk bywa klikniety dwa razy.
    cofnijOstatnie(db, cel.id, okres);
    return reply.redirect(req.headers.referer ?? '/cele');
  });

  app.post('/cele/:id/czynny', async (req, reply) => {
    const cel = celPoId(db, req.params.id);
    if (!cel) return reply.code(404).send('Nie ma takiego celu.');
    ustawCzynny(db, cel.id, String(req.body?.czynny ?? '1') === '1');
    return reply.redirect('/cele');
  });
}
