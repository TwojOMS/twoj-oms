// PRZ-126.C05a: komputery z drukarką faktur (czuwacz deploy/drukarka/czuwacz-faktur.ps1) zgłaszają się przy każdym
// odpytaniu `GET /kolejka-druku-faktur?stanowisko=…`. Zgłoszenia leżą w tabeli `ustawienia` jako mapa
// { "<stanowisko>": "<ISO>" } (db/stanowiska-druku.js). Tu tylko czyste reguły — `teraz` zawsze z argumentu.

/** Stanowisko jest „podłączone”, gdy zgłosiło się w ostatnich 5 minutach (włącznie). */
export const PROG_PODLACZENIA_MIN = 5;
/** Zapis zgłoszenia najwyżej raz na 60 s na stanowisko (czuwacz pyta co 10 s). */
export const DLAWIENIE_S = 60;
/** Mapa nie rośnie bez końca — najstarsze wpisy wypadają. */
export const NAJWIECEJ_STANOWISK = 20;
export const NAJDLUZSZA_NAZWA = 64;

export function nazwaStanowiska(stanowisko) {
  return String(stanowisko ?? '').trim().slice(0, NAJDLUZSZA_NAZWA) || 'bez nazwy';
}

const chwila = (wartosc) => (typeof wartosc === 'string' ? Date.parse(wartosc) : Number.NaN);
const wpis = (mapa, nazwa) => (mapa && Object.hasOwn(mapa, nazwa) ? chwila(mapa[nazwa]) : Number.NaN);

/**
 * @returns {{ podlaczone: boolean, stanowiska: { nazwa: string, at: string, minutTemu: number, aktywne: boolean }[] }}
 *   stanowiska od najświeższego
 */
export function stanStanowisk(mapa, teraz) {
  const t = teraz.getTime();
  const stanowiska = Object.entries(mapa && typeof mapa === 'object' ? mapa : {})
    .map(([nazwa, at]) => ({ nazwa, at, ms: chwila(at) }))
    .filter((s) => Number.isFinite(s.ms))
    .sort((a, b) => b.ms - a.ms)
    .map(({ nazwa, at, ms }) => {
      const roznica = t - ms;
      return { nazwa, at, minutTemu: Math.max(0, Math.floor(roznica / 60_000)),
        aktywne: roznica <= PROG_PODLACZENIA_MIN * 60_000 };
    });
  return { podlaczone: stanowiska.some((s) => s.aktywne), stanowiska };
}

/** Czy zapisać zgłoszenie teraz — fałsz, gdy to stanowisko zapisano mniej niż 60 s temu. */
export function czyZapisac(mapa, stanowisko, teraz) {
  const poprzednie = wpis(mapa, nazwaStanowiska(stanowisko));
  if (!Number.isFinite(poprzednie)) return true;
  const roznica = teraz.getTime() - poprzednie;
  // Zegar cofnięty (wpis „z przyszłości”) — zapis, żeby wpis wrócił do prawdy.
  return roznica < 0 || roznica >= DLAWIENIE_S * 1000;
}

/** Nowa mapa z bieżącym zgłoszeniem; najwyżej NAJWIECEJ_STANOWISK najświeższych wpisów. */
export function dopisz(mapa, stanowisko, teraz) {
  const nowa = { ...(mapa && typeof mapa === 'object' ? mapa : {}), [nazwaStanowiska(stanowisko)]: teraz.toISOString() };
  const ms = (k) => { const v = chwila(nowa[k]); return Number.isFinite(v) ? v : -Infinity; };
  const zostaja = Object.keys(nowa).sort((a, b) => ms(b) - ms(a)).slice(0, NAJWIECEJ_STANOWISK);
  return Object.fromEntries(zostaja.map((k) => [k, nowa[k]]));
}
