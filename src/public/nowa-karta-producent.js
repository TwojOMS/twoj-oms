// Pole „Producent” w formularzu „Nowy produkt”: producent wynika z marki, więc po wyborze albo wpisaniu
// marki pole pokazuje, kto nim będzie. Tylko podgląd — formularz producenta nie wysyła ani nie zapisuje.
//
// Dane (marka → nazwa producenta i producent domyślny) podaje serwer w `data-producenci`; teksty są te
// same co w stanie, który serwer renderuje bez JavaScriptu (pilnują tego testy obu stron).

export const ADRES_PRODUCENTOW = '/magazyn/producenci';
const LINK = 'przypisz w Magazyn → Producenci';

/**
 * @param {string} marka — marka po przycięciu; pusta = nie wybrano.
 * @param {{ marki?: Record<string, string>, domyslny?: string | null }} dane
 * @returns {{ tekst: string, link: boolean }} `link` — po tekście idzie odnośnik do ekranu producentów.
 */
export function stanProducenta(marka, dane) {
  if (!marka) return { tekst: 'Wybierz markę — producent wynika z marki.', link: false };
  const marki = dane?.marki ?? {};
  const zMarki = Object.hasOwn(marki, marka) ? marki[marka] : null;
  if (zMarki) return { tekst: `Producent: ${zMarki} (z marki ${marka})`, link: false };
  if (dane?.domyslny) return { tekst: `Producent: ${dane.domyslny} (producent domyślny)`, link: false };
  return { tekst: 'Marka bez producenta — ', link: true };
}

function odczytajDane(surowe) {
  try {
    const dane = JSON.parse(surowe ?? '');
    return dane && typeof dane === 'object' ? dane : {};
  } catch {
    return {};
  }
}

/** @param {Document} dokument */
export function podepnij(dokument) {
  const pole = dokument.getElementById('nowa-producent');
  const wybor = dokument.querySelector('select[name="marka"]');
  const wpis = dokument.querySelector('input[name="marka_nowa"]');
  if (!pole) return;
  const dane = odczytajDane(pole.dataset.producenci);
  // Jak serwer przy zapisie: wpisana nowa marka wygrywa z wyborem z listy.
  const biezacy = () => stanProducenta((wpis?.value ?? '').trim() || (wybor?.value ?? '').trim(), dane);
  const kluczStanu = (stan) => `${stan.tekst}${stan.link ? LINK : ''}`;
  // Stan wyrenderowany przez serwer zostaje nietknięty: zmiana treści zaraz po wczytaniu ogłosiłaby się
  // czytnikowi ekranu, choć człowiek niczego jeszcze nie zmienił.
  let pokazane = pole.textContent?.trim() ?? '';

  const odswiez = () => {
    const stan = biezacy();
    const klucz = kluczStanu(stan);
    // Ten sam tekst nie trafia drugi raz do regionu aria-live — pisanie nowej marki nie ogłasza się co literę.
    if (klucz === pokazane) return;
    pokazane = klucz;
    if (!stan.link) return pole.replaceChildren(stan.tekst);
    const a = dokument.createElement('a');
    a.href = ADRES_PRODUCENTOW;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = LINK;
    pole.replaceChildren(stan.tekst, a);
  };

  wybor?.addEventListener('change', odswiez);
  wpis?.addEventListener('input', odswiez);
  odswiez();
}

if (typeof document !== 'undefined') podepnij(document);
