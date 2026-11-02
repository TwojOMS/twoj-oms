// PRZ-121.02: Ustawienia → Integracje → Moduł faktur. Wybór modułu: Brak, inFakt, Fakturownia (wkrótce), TwojeFaktury
// (wkrótce). Reguła, lista i zdania — domena/wybor-programu.js; zapis — oms/db/wybor-programu.js (wiersz
// „program_fakturowy”, bez migracji).
//
// Dostęp: strażnik po prefiksie `/ustawienia` wpuszcza konto z uprawnieniem „ustawienia” — takie konto widzi ekran
// tylko do odczytu. Zapis tylko admin (wyłączenie faktur dotyczy całej firmy). Wybór z pliku (OMS_PROGRAM_FAKTUROWY)
// wygrywa: pola nieaktywne, zapis 409. Zmiana działa po ponownym uruchomieniu OMS-u (usługi składają się raz).
// ⚠️ Klucz API nie trafia tu nigdy: ekran dostaje tylko informację, skąd klucz jest (plik / zapis / brak).
// Nazwa programu fakturowego idzie przez `odmianaNazwyProgramu`/`ekranProgramu` (strażnik nazw PRZ-118.10).
import { odmianaNazwyProgramu, ekranProgramu } from '../../../domena/nazwa-programu.js';
import { tytulEkranuDlaAdresu, EKRAN_KSEF_SPRZEDAZY } from '../../../domena/ekrany.js';
import { MODULY_FAKTUR, modulDostepny, EKRAN_WYBORU_PROGRAMU, ZMIENNA_PROGRAMU, etykietaModulu, sprawdzFormularzWyboru,
  zdanieCzekaniaNaRestart } from '../../../domena/wybor-programu.js';
import { zapiszWyborProgramu, liczbaDokumentowWgProgramu } from '../../../oms/db/wybor-programu.js';
import { nawigacjaUstawien } from '../../ustawienia/nawigacja.js';
import { PROG_UWAGI_KOPII_H } from '../../../domena/ostrzezenia.js';
import { czyFakturaDlaKazdego, zapiszFakturaDlaKazdego, ZDANIE_KASA } from '../db/faktury-dla-kazdego.js';
import { czyWysylacKonsumenckie } from '../db/ksef-konsumenckie.js';
// B16c/B16d: nośnik kopii ustawiony, ale kopia nie trafia na niego (zdania jak w tabelce ostrzeżeń, krócej).
const UWAGI_NOSNIKA = {
  'brak-nosnika': 'Kopia poza dyskiem nie trafia na nośnik — podłącz nośnik kopii.',
  'ten-sam-dysk': 'Kopia poza dyskiem leży na dysku serwera — nośnik kopii nie jest zamontowany.',
  'stara-na-nosniku': 'Na nośniku kopii brak kopii z ostatnich 48 h — sprawdź Kopie zapasowe.',
};

const KOMUNIKATY = { zapisano: 'Zapisano wybór modułu faktur.', dlaKazdego: 'Zapisano ustawienie wystawiania faktur.' };
const ADRES_DLA_KAZDEGO = `${EKRAN_WYBORU_PROGRAMU}/dla-kazdego`;
export const BLAD_WLACZENIA_BEZ_KSEF = 'Nie można włączyć: przy TwojeFaktury faktury dla osób bez NIP-u idą do klienta dopiero z numerem KSeF. Najpierw włącz wysyłkę faktur konsumenckich do KSeF.';

// Zdanie pod polem, co moduł robi. Moduł bez wpisu (dziś inFakt) opisuje stan klucza.
const OPISY = {
  brak: 'OMS nie wystawia faktur. Proformy działają dalej.',
  fakturownia: 'Wystawianie faktur w Fakturowni.',
  twojefaktury: 'OMS sam wystawia faktury i wysyła je do KSeF, bez zewnętrznego programu.',
};

const jednostka = (n) => (n === 1 ? 'jedna' : n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14) ? 'kilka' : 'wiele');

/**
 * Ostrzeżenie przy przejściu z programu na „Brak”: ile dokumentów zostaje w programie. `gdzie` — miejscownik bez „w”
 * („inFakcie”, „programie „X””).
 */
export function zdanieOPrzelaczeniu(ile, gdzie) {
  const j = jednostka(ile);
  const poczatek = j === 'jedna' ? `W OMS-ie jest ${ile} faktura wystawiona`
    : j === 'kilka' ? `W OMS-ie są ${ile} faktury wystawione` : `W OMS-ie jest ${ile} faktur wystawionych`;
  const co = j === 'jedna' ? 'jej PDF-a' : 'ich PDF-ów';
  return `${poczatek} w ${gdzie}. Po przełączeniu OMS nie pobierze ${co} ani nie wyśle do KSeF — ${j === 'jedna' ? 'zostaje' : 'zostają'} w ${gdzie}.`;
}

const odmowaAdmina = (reply) => reply.code(403).view('brak-dostepu.ejs', { title: 'Brak dostępu', wlasnyUklad: true });

// PRZ-121.06: przycisk „Uruchom OMS ponownie” (OMS_RESTART_Z_PANELU). `tak` — proces ma nadzorcę, który go podniesie
// (Docker `restart: unless-stopped`): przycisk działa. `atrapa` (demo publiczne) — przycisk widoczny, nieaktywny.
// Brak zmiennej albo inna wartość — bez przycisku (to nie błąd startu), zamiast niego zdanie z poleceniem.
export const ZMIENNA_RESTARTU = 'OMS_RESTART_Z_PANELU';
export const ADRES_RESTARTU = `${EKRAN_WYBORU_PROGRAMU}/restart`;
const SEKUNDY_ODSWIEZENIA = 10;
export function trybRestartu(wartosc) {
  const w = String(wartosc ?? '').trim().toLowerCase();
  return w === 'tak' || w === 'atrapa' ? w : null;
}

/**
 * `restart` — `{ tryb: 'tak' | 'atrapa' | null, zakoncz, log }`; `zakoncz` to szew ubicia procesu (w produkcji SIGTERM
 * do siebie: main.ts zamyka łagodnie, Docker podnosi kontener).
 */
export function registerUstawieniaProgramuRoutes(app, { db, wyborProgramu, konfiguracjaInfaktu: k, program = null, proba = false, zgoda = false, restart = /** @type {any} */ (null), kopie = /** @type {any} */ (null) }) {
  const programKlucza = program?.opis?.id === k.idModulu ? program : null;
  const nazwa = odmianaNazwyProgramu(programKlucza);
  const tryb = restart?.tryb ?? null;

  function model(req) {
    const dziala = { program: wyborProgramu.program, zrodlo: wyborProgramu.zrodlo, uwaga: wyborProgramu.uwaga };
    const zapisany = wyborProgramu.teraz();
    const zPliku = dziala.zrodlo === 'plik';
    const moznaZmieniac = req.konto?.admin === true && !zPliku;

    let zrodlo;
    if (zPliku) zrodlo = `Ustawione w pliku konfiguracji (${ZMIENNA_PROGRAMU}) — tam to zmienisz.`;
    else if (dziala.zrodlo === 'ustawienia') zrodlo = 'Wybrane w tym ekranie.';
    else zrodlo = dziala.program === 'brak' ? 'Nic nie wybrano i żaden program nie jest podłączony.'
      : 'Nic nie wybrano. OMS używa tego modułu, bo jest podłączony.';

    // Zmiana czeka na restart tylko wtedy, gdy to wybór człowieka (jak w Zdrowiu).
    const czeka = zapisany.zrodlo !== 'domyslny' && !zPliku
      ? zdanieCzekaniaNaRestart(dziala, zapisany, { gotowy: wyborProgramu.gotowy?.() ?? true }) : null;

    const stanKlucza = k.atrapa ? 'niepotrzebny — działa atrapa piaskownicy' : k.zEnv ? 'w pliku konfiguracji' : k.kluczZapisany?.() ? 'zapisany w Ustawieniach' : 'nie wpisany';
    const liczby = dziala.program === 'brak' ? {} : liczbaDokumentowWgProgramu(db);
    const ile = liczby[dziala.program] ?? 0;
    const gdzie = dziala.program === k.idModulu ? nazwa.miejscownik : `programie „${etykietaModulu(dziala.program)}”`;

    let stanKopii = null;
    try { stanKopii = kopie?.() ?? null; } catch { /* ekran działa także bez usługi */ }
    const ostrzezenieKopii = !stanKopii || proba ? null : stanKopii.brakNadzoru || !stanKopii.katalogDostepny
      ? 'Ten OMS nie widzi kopii bazy — sprawdź Kopie zapasowe.'
      : !stanKopii.ostatnia ? 'Brak kopii bazy w katalogu kopii.'
        : stanKopii.ostatnia.wiekH >= PROG_UWAGI_KOPII_H ? `Ostatnia kopia ma ${stanKopii.ostatnia.wiekH} h — sprawdź Kopie zapasowe.`
          : !stanKopii.zewnetrzna ? 'Kopia poza dyskiem nie jest ustawiona — sprawdź Kopie zapasowe.'
            : UWAGI_NOSNIKA[stanKopii.zewnetrznaStan] ?? null;
    const pola = MODULY_FAKTUR.map((m) => ({
      id: m.id, etykieta: m.etykieta, wkrotce: !modulDostepny(m, { zgoda }), zaznaczone: m.id === zapisany.program,
      nieaktywne: !modulDostepny(m, { zgoda }) || !moznaZmieniac,
      opis: m.id === k.idModulu ? `Klucz API ${nazwa.dopelniacz}: ${stanKlucza}.`
        : m.id === 'twojefaktury' && zgoda ? 'OMS sam wystawia faktury i wysyła je do KSeF — token KSeF wpiszesz w Ustawienia → Integracje → KSeF (ten sam co do kosztów).' : (OPISY[m.id] ?? null),
      odnosnik: m.id === k.idModulu ? { adres: ekranProgramu(programKlucza), tekst: `Ustawienia ${nazwa.dopelniacz}` }
        // PRZ-123.C04b: zgoda na wysyłkę do KSeF faktur TwojeFaktury (bez zgody instalacji — „wkrótce”, bez odnośnika).
        : m.id === 'twojefaktury' && zgoda ? { adres: EKRAN_KSEF_SPRZEDAZY, tekst: 'Wysyłka do KSeF' } : null,
      kopia: m.id === 'twojefaktury' ? 'Faktury są tylko w bazie tego OMS-u. Kopia bazy musi trafiać poza ten dysk — instrukcja: Kopie zapasowe.' : null,
      ostrzezenie: m.id === 'twojefaktury' ? ostrzezenieKopii : m.id === 'brak' && ile > 0 ? zdanieOPrzelaczeniu(ile, gdzie) : null,
    }));
    // Przycisk tylko przy zdaniu o czekaniu na restart i tylko dla admina; bez nadzorcy — zdanie z poleceniem.
    const ponowneUruchomienie = !czeka ? null
      : tryb ? (req.konto?.admin === true ? { adres: ADRES_RESTARTU, nieaktywny: tryb !== 'tak' } : null)
        : { recznie: true };
    return { dziala: { etykieta: etykietaModulu(dziala.program), zrodlo }, czeka, ponowneUruchomienie,
      serie: zgoda && dziala.program === 'twojefaktury',
      dlaKazdego: { adres: ADRES_DLA_KAZDEGO, wlaczone: czyFakturaDlaKazdego(db),
        moznaZmieniac: req.konto?.admin === true, zdanieKasa: ZDANIE_KASA, bladWlaczenia: BLAD_WLACZENIA_BEZ_KSEF,
        ostrzezeniePdf: dziala.program === 'twojefaktury' && !czyWysylacKonsumenckie(db) },
      uwaga: zapisany.uwaga ?? dziala.uwaga, pola, moznaZmieniac, zPliku, adres: EKRAN_WYBORU_PROGRAMU };
  }

  function widok(req, reply, { bledy = [] } = {}) {
    return reply.view('ustawienia-programu.ejs', {
      nawigacja: nawigacjaUstawien(req, reply), title: tytulEkranuDlaAdresu(req.url),
      zapisano: KOMUNIKATY[req.query?.zapisano] ?? null, bledy, ekran: model(req),
    });
  }

  app.get(EKRAN_WYBORU_PROGRAMU, async (req, reply) => widok(req, reply));
  app.get('/ustawienia/faktury/zasady', async (req, reply) => widok(req, reply));
  app.get('/ustawienia/faktury/numeracja', async (req, reply) => {
    if (zgoda && wyborProgramu.program === 'twojefaktury') return reply.redirect(`${EKRAN_WYBORU_PROGRAMU}/serie`);
    return reply.view('ustawienia-faktury-mozliwosci.ejs', { nawigacja: nawigacjaUstawien(req, reply), title: 'Numeracja',
      rodzaj: 'numeracja', program: wyborProgramu.program });
  });
  app.get('/ustawienia/faktury/ksef', async (req, reply) => {
    if (zgoda && wyborProgramu.program === 'twojefaktury') return reply.redirect(EKRAN_KSEF_SPRZEDAZY);
    return reply.view('ustawienia-faktury-mozliwosci.ejs', { nawigacja: nawigacjaUstawien(req, reply), title: 'KSeF',
      rodzaj: 'ksef', program: wyborProgramu.program });
  });

  app.post(ADRES_DLA_KAZDEGO, async (req, reply) => {
    if (req.konto?.admin !== true) return odmowaAdmina(reply);
    const body = req.body ?? {};
    const wartosc = body.dlaKazdego;
    if (typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((klucz) => klucz !== 'dlaKazdego')
      || (wartosc !== undefined && wartosc !== 'tak')) {
      reply.code(400);
      return widok(req, reply, { bledy: ['Nieprawidłowa wartość pola wystawiania faktur.'] });
    }
    // PRZ-126 DRB: odmowa tylko przy WŁĄCZANIU — „Zapisz” bez zmian przy opcji już włączonej nie daje 400.
    if (wartosc === 'tak' && !czyFakturaDlaKazdego(db) && wyborProgramu.program === 'twojefaktury' && !czyWysylacKonsumenckie(db)) {
      reply.code(400);
      return widok(req, reply, { bledy: [BLAD_WLACZENIA_BEZ_KSEF] });
    }
    zapiszFakturaDlaKazdego(db, wartosc === 'tak');
    return reply.code(303).redirect('/ustawienia/faktury/zasady?zapisano=dlaKazdego');
  });

  app.post(EKRAN_WYBORU_PROGRAMU, async (req, reply) => {
    if (req.konto?.admin !== true) return odmowaAdmina(reply);
    if (wyborProgramu.zrodlo === 'plik') {
      return reply.code(409).type('text/plain; charset=utf-8')
        .send(`Moduł faktur jest ustawiony w pliku konfiguracji (${ZMIENNA_PROGRAMU}) — tam go zmień. Formularz niczego nie zapisał.`);
    }
    const { ustawienia, bledy } = sprawdzFormularzWyboru(req.body ?? {}, { zgoda });
    if (bledy.length) {
      reply.code(400);
      return widok(req, reply, { bledy });
    }
    const konto = req.konto ? { id: req.konto.id ?? null, login: req.konto.login ?? null } : null;
    zapiszWyborProgramu(db, ustawienia.program, { konto, zgoda });
    return reply.code(303).redirect(`${EKRAN_WYBORU_PROGRAMU}?zapisano=zapisano`);
  });

  // PRZ-121.06: ponowne uruchomienie OMS-u z panelu — tylko admin, tylko przy OMS_RESTART_Z_PANELU=tak (atrapa demo
  // i brak zmiennej: 404, nic się nie dzieje). Ochrona formularza (Origin) jak przy każdym POST panelu.
  app.post(ADRES_RESTARTU, async (req, reply) => {
    if (req.konto?.admin !== true) return odmowaAdmina(reply);
    if (tryb !== 'tak') {
      return reply.code(404).type('text/plain; charset=utf-8')
        .send(`Ponowne uruchomienie z panelu jest wyłączone (${ZMIENNA_RESTARTU}) — uruchom ponownie OMS na serwerze.`);
    }
    restart.log(`PRZ-121.06: ponowne uruchomienie OMS-u z panelu (Moduł faktur) — zlecił ${req.konto.login ?? 'nieznane konto'}`);
    // Sygnał dopiero po wysłaniu całej odpowiedzi (i w następnym obrocie pętli) — przeglądarka dostaje stronę z odświeżeniem.
    reply.raw.once('finish', () => setImmediate(() => restart.zakoncz()));
    return reply.view('brak-dostepu.ejs', { title: 'OMS uruchamia się ponownie', wlasnyUklad: true, restart: true,
      odswiez: { sekundy: SEKUNDY_ODSWIEZENIA, adres: EKRAN_WYBORU_PROGRAMU } });
  });
}
