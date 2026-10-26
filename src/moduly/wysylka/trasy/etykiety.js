import { createReadStream, existsSync } from 'node:fs';

import { pobierzZamowienie, dopiszLog } from '../../../oms/db/zamowienia.js';

import { odblokujPrzesylke, domknijPrzesylke, zalatwPrzesylkeRecznie, skasujPrzesylkeReczna, ukryjPrzesylke, przywrocPrzesylke } from '../db/przesylki.js';

import { dodajDoKolejki, pozycjeDoWziecia, zplDlaPozycji, oznaczWydrukowano, oznaczBladDruku, porzucPozycje } from '../db/kolejka-druku.js';

import { mozliweUkrycie } from '../../../domena/przesylka-stan.js';

import { bezpiecznyPowrotNaListe } from '../../../domena/filtry-listy.js';

import { adresKartyZamowienia } from '../../../domena/adres-karty-zamowienia.js';

import { join } from 'node:path';

import { komunikatDlaOperatora } from '../../../domena/bledy.js';

import { bezpiecznaNazwa } from '../../../domena/pliki.js';

import { ktoKlikal } from '../../zamowienia/lista.js';

export function registerEtykietyRoutes(app, { db, nadanie, kurierzy = {}, wczytajListe, miniaturyEkranu, config }) {

const adresPowrotuNaKarte = (req, id, opcje = {}) => adresKartyZamowienia(id, {
    powrot: powrotKarty(req),
    ...opcje,
  }, config.definicje);

const powrotKarty = (req) => bezpiecznyPowrotNaListe(req.query?.powrot ?? req.body?.powrot, config.definicje);

function paczkaZadania(req, reply) {
    const id = Number(req.params.id);
    const z = pobierzZamowienie(db, id);
    if (!z) {
      reply.code(404).send('Nie ma takiego zamówienia');
      return null;
    }
    const przesylkaId = Number(req.params.przesylkaId);
    const p = z.przesylki.find((w) => w.id === przesylkaId);
    if (!p) {
      reply.code(404).send('To zamówienie nie ma takiej przesyłki.');
      return null;
    }
    return { id, z, p };
  }

app.post('/zamowienia/:id/przesylki/:przesylkaId/sprawdz', async (req, reply) => {
    const cel = paczkaZadania(req, reply);
    if (!cel) return reply;
    const { id, p } = cel;
    if (!nadanie) return reply.code(503).send('Nadawanie nie jest skonfigurowane (brak danych kuriera).');
    let wynik;
    try {
      wynik = await nadanie.sprawdzPonownie(p.id);
    } catch (e) {
      // Pełny komunikat idzie do logu, na ekran tylko to, co napisaliśmy dla człowieka —
      // ta sama zasada, co przy POST /nadaj.
      dopiszLog(db, id, { akcja: 'nadanie.sprawdzenie.http', wynik: `BŁĄD: ${e.message}` });
      return reply.code(400).send(`Nie udało się sprawdzić przesyłki: ${komunikatDlaOperatora(e)}`);
    }
    // Numer przyszedł — gdy jest ZPL, etykieta trafia do kolejki. WzA z etykieta PDF
    // (wybrane „Nadaj") to SWIADOMY brak ZPL, nie awaria i nie zadanie drukowania.
    // Paczkomatowa paczke nadal drukujemy; niechciany wydruk mozna porzucic.
    //
    // Awaria kolejki NIE cofa nadania: paczka fizycznie istnieje, numer listu jest w bazie.
    if (wynik.numerListu) {
      const swieza = pobierzZamowienie(db, id)?.przesylki.find((w) => w.id === p.id);
      try {
        if (swieza?.etykieta_zpl_sciezka) {
          dodajDoKolejki(db, swieza.id);
          dopiszLog(db, id, { akcja: 'kolejka-druku.dodanie', wynik: 'OK (Sprawdź ponownie)' });
        } else if (swieza?.kurier !== 'allegro_wza') {
          dopiszLog(db, id, { akcja: 'kolejka-druku.dodanie', wynik: 'BRAK ZPL — nie dodano do kolejki (Sprawdź ponownie)' });
        }
      } catch (e) {
        dopiszLog(db, id, { akcja: 'kolejka-druku.dodanie', wynik: `BŁĄD: ${e.message}` });
      }
    }
    return reply.redirect(adresPowrotuNaKarte(req, id));
  });

app.post('/zamowienia/:id/przesylki/:przesylkaId/odblokuj', async (req, reply) => {
    const cel = paczkaZadania(req, reply);
    if (!cel) return reply;
    const { id, p } = cel;
    const numerListu = String(req.body?.numer_listu ?? '').trim();
    const kto = ktoKlikal(req);
    const opis = numerListu
      ? `Ręcznie (${kto}): nadanie paczki nr ${p.kolejnosc} zawisło, w panelu DPD paczka MA numer listu ${numerListu} — `
        + 'ponowienie z panelu jest zablokowane, dokończ sprawę u kuriera.'
      : `Ręcznie (${kto}): nadanie paczki nr ${p.kolejnosc} zawisło, w panelu DPD paczki NIE MA — zwolnione pod ponowienie.`;
    try {
      odblokujPrzesylke(db, p.id, { numerListu, opis });
    } catch (e) {
      dopiszLog(db, id, { akcja: 'przesylka.odblokowanie', wynik: `BŁĄD: ${e.message}` });
      return reply.code(400).send(`Nie udało się odblokować nadania: ${komunikatDlaOperatora(e)}`);
    }
    dopiszLog(db, id, { akcja: 'przesylka.odblokowanie', wynik: opis });
    return reply.redirect(adresPowrotuNaKarte(req, id));
  });

app.post('/zamowienia/:id/przesylki/:przesylkaId/domknij', async (req, reply) => {
    const cel = paczkaZadania(req, reply);
    if (!cel) return reply;
    const { id, p: docelowa } = cel;
    let p;
    try {
      p = domknijPrzesylke(db, docelowa.id);
    } catch (e) {
      dopiszLog(db, id, { akcja: 'przesylka.domkniecie', wynik: `BŁĄD: ${e.message}` });
      return reply.code(400).send(`Nie udało się domknąć przesyłki: ${komunikatDlaOperatora(e)}`);
    }
    dopiszLog(db, id, {
      akcja: 'przesylka.domkniecie',
      wynik: `Ręcznie (${ktoKlikal(req)}): sprawdzone w panelu DPD, paczka nr ${p.kolejnosc} (list ${p.numer_listu}) jest nadana`
        + `${p.blad_opis ? ` — powód wyjaśnienia: ${p.blad_opis}` : ''}.`,
    });
    return reply.redirect(adresPowrotuNaKarte(req, id));
  });

// PRZ-117: „Spróbuj ponownie” przy notatce z numerem listu, która nie doszła do sklepu. Wysyła TĘ SAMĄ notatkę
// jeszcze raz (services/notatka-nadania.js); nieudana próba odświeża ślad na karcie i nie jest błędem HTTP.
app.post('/zamowienia/:id/przesylki/:przesylkaId/notatka', async (req, reply) => {
    const cel = paczkaZadania(req, reply);
    if (!cel) return reply;
    const { id, p } = cel;
    if (!nadanie) return reply.code(503).send('Nadawanie nie jest skonfigurowane (brak sklepu albo kuriera).');
    try {
      await nadanie.ponowNotatke(p.id);
    } catch (e) {
      dopiszLog(db, id, { akcja: 'sync-woo', wynik: `BŁĄD: notatka (ponowienie): ${e.message}` });
      return reply.code(400).send(`Nie udało się ponowić notatki: ${komunikatDlaOperatora(e)}`);
    }
    return reply.redirect(adresPowrotuNaKarte(req, id));
  });

app.post('/zamowienia/:id/przesylki/:przesylkaId/sprawa-zalatwiona', async (req, reply) => {
    const cel = paczkaZadania(req, reply);
    if (!cel) return reply;
    const { id, p } = cel;
    let wynik;
    try {
      wynik = zalatwPrzesylkeRecznie(db, p.id);
    } catch (e) {
      dopiszLog(db, id, { akcja: 'przesylka.sprawa-zalatwiona', wynik: `BŁĄD: ${e.message}` });
      return reply.code(400).send(`Nie udało się zdjąć sprawy: ${komunikatDlaOperatora(e)}`);
    }
    const OPISY_SPRAW = { sync_woo_blad: 'sync ze sklepem', brak_etykiety: 'brak etykiety' };
    const zdjete = wynik.sprawy.map((s) => OPISY_SPRAW[s]).join(' i ');
    dopiszLog(db, id, {
      akcja: 'przesylka.sprawa-zalatwiona',
      wynik: `Ręcznie (${ktoKlikal(req)}): paczka nr ${p.kolejnosc} — ${zdjete} załatwione poza panelem — `
        + 'zdjęte z listy roboczej.',
    });
    return reply.redirect(adresPowrotuNaKarte(req, id));
  });

app.post('/zamowienia/:id/przesylki/:przesylkaId/ukryj', async (req, reply) => {
    const cel = paczkaZadania(req, reply);
    if (!cel) return reply;
    const { id, p } = cel;
    const z = pobierzZamowienie(db, id);
    if (!mozliweUkrycie(p, z?.przesylki)) {
      return reply.code(400).send(
        `Paczki nr ${p.kolejnosc} nie da się ukryć: do tego zamówienia nie ma nadanej kolejnej paczki. `
        + 'Ukrywanie służy paczkom, które zastąpiła następna — a nie tej, która właśnie jedzie. '
        + 'Odśwież kartę zamówienia.',
      );
    }
    ukryjPrzesylke(db, p.id, ktoKlikal(req));
    dopiszLog(db, id, {
      akcja: 'przesylka.ukryj',
      wynik: `Ręcznie (${ktoKlikal(req)}): paczka nr ${p.kolejnosc} (${p.numer_listu ?? 'bez numeru'}) `
        + 'ukryta z listy przesyłek — zastąpiła ją kolejna paczka tego zamówienia.',
    });
    return reply.redirect(adresPowrotuNaKarte(req, id));
  });

app.post('/zamowienia/:id/przesylki/:przesylkaId/przywroc', async (req, reply) => {
    const cel = paczkaZadania(req, reply);
    if (!cel) return reply;
    const { id, p } = cel;
    przywrocPrzesylke(db, p.id);
    dopiszLog(db, id, {
      akcja: 'przesylka.przywroc',
      wynik: `Ręcznie (${ktoKlikal(req)}): paczka nr ${p.kolejnosc} (${p.numer_listu ?? 'bez numeru'}) `
        + 'przywrócona na listę przesyłek.',
    });
    return reply.redirect(adresPowrotuNaKarte(req, id));
  });

app.post('/zamowienia/:id/przesylki/:przesylkaId/skasuj-reczna', async (req, reply) => {
    const cel = paczkaZadania(req, reply);
    if (!cel) return reply;
    const { id, p } = cel;
    let skasowana;
    try {
      skasowana = skasujPrzesylkeReczna(db, p.id);
    } catch (e) {
      dopiszLog(db, id, { akcja: 'przesylka.skasowanie-reczna', wynik: `BŁĄD: ${e.message}` });
      return reply.code(400).send(`Nie udało się skasować przesyłki: ${komunikatDlaOperatora(e)}`);
    }
    // Numer listu skasowanego wiersza MUSI trafic do logu — po DELETE juz go w bazie nie ma,
    // wiec bez tego zdania po miesiacu nie da sie odtworzyc, ktory numer operator uznal
    // za blednie wpisany.
    dopiszLog(db, id, {
      akcja: 'przesylka.skasowanie-reczna',
      wynik: `Ręcznie (${ktoKlikal(req)}): przesyłka nr ${skasowana.kolejnosc} zarejestrowana ręcznie `
        + `(list ${skasowana.numer_listu}) skasowana z panelu — panel niczego nie odwoływał u kuriera, `
        + 'paczka, jeśli fizycznie istnieje, nadal jedzie. Miejsce zwolnione pod ponowną rejestrację.',
    });
    return reply.redirect(adresPowrotuNaKarte(req, id));
  });

app.post('/zamowienia/:id/przesylki/:przesylkaId/drukuj', async (req, reply) => {
    const cel = paczkaZadania(req, reply);
    if (!cel) return reply;
    const { id, p } = cel;
    if (!p.etykieta_zpl_sciezka) {
      return reply.code(400).send('Brak etykiety ZPL dla tej przesyłki — nie ma czego wysłać do druku.');
    }
    try {
      dodajDoKolejki(db, p.id);
    } catch (e) {
      dopiszLog(db, id, { akcja: 'kolejka-druku.dodanie', wynik: `BŁĄD: ${e.message}` });
      return reply.code(400).send(`Nie udało się dodać do kolejki druku: ${komunikatDlaOperatora(e)}`);
    }
    dopiszLog(db, id, { akcja: 'kolejka-druku.dodanie', wynik: `OK (przycisk na karcie, paczka nr ${p.kolejnosc})` });
    return reply.redirect(adresPowrotuNaKarte(req, id));
  });

app.post('/zamowienia/:id/przesylki/:przesylkaId/drukuj/:kolejkaId/porzuc', async (req, reply) => {
    const cel = paczkaZadania(req, reply);
    if (!cel) return reply;
    const { id } = cel;
    const kolejkaId = Number(req.params.kolejkaId);
    try {
      porzucPozycje(db, kolejkaId);
    } catch (e) {
      dopiszLog(db, id, { akcja: 'kolejka-druku.porzucenie', wynik: `BŁĄD: ${e.message}` });
      return reply.code(400).send(`Nie udało się porzucić pozycji: ${komunikatDlaOperatora(e)}`);
    }
    dopiszLog(db, id, {
      akcja: 'kolejka-druku.porzucenie',
      wynik: `Ręcznie (${ktoKlikal(req)}): pozycja ${kolejkaId} w kolejce druku porzucona.`,
    });
    return reply.redirect(adresPowrotuNaKarte(req, id));
  });

app.get('/zamowienia/:id/przesylki/:przesylkaId/etykieta', async (req, reply) => {
    const cel = paczkaZadania(req, reply);
    if (!cel) return reply;
    const { z, p } = cel;
    const sciezka = p.etykieta_sciezka;
    if (!sciezka) return reply.code(404).send('Brak etykiety dla tej przesyłki.');
    // Brak pliku to nie awaria serwera, tylko brak zasobu — 500 z pelna sciezka w JSON-ie
    // wystawialby uklad katalogow serwera na ekran operatora (i do historii przegladarki).
    if (!existsSync(sciezka)) {
      return reply.code(404).send('Plik etykiety nie istnieje na dysku — pobierz etykietę z panelu DPD po numerze listu.');
    }
    const nazwaPliku = `etykieta-${bezpiecznaNazwa(p.numer_listu ?? z.numer)}.pdf`;
    return reply.type('application/pdf')
      .header('Content-Disposition', `inline; filename="${nazwaPliku}"`)
      .send(createReadStream(sciezka));
  });

app.get('/kolejka-druku', async () => pozycjeDoWziecia(db));

app.get('/kolejka-druku/:id/zpl', async (req, reply) => {
    const id = Number(req.params.id);
    const wynik = zplDlaPozycji(db, id);
    const sciezka = wynik?.sciezka;
    if (!sciezka) return reply.code(404).send('Brak pliku ZPL dla tej pozycji kolejki.');
    // Brak pliku to nie awaria serwera, tylko brak zasobu — 500 z pelna sciezka wystawialby
    // uklad katalogow serwera na ekran (i do logu czuwacza).
    if (!existsSync(sciezka)) return reply.code(404).send('Plik ZPL nie istnieje na dysku.');
    return reply.type('application/octet-stream').send(createReadStream(sciezka));
  });

app.post('/kolejka-druku/:id/wydrukowano', async (req, reply) => {
    const id = Number(req.params.id);
    try {
      oznaczWydrukowano(db, id);
    } catch (e) {
      return reply.code(404).send(komunikatDlaOperatora(e));
    }
    return { ok: true };
  });

app.post('/kolejka-druku/:id/blad', async (req, reply) => {
    const id = Number(req.params.id);
    const powod = String(req.body?.powod ?? '').trim() || 'nieznany błąd druku';
    try {
      oznaczBladDruku(db, id, powod);
    } catch (e) {
      return reply.code(404).send(komunikatDlaOperatora(e));
    }
    return { ok: true };
  });

}
