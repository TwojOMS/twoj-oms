// SZYBKA ZMIANA CENY KARTY z listy magazynu: ołówek → pole „zł” z ✓/✕ → zapis fetch-em bez przeładowania listy.
//
// Komórka listy (widok wypisuje ją sam, skrypt niczego nie dorysowuje bez niej):
//   <td data-szybka-cena data-adres="/magazyn/12/cena" data-wartosc="99,00">
//     <span data-szybka-cena-kwota>99,00 zł</span>
//     <a href="/magazyn/12?edytuj=dane&wroc=…#dane-karty" data-szybka-cena-olowek
//        aria-label="Zmień cenę: Lampa">✎</a>
//   </td>
// Bez skryptu ołówek jest zwykłym odnośnikiem do edycji karty — lista działa jak bez tej funkcji.
//
// ⚠️ BEZ ELEMENTU <form>. Komórka siedzi w tabeli, którą obejmuje formularz zaznaczania (edycja hurtem);
// formularz w formularzu to błąd HTML, a Enter w polu wysłałby niejawnie TAMTEN formularz. Dlatego Enter
// łapie `keydown` (z `preventDefault`) i omija kompozycję IME (`isComposing`, `keyCode 229` w starszym Safari),
// żeby zatwierdzenie znaku nie wysłało niedokończonej kwoty.
//
// Kwoty skrypt NIE sprawdza ani nie formatuje: parsuje serwer (ten sam parser co karta), a nową kwotę oddaje już
// w formacie listy. Druga reguła w przeglądarce rozjechałaby się z kartą.

/**
 * Zapis ceny na serwerze. Oddaje `{ cena, ostrzezenie }` albo `{ blad }` — nigdy nie rzuca, bo błąd ma trafić
 * pod pole, a nie do konsoli. Odmowy rdzenia (403 uprawnień i CSRF) przychodzą zwykłym tekstem, nie JSON-em.
 */
const SESJA_WYGASLA = 'Sesja wygasła — odśwież stronę.';

export async function zapiszCene(adres, wartosc, pobierz = fetch) {
  let odpowiedz;
  try {
    odpowiedz = await pobierz(adres, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      body: new URLSearchParams({ cena_zl: wartosc }),
    });
  } catch {
    return { blad: 'Brak połączenia z panelem — cena nie została zapisana.' };
  }
  const tekst = await odpowiedz.text().catch(() => '');
  let dane = null;
  try {
    dane = JSON.parse(tekst);
  } catch {
    dane = null;
  }
  if (odpowiedz.ok && dane && typeof dane.cena === 'string') {
    return { cena: dane.cena, ostrzezenie: dane.ostrzezenie || null };
  }
  if (dane && typeof dane.blad === 'string') return { blad: dane.blad };
  // Wygasła sesja wraca jako przekierowanie na logowanie (fetch idzie za nim i dostaje stronę HTML z kodem 200)
  // albo 401 rdzenia. Numer błędu nic tu nie mówi, a odświeżenie strony prowadzi wprost do logowania.
  if (odpowiedz.status === 401 || odpowiedz.redirected || (odpowiedz.ok && !dane)) return { blad: SESJA_WYGASLA };
  if (odpowiedz.status === 403) return { blad: 'Brak uprawnień do zmiany ceny — cena nie została zapisana.' };
  return { blad: `Nie zapisałem ceny (błąd ${odpowiedz.status}).` };
}

// Kwota do pola: ta z listy, bez „zł” i bez odstępów tysięcy („1 234,50” → „1234,50”), żeby wpis wrócił
// do serwera w postaci, którą jego parser przyjmuje.
export const wartoscDoPola = (napis) =>
  String(napis ?? '')
    .replace(/zł/g, '')
    .replace(/\s/g, '');

let otwarta = null;
let licznik = 0;

function zamknij({ fokus = true } = {}) {
  if (!otwarta) return;
  const { komorka, edytor, olowek, kwota } = otwarta;
  edytor.remove();
  kwota.hidden = false;
  olowek.hidden = false;
  delete komorka.dataset.szybkaCenaOtwarta;
  otwarta = null;
  if (fokus) olowek.focus();
}

function element(tag, wlasciwosci = {}, ...dzieci) {
  const el = document.createElement(tag);
  Object.assign(el, wlasciwosci);
  el.append(...dzieci);
  return el;
}

function otworz(komorka) {
  const olowek = komorka.querySelector('[data-szybka-cena-olowek]');
  const kwota = komorka.querySelector('[data-szybka-cena-kwota]');
  if (!olowek || !kwota || !komorka.dataset.adres) return false;
  // Jedna komórka naraz: druga otwarta zamyka pierwszą bez zapisu (jak ✕).
  zamknij({ fokus: false });

  const id = `szybka-cena-${++licznik}`;
  const nazwa = (olowek.getAttribute('aria-label') || 'Zmień cenę').replace(/^Zmień cenę:?\s*/, '');
  const pole = element('input', {
    type: 'text',
    inputMode: 'decimal',
    autocomplete: 'off',
    size: 8,
    value: wartoscDoPola(komorka.dataset.wartosc),
    className: 'szybka-cena__wpis',
  });
  pole.setAttribute('aria-label', nazwa ? `Cena w złotych: ${nazwa}` : 'Cena w złotych');
  pole.setAttribute('enterkeyhint', 'done');
  const blad = element('div', { id: `${id}-blad`, className: 'szybka-cena__blad', hidden: true });
  blad.setAttribute('role', 'alert');
  pole.setAttribute('aria-describedby', blad.id);
  const zapisz = element('button', { type: 'button', className: 'szybka-cena__zapisz', textContent: '✓' });
  zapisz.setAttribute('aria-label', 'Zapisz cenę');
  const anuluj = element('button', { type: 'button', className: 'szybka-cena__anuluj', textContent: '✕' });
  anuluj.setAttribute('aria-label', 'Anuluj zmianę ceny');
  const wiecej = element('a', {
    href: olowek.getAttribute('href') || '#',
    className: 'szybka-cena__wiecej',
    textContent: 'więcej opcji edycji',
  });
  const edytor = element(
    'div',
    { className: 'szybka-cena' },
    element(
      'span',
      { className: 'szybka-cena__wiersz' },
      pole,
      element('span', { textContent: ' zł ' }),
      zapisz,
      anuluj,
    ),
    blad,
    wiecej,
  );
  edytor.setAttribute('role', 'group');
  edytor.setAttribute('aria-label', 'Zmiana ceny');

  let trwa = false;
  const pokazBlad = (tekst) => {
    blad.textContent = tekst;
    blad.hidden = false;
    pole.setAttribute('aria-invalid', 'true');
    pole.focus();
  };
  const wyslij = async () => {
    if (trwa) return;
    trwa = true;
    zapisz.disabled = true;
    const wynik = await zapiszCene(komorka.dataset.adres, pole.value);
    trwa = false;
    zapisz.disabled = false;
    // Komórka mogła zostać zamknięta w czasie zapisu (Esc, inna komórka) — wynik nie ma już czego podmienić
    // w edytorze, ale kwota na liście ma być prawdziwa.
    if (wynik.blad) {
      if (otwarta?.edytor === edytor) pokazBlad(wynik.blad);
      return;
    }
    kwota.textContent = wynik.cena;
    komorka.dataset.wartosc = wynik.cena.replace(/\s*zł$/, '');
    let uwaga = komorka.querySelector('[data-szybka-cena-uwaga]');
    if (wynik.ostrzezenie) {
      if (!uwaga) {
        uwaga = element('div', { className: 'szybka-cena__uwaga' });
        uwaga.dataset.szybkaCenaUwaga = '';
        uwaga.setAttribute('role', 'status');
        komorka.append(uwaga);
      }
      uwaga.textContent = wynik.ostrzezenie;
    } else uwaga?.remove();
    if (otwarta?.edytor === edytor) zamknij();
  };

  pole.addEventListener('input', () => {
    if (blad.hidden) return;
    blad.hidden = true;
    pole.removeAttribute('aria-invalid');
  });
  edytor.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      zamknij();
    } else if (e.key === 'Enter' && e.target === pole) {
      e.preventDefault();
      if (e.isComposing || e.keyCode === 229) return;
      wyslij();
    }
  });
  zapisz.addEventListener('click', wyslij);
  anuluj.addEventListener('click', () => zamknij());

  kwota.hidden = true;
  olowek.hidden = true;
  komorka.dataset.szybkaCenaOtwarta = '';
  komorka.querySelector('[data-szybka-cena-uwaga]')?.remove();
  komorka.append(edytor);
  otwarta = { komorka, edytor, olowek, kwota };
  pole.focus();
  pole.select();
  return true;
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const olowek = e.target instanceof Element ? e.target.closest('[data-szybka-cena-olowek]') : null;
    const komorka = olowek?.closest('[data-szybka-cena]');
    // Klik z modyfikatorem (nowa karta, nowe okno) zostaje zwykłym odnośnikiem do karty.
    if (!komorka || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (otworz(komorka)) e.preventDefault();
  });
}
