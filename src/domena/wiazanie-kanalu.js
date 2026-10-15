// Czyste reguly wiazania kanalu Allegro (device flow, RFC 8628) — BEZ sieci, bez bazy,
// bez konsoli. Wszystko, co da sie orzec bez wyjscia na zewnatrz, siedzi tutaj, dokladnie
// tak jak reszta regul tego modulu (warstwa `domain/` jest czysta i to celowo).
//
// Warstwa I/O to `allegro/wiazanie.js` (petla odpytywania) i `scripts/polacz-allegro.js`
// (argumenty, konsola, potwierdzenie od czlowieka).
//
// ⚠️ NIEZMIENNIK 4.10. Zaden tekst budowany w tym pliku nie ma prawa niesc tokenu ani
// poswiadczen kanalu. Wolno — i trzeba — wypisac `user_code` device flow: czlowiek MUSI
// go przepisac w przegladarce, a bez niego wiazania nie da sie dokonczyc. `user_code` nie
// jest sekretem: sam z siebie nie daje dostepu do niczego, wygasa po kilku minutach
// i dziala wylacznie razem z zalogowanym kontem Allegro.

// Allegro podaje `interval` (sekundy) w odpowiedzi /device. Gdy go nie poda albo poda
// smiec, bierzemy 5 s — wartosc domyslna z RFC 8628.
export const ODSTEP_DOMYSLNY_MS = 5000;
// ⚠️ PODLOGA ODSTEPU. `interval: 0` (albo ujemny) zamienilby petle w zalew zadan do
// Allegro — czyli w cos, co konto obrywa jako naduzycie, a my nie mamy z tego nic.
export const ODSTEP_MIN_MS = 1000;
// Sufit, zeby `slow_down` powtorzony kilkanascie razy nie uspil skryptu na kwadrans.
export const ODSTEP_MAX_MS = 60000;
// RFC 8628: po `slow_down` odstep rosnie o 5 sekund. Nie „×2" — mnoznik rozpedza sie
// wykladniczo i po czterech takich odpowiedziach czlowiek czeka dluzej niz zyje kod.
export const PRZYROST_SLOW_DOWN_MS = 5000;
// Kod device flow Allegro zyje ~10 minut. Gdy odpowiedz nie poda `expires_in`, tyle wlasnie
// dajemy — a nie „bez konca": petla bez granicy czasu to dokladnie ten rodzaj stanu,
// z ktorego nic samo nie wychodzi (niezmiennik 4.9).
export const CZAS_DOMYSLNY_MS = 10 * 60 * 1000;
// Sufit na wypadek `expires_in` o absurdalnej wartosci. Pol godziny to i tak wiecej,
// niz czlowiek przy przegladarce wytrzyma.
export const CZAS_MAX_MS = 30 * 60 * 1000;

// ⚠️ POTKNIECIE SIECI JEST POWODEM, A NIE AWARIA. `fetch` RZUCA, gdy zadanie w ogole nie
// doszlo (ECONNRESET, ENOTFOUND, timeout, zerwane DNS w kontenerze) — i taki wyjatek,
// puszczony w gore, omijal cala te ocene i wywalal skrypt komunikatem „Wiązanie przerwane:
// fetch failed". Czlowiek stal przy przegladarce z waznym kodem, a wiazanie bylo juz
// martwe i trzeba je bylo zaczynac od nowa, z nowym kodem. Tak sie stalo na produkcji
// 2026-08-04, przy pierwszym prawdziwym wiazaniu kanalu.
//
// W trakcie czekania na czlowieka brak sieci jest zdarzeniem PRZEJSCIOWYM, dokladnie jak
// HTTP 502 od proxy: kod device flow dalej zyje, czlowiek dalej ma go przed soba. Dlatego
// `dokonczPowiazanie()` zamienia wyjatek na powod o TYM prefiksie, a powod idzie przez
// `ocenPowod` jak kazdy inny.
//
// ⚠️ NIEZMIENNIK 4.10: w powodzie stoi WYLACZNIE krotki kod przyczyny (`ECONNRESET`),
// nigdy `e.message` ani adres. Wiadomosc z `fetch` potrafi niesc pelny URL, a przy device
// flow w ciele zadania leci `device_code` i naglowek `Authorization: Basic …`.
export const PREFIKS_SIECI = 'sieć';

// ⚠️ GRANICA KOLEJNYCH POTKNIEC — ponawianie NIE MOZE byc nieskonczone. Sześć kolejnych
// nieudanych prob to przy typowym odstepie 5 s okolo POL MINUTY ciszy: dosc, zeby przespac
// mrugniecie DNS-u, restart proxy albo jedno zerwane polaczenie, i za malo, zeby udawac,
// ze cos sie dzieje, gdy siec jest naprawde zerwana.
//
// Krotsza granica (2–3) przerywalaby wiazanie przy pojedynczym potknieciu — czyli robilaby
// dokladnie to, co naprawiamy. Dluzsza (kilkadziesiat) trzymalaby czlowieka przy
// przegladarce az do wygasniecia kodu, konczac to samo `expired_token`, tylko pol godziny
// pozniej i bez powiedzenia mu prawdy: ze panel nie ma jak dosiegnac Allegro.
//
// ⚠️ LICZY SIE KOLEJNE, a nie laczne. Kazda odpowiedz, ktora DOSZLA (nawet
// `authorization_pending` czy HTTP 502), znaczy, ze siec dziala — licznik wraca do zera.
export const LIMIT_POTKNIEC_SIECI = 6;

// Kod przyczyny jest juz przefiltrowany po ksztalcie w `allegro/tokeny.js`; tutaj tylko
// sklejenie. Brak kodu (`fetch failed` bez `cause`) tez ma prawo sie zdarzyc i nie moze
// zamienic powodu w „sieć undefined".
export function powodSieci(kod) {
  return kod ? `${PREFIKS_SIECI} ${kod}` : `${PREFIKS_SIECI} bez kodu`;
}

export function czyPotkniecieSieci(powod) {
  return typeof powod === 'string' && powod.startsWith(`${PREFIKS_SIECI} `);
}

function liczba(wartosc) {
  const n = Number(wartosc);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function odstepStartowyMs(interval) {
  const s = liczba(interval);
  if (s === null) return ODSTEP_DOMYSLNY_MS;
  return Math.min(Math.max(s * 1000, ODSTEP_MIN_MS), ODSTEP_MAX_MS);
}

// `slow_down` znaczy „pytasz za czesto" — i jest OSTRZEZENIEM, nie odmowa. Odpytywanie
// dalej tym samym tempem konczy sie odcieciem, czyli wiazaniem nieudanym z winy skryptu.
export function nastepnyOdstepMs(aktualnyMs, powod) {
  const teraz = liczba(aktualnyMs) ?? ODSTEP_DOMYSLNY_MS;
  if (powod !== 'slow_down') return teraz;
  return Math.min(teraz + PRZYROST_SLOW_DOWN_MS, ODSTEP_MAX_MS);
}

export function limitCzasuMs(expiresIn) {
  const s = liczba(expiresIn);
  if (s === null) return CZAS_DOMYSLNY_MS;
  return Math.min(s * 1000, CZAS_MAX_MS);
}

// ⚠️ KODY, PO KTORYCH NIE MA SENSU PYTAC DALEJ — i tylko one. Reszta powodow (HTTP 5xx,
// cialo, ktore nie jest JSON-em, proxy po drodze) to POTKNIECIE, a nie odmowa: kod device
// flow dalej zyje, czlowiek dalej ma go przed soba, wiec pytamy dalej — az do granicy czasu.
//
// Odwrotna decyzja (przerywac przy czymkolwiek nieznanym) kosztowalaby czlowieka calego
// przejscia przez przegladarke z powodu jednego 502 od proxy Allegro.
const ODMOWY = {
  access_denied:
    'Wiązanie ODRZUCONE w przeglądarce (access_denied) — ktoś kliknął „Nie wyrażam zgody” albo '
    + 'zamknął okno zgody. Para tokenów NIE została zapisana, kanał został dokładnie taki, jaki był.',
  expired_token:
    'Kod wiązania stracił ważność, zanim ktoś go potwierdził (expired_token). Nic się nie stało — '
    + 'uruchom skrypt jeszcze raz i przepisz nowy kod od razu.',
  invalid_grant:
    'Allegro nie uznało kodu wiązania (invalid_grant) — zwykle znaczy to, że kod już wygasł albo '
    + 'został użyty. Uruchom skrypt jeszcze raz.',
  invalid_client:
    'Allegro nie uznało poświadczeń kanału (invalid_client) — clientId albo clientSecret w '
    + 'konfiguracji panelu są złe. Zdefiniuj kanał w OMS_KANALY, a dla jego prefiksu ustaw '
    + 'CLIENT_ID, CLIENT_SECRET, OD i USER_AGENT; '
    + 'ponowne wiązanie NIC tu nie da.',
  invalid_request:
    'Allegro odrzuciło samo zapytanie (invalid_request). To usterka po naszej stronie, a nie '
    + 'sprawa do wyklikania w przeglądarce — zgłoś ją razem z tym komunikatem.',
  unauthorized_client:
    'Aplikacja kanału nie ma prawa do device flow (unauthorized_client) — sprawdź w panelu '
    + 'aplikacji Allegro, czy jest to aplikacja typu „urządzenie” (device flow).',
  unsupported_grant_type:
    'Allegro nie przyjęło tego typu wiązania (unsupported_grant_type) — sprawdź typ aplikacji '
    + 'w panelu Allegro.',
};

// `powod` przychodzi wprost z `dokonczPowiazanie()` (allegro/tokeny.js): kod OAuth
// (`authorization_pending`, `slow_down`, `access_denied`…), „HTTP nnn" albo zdanie
// „odpowiedź bez pary tokenów". Kod OAuth jest tam przepuszczony przez filtr ksztaltu,
// wiec nie ma jak przemycic poswiadczen (niezmiennik 4.10).
export function ocenPowod(powod, kolejnePotkniecia = 0) {
  const opis = Object.prototype.hasOwnProperty.call(ODMOWY, powod) ? ODMOWY[powod] : null;
  if (opis) return { dalej: false, komunikat: opis };
  // ⚠️ JEDYNY POWOD, KTORY WYCZERPUJE SIE Z CZASEM. Reszta „potkniec" ponawia sie az do
  // granicy czasu, bo swiadczy o tym, ze z Allegro rozmawiamy — tyle ze zle. Potkniecie
  // sieciowe swiadczy o czyms przeciwnym: byc moze NIE MA z czym rozmawiac. Odpytywanie
  // do wygasniecia kodu byloby wtedy udawaniem pracy.
  if (czyPotkniecieSieci(powod) && kolejnePotkniecia >= LIMIT_POTKNIEC_SIECI) {
    return { dalej: false, komunikat: komunikatSieci({ kolejne: kolejnePotkniecia, ostatniPowod: powod }) };
  }
  return { dalej: true, komunikat: null };
}

// ⚠️ KOMUNIKAT MA MOWIC PRAWDE: nie „Allegro odmówiło" (nie odmówiło — nie odezwało się
// wcale) i nie „kod wygasł" (nie wygasł — po prostu nie mieliśmy jak zapytać). Tekst niesie
// wylacznie liczbe prob i krotki kod przyczyny (niezmiennik 4.10).
export function komunikatSieci({ kolejne, ostatniPowod } = {}) {
  const ile = Number.isFinite(kolejne) ? kolejne : LIMIT_POTKNIEC_SIECI;
  const kod = ostatniPowod ? ` Ostatnia przyczyna: ${ostatniPowod}.` : '';
  return `NIE MOGĘ DOSIĘGNĄĆ ALLEGRO — ${ile} kolejnych prób pod rząd nie doszło do skutku.`
    + `${kod} Wiązanie PRZERWANE, w bazie nic się nie zmieniło. To nie jest odmowa Allegro `
    + 'ani wygaśnięcie kodu: żądanie nie wyszło z panelu. Sprawdź połączenie sieciowe '
    + '(kontener, DNS, proxy) i uruchom skrypt jeszcze raz — dostaniesz nowy kod.';
}

// Adres, ktory czlowiek ma otworzyc. `verification_uri_complete` niesie kod w adresie
// (jedno klikniecie zamiast przepisywania), ale Allegro nie musi go oddac — wtedy zostaje
// goly adres i kod do przepisania z reki.
export function adresDoPrzegladarki(dane) {
  return dane?.verification_uri_complete || dane?.verification_uri || null;
}

export function instrukcjaDlaCzlowieka({ userCode, adres, limitMs, opisKanalu }) {
  const minuty = Math.max(1, Math.round((limitMs ?? CZAS_DOMYSLNY_MS) / 60000));
  return [
    `Wiązanie kanału ${opisKanalu}:`,
    '',
    `  1. Otwórz w przeglądarce:  ${adres}`,
    '  2. Zaloguj się na TO konto Allegro, którego dotyczy kanał.',
    `  3. Przepisz kod:  ${userCode}`,
    '  4. Potwierdź dostęp.',
    '',
    `Skrypt czeka i sam wykryje potwierdzenie. Kod jest ważny około ${minuty} min.`,
  ].join('\n');
}

// „Do kiedy" liczy sie z tego, co PO ZAPISIE lezy w bazie — a nie z tego, co skrypt sobie
// policzyl przed wyslaniem. Roznica jest istotna: termin waznosci refresh tokena to jedyna
// rzecz, ktora mowi czlowiekowi, kiedy bedzie musial wrocic do tego skryptu.
export function komunikatSukcesu({ zostaloDni, refreshWygasaAt } = {}) {
  const doKiedy = refreshWygasaAt ? String(refreshWygasaAt).slice(0, 10) : null;
  const termin = doKiedy
    ? ` Refresh token jest ważny do ${doKiedy}${Number.isFinite(zostaloDni) ? ` (jeszcze ${zostaloDni} dni)` : ''}.`
    : '';
  return `Kanał POŁĄCZONY — para tokenów zapisana w bazie panelu.${termin}`
    + ' Po tym terminie panel sam z siebie nie wyjdzie: trzeba uruchomić to wiązanie jeszcze raz.';
}

export function komunikatCzasu({ limitMs, ostatniPowod } = {}) {
  const minuty = Math.max(1, Math.round((limitMs ?? CZAS_DOMYSLNY_MS) / 60000));
  const slad = ostatniPowod ? ` Ostatnia odpowiedź Allegro: ${ostatniPowod}.` : '';
  return `Czas na potwierdzenie (${minuty} min) UPŁYNĄŁ — kanał NIE został połączony i nic w bazie `
    + `się nie zmieniło.${slad} Uruchom skrypt jeszcze raz i przepisz kod od razu.`;
}

// ⚠️ ODPOWIEDZ O KSZTALCIE, KTOREGO NIE DA SIE UZYC. Bez `device_code` nie ma czego
// odpytywac, bez `user_code` i adresu czlowiek nie ma czego przepisac — a petla i tak
// chodzilaby do konca limitu, udajac, ze cos robi.
export function sprawdzOdpowiedzDevice(dane) {
  const brakujace = [
    dane?.device_code ? null : 'device_code',
    dane?.user_code ? null : 'user_code',
    adresDoPrzegladarki(dane) ? null : 'verification_uri',
  ].filter(Boolean);
  if (!brakujace.length) return null;
  return 'Allegro odpowiedziało na rozpoczęcie wiązania, ale bez tego, co jest do niego potrzebne '
    + `(brakuje: ${brakujace.join(', ')}). Nic nie zostało zapisane.`;
}

// ⚠️ NAZWA KANALU JEST KLUCZEM KOLUMNY `zamowienia.sklep`, a nie nazwa konta. Literowka nie
// ma prawa zamienic sie w zapisanie pary tokenow pod kluczem, ktorego nikt nigdy nie
// przeczyta — para lezalaby w bazie, kanal dalej byloby „niepolaczony", a skrypt
// twierdzilby, ze wszystko sie udalo.
export function sprawdzNazweKanalu(nazwa, dostepne = []) {
  const lista = [...dostepne];
  if (!lista.length) {
    return 'Panel nie ma ani jednego skonfigurowanego kanału Allegro — kanał wstaje dopiero, gdy '
      + 'zdefiniujesz kanał w OMS_KANALY, a dla jego prefiksu ustawisz CLIENT_ID, CLIENT_SECRET, '
      + 'OD i USER_AGENT. Sprawdź plik .env.oms.';
  }
  const podana = String(nazwa ?? '').trim();
  if (!podana) {
    return `Podaj nazwę kanału jako argument. Skonfigurowane kanały: ${lista.join(', ')}.`;
  }
  if (!lista.includes(podana)) {
    return `Kanał „${podana}” nie istnieje w konfiguracji panelu. Skonfigurowane kanały: `
      + `${lista.join(', ')}. ⚠️ To jest klucz kanału (kolumna zamowienia.sklep), a NIE nazwa konta Allegro.`;
  }
  return null;
}

// Ponowne wiazanie uniewaznia dotychczasowa pare tokenow i tego nie da sie cofnac inaczej
// niz kolejnym przejsciem przez przegladarke. Kanal polaczony ma wiec zapytac, zanim nadpisze.
export function ostrzezenieONadpisaniu(stan) {
  const dni = Number.isFinite(stan?.zostaloDni) ? stan.zostaloDni : null;
  const ile = dni === null ? '' : ` Refresh token jest ważny jeszcze ${dni} dni.`;
  const blad = stan?.ostatniBlad ? ` Ostatni ślad błędu kanału: ${stan.ostatniBlad}` : '';
  return `Kanał ${stan?.kanal ?? ''} JEST JUŻ POŁĄCZONY.${ile}${blad}\n`
    + '⚠️ Ponowne wiązanie NADPISZE dotychczasową parę tokenów i unieważni ją po stronie Allegro. '
    + 'Cofnąć się z tego nie da — trzeba by przejść wiązanie jeszcze raz.';
}

// Zgoda ma byc SLOWEM, nie Enterem: „y" przez pomylke wciska sie samo, „tak" trzeba napisac.
export function potwierdzenieUznane(tekst) {
  return String(tekst ?? '').trim().toLowerCase() === 'tak';
}

// ——————————————————————————————————————————————————————————————————————————————————————
// DRUGA DROGA POTWIERDZENIA: jawny przelacznik wiersza polecen.
//
// ⚠️ PO CO ON JEST. Na produkcji skrypt chodzi przez `sudo /usr/local/bin/docker exec` po
// SSH, a `sudo` zajmuje standardowe wejscie na haslo — TTY nie ma wtedy jak powstac
// i pytania nie ma jak zadac. Dotad znaczylo to, ze kanalu JUZ POLACZONEGO nie dalo sie
// przewiazac w ogole. A przewiazac trzeba, gdy aplikacja dostanie nowe uprawnienie
// (np. `allegro:api:sale:offers:read`), ktorego istniejacy token nie niesie.
//
// ⚠️ PRZELACZNIK JEST DODATKIEM, A NIE ZAMIENNIKIEM PYTANIA. Bez niego wszystko zostaje
// dokladnie jak bylo: z terminalem — pytanie o slowo „tak", bez terminala — odmowa.
// Milczenie dalej NIE JEST zgoda: `docker exec` bez `-it` i bez przelacznika konczy sie
// odmowa, tak samo jak przedtem.
//
// ⚠️ NAZWA MA BYC NIEWYGODNA. `-y` albo `--force` dokleja sie do polecenia odruchowo
// i przezywa w notatce, z ktorej ktos kiedys skopiuje cala linijke. To zdanie trzeba
// napisac swiadomie — a slowo „tak" jest w nim dokladnie tym samym slowem, ktore czlowiek
// pisze przy klawiaturze. Bez ogonkow, bo polecenie przechodzi przez SSH i powloke NAS-a.
export const PRZELACZNIK_NADPISANIA = '--tak-nadpisz-pare-tokenow';

// Cztery drogi, ktorymi moze pojsc kanal przed nadpisaniem pary tokenow.
export const DROGA = {
  // Nie ma czego nadpisywac (kanal niepolaczony) — nie ma tez o co pytac.
  BEZ_PYTANIA: 'bez-pytania',
  // Kanal polaczony, jest terminal: pytamy czlowieka jak dotad.
  PYTANIE: 'pytanie',
  // Kanal polaczony, podano przelacznik: zgoda przyszla z polecenia, nie od klawiatury.
  PRZELACZNIK: 'przelacznik',
  // Kanal polaczony, ani terminala, ani przelacznika: NIC nie zmieniamy.
  ODMOWA: 'odmowa',
};

// ⚠️ DOPASOWANIE MA BYC DOKLADNE. Bez prefiksow, bez `--tak-nadpisz-pare-tokenow=nie`,
// bez skrotow — przelacznik, ktory da sie trafic polowicznie, przestaje byc swiadomy.
export function podanoPrzelacznikNadpisania(argumenty = []) {
  const lista = Array.isArray(argumenty) ? argumenty : [argumenty];
  return lista.some((a) => String(a ?? '').trim() === PRZELACZNIK_NADPISANIA);
}

// Nazwa kanalu to pierwszy argument, ktory NIE jest przelacznikiem — dzieki temu
// `polacz-allegro.js allegro_a --tak-…` i `… --tak-… allegro_a` znacza to samo.
// Sama walidacja nazwy zostaje w `sprawdzNazweKanalu` (osobna decyzja, osobny komunikat).
export function czytajArgumenty(argv = []) {
  const lista = (Array.isArray(argv) ? argv : [argv]).map((a) => String(a ?? ''));
  return {
    nazwa: (lista.find((a) => !a.startsWith('--')) ?? '').trim(),
    przelacznik: podanoPrzelacznikNadpisania(lista),
  };
}

// ⚠️ TU MIESZKA CALA DECYZJA „pytac, odmowic czy dzialac" — i tylko tu. Skrypt jej nie
// powtarza; gdyby powtarzal, dwie kopie rozjechalyby sie przy pierwszej poprawce jednej
// z nich, a rozjazd oznaczalby nadpisanie zywej pary tokenow bez niczyjej zgody.
//
// `dalej` mowi, co robic BEZ pytania: `true` — dzialaj, `false` — przerwij, `null` — to
// dopiero rozstrzygnie czlowiek przy klawiaturze (`potwierdzenieUznane`).
export function ocenDrogePotwierdzenia({ polaczony, przelacznik, terminal } = {}) {
  // ⚠️ PRZELACZNIK NIE MA WPLYWU NA KANAL NIEPOLACZONY. Nie ma tam czego nadpisywac
  // i nie ma o co pytac — a przelacznik, ktory „cos robi" tam, gdzie nie ma ryzyka,
  // uczy reki dopisywac go zawsze.
  if (!polaczony) return { decyzja: DROGA.BEZ_PYTANIA, dalej: true, komunikat: null };
  if (przelacznik) {
    return { decyzja: DROGA.PRZELACZNIK, dalej: true, komunikat: komunikatZgodyZPrzelacznika() };
  }
  if (terminal) return { decyzja: DROGA.PYTANIE, dalej: null, komunikat: null };
  return { decyzja: DROGA.ODMOWA, dalej: false, komunikat: komunikatBrakuDrogiPotwierdzenia() };
}

// ⚠️ W LOGU OPERACJI MA BYC WIDAC, KTORA DROGA PODJETO DECYZJE. Nadpisanie pary tokenow
// z przelacznika wyglada w wyjsciu identycznie jak nadpisanie potwierdzone przez czlowieka —
// a to nie jest to samo zdarzenie. Kto szuka pozniej „kto na to pozwolil", ma znalezc
// odpowiedz w tym samym miejscu, w ktorym stoi ostrzezenie.
export function komunikatZgodyZPrzelacznika() {
  return `⚠️ Zgoda przyszła Z PRZEŁĄCZNIKA ${PRZELACZNIK_NADPISANIA}, a NIE od człowieka `
    + 'przy klawiaturze — nikt nie został o nic zapytany. Nadpisuję parę tokenów.';
}

// ⚠️ ODMOWA MA WYMIENIC OBIE DROGI. Sam komunikat „brak terminala" wysylal czlowieka po
// `-it` — a tam, gdzie `sudo` zajmuje standardowe wejscie na haslo, `-it` nie pomaga
// i droga sie konczy. Zdanie musi wiec pokazac obie: terminal ALBO przelacznik.
export function komunikatBrakuDrogiPotwierdzenia() {
  return '⚠️ Nie ma jak potwierdzić nadpisania: brak terminala (stdin nie jest TTY), a '
    + 'przełącznika też nie podano. NIC NIE ZOSTAŁO ZMIENIONE — para tokenów została taka, jaka była.\n'
    + 'Są dwie drogi, obie świadome — wybierz jedną:\n'
    + '  1. z terminalem: dołóż „-it” do polecenia '
    + '(docker exec -it panel-oms node /app/scripts/polacz-allegro.js <kanał>) i napisz „tak”;\n'
    + `  2. bez terminala: dopisz do polecenia ${PRZELACZNIK_NADPISANIA} — to jest to samo `
    + 'świadome „tak”, tyle że zapisane w poleceniu.';
}
