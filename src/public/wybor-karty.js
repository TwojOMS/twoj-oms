function podswietlNazwe(element, nazwa, fraza) {
  const poczatek = nazwa.toLocaleLowerCase('pl').indexOf(fraza.toLocaleLowerCase('pl'));
  if (poczatek < 0) {
    element.textContent = nazwa;
    return;
  }
  const koniec = poczatek + fraza.length;
  const znak = document.createElement('mark');
  znak.textContent = nazwa.slice(poczatek, koniec);
  element.append(nazwa.slice(0, poczatek), znak, nazwa.slice(koniec));
}

function wierszPodpowiedzi(karta, fraza, id) {
  const wiersz = document.createElement('div');
  wiersz.id = id;
  wiersz.setAttribute('role', 'option');
  wiersz.setAttribute('aria-selected', 'false');
  wiersz.className = 'wybor-karty-opcja';

  const miniatura = document.createElement('span');
  miniatura.className = 'wybor-karty-miniatura';
  miniatura.setAttribute('aria-hidden', 'true');
  if (karta.miniatura) {
    const obraz = document.createElement('img');
    obraz.alt = '';
    obraz.width = 48;
    obraz.height = 48;
    obraz.loading = 'lazy';
    obraz.addEventListener('error', () => obraz.remove(), { once: true });
    obraz.src = karta.miniatura;
    miniatura.append(obraz);
  }

  const tresc = document.createElement('span');
  tresc.className = 'wybor-karty-opis';
  const nazwa = document.createElement('span');
  nazwa.className = 'wybor-karty-nazwa';
  podswietlNazwe(nazwa, karta.nazwa, fraza);
  const dane = document.createElement('span');
  dane.className = 'wybor-karty-dane';
  dane.textContent = [
    karta.sku,
    karta.ean,
    karta.wymiary,
    karta.cena,
    '#' + karta.id,
    karta.wycofana ? 'wycofana' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  dane.title = dane.textContent;
  tresc.append(nazwa, dane);
  wiersz.append(miniatura, tresc);
  return wiersz;
}

function uruchomWyborKart(kontener, status) {
  const pole = kontener.querySelector('[role="combobox"]');
  const poleId = kontener.querySelector('input[type="hidden"]');
  const okno = kontener.querySelector('.wybor-karty-okno');
  const lista = okno.querySelector('[role="listbox"]');
  const komunikat = okno.querySelector('.wybor-karty-komunikat');
  const kotwica = typeof okno.showPopover === 'function' && CSS.supports('position-area: block-end');
  if (kotwica) {
    const nazwaKotwicy = '--' + lista.id;
    pole.style.setProperty('anchor-name', nazwaKotwicy);
    okno.style.setProperty('position-anchor', nazwaKotwicy);
    okno.setAttribute('popover', 'manual');
  }
  pole.removeAttribute('list');
  pole.placeholder = 'wpisz nazwę karty, SKU lub EAN';

  let karty = [];
  let aktywna = -1;
  let opoznienie;
  let zapytanie;

  function ustawPolozenie() {
    const { top, right, bottom } = pole.getBoundingClientRect();
    const szerokosc = document.documentElement.clientWidth;
    const wysokosc = document.documentElement.clientHeight;
    const x = Math.max(8, Math.min(right, szerokosc - 8) - okno.offsetWidth);
    const y =
      bottom + okno.offsetHeight > wysokosc - 8 && top > wysokosc - bottom
        ? Math.max(8, top - okno.offsetHeight)
        : bottom;
    okno.style.left = x + 'px';
    okno.style.top = y + 'px';
  }

  function zamknij() {
    clearTimeout(opoznienie);
    zapytanie?.abort();
    zapytanie = null;
    if (!okno.hidden) {
      if (kotwica) okno.hidePopover();
      else {
        window.removeEventListener('scroll', ustawPolozenie, true);
        window.removeEventListener('resize', ustawPolozenie);
        kontener.append(okno);
      }
    }
    okno.hidden = true;
    pole.setAttribute('aria-expanded', 'false');
    pole.removeAttribute('aria-activedescendant');
    status.textContent = '';
    lista.replaceChildren();
    karty = [];
    aktywna = -1;
  }

  function pokaz(wyniki, fraza, wiadomosc = '') {
    karty = wyniki;
    lista.replaceChildren(...karty.map((karta, indeks) => wierszPodpowiedzi(karta, fraza, lista.id + '-' + indeks)));
    lista.hidden = !karty.length;
    komunikat.hidden = !wiadomosc;
    komunikat.textContent = wiadomosc;
    status.textContent = wiadomosc;
    okno.hidden = false;
    pole.setAttribute('aria-expanded', String(Boolean(karty.length)));
    if (kotwica) okno.showPopover();
    else {
      document.body.append(okno);
      ustawPolozenie();
      window.addEventListener('scroll', ustawPolozenie, true);
      window.addEventListener('resize', ustawPolozenie);
    }
  }

  function szukaj(odRazu = false) {
    zamknij();
    const fraza = pole.value.trim();
    if ([...fraza].length < 2) return;
    opoznienie = setTimeout(
      async () => {
        const kontroler = new AbortController();
        zapytanie = kontroler;
        const adres = new URL(kontener.dataset.wyborKarty, document.baseURI);
        adres.searchParams.set('q', fraza);
        adres.searchParams.set('limit', '20');
        try {
          const odpowiedz = await fetch(adres, { signal: kontroler.signal });
          if (!odpowiedz.ok) throw new Error();
          const wyniki = await odpowiedz.json();
          if (zapytanie !== kontroler || pole.value.trim() !== fraza) return;
          pokaz(wyniki, fraza, wyniki.length ? '' : 'Nie znalazłem karty dla „' + fraza + '” — sprawdź nazwę albo SKU');
        } catch {
          if (zapytanie === kontroler) pokaz([], fraza, 'Nie udało się pobrać podpowiedzi kart.');
        } finally {
          if (zapytanie === kontroler) zapytanie = null;
        }
      },
      odRazu ? 0 : 200,
    );
  }

  function wybierz(indeks) {
    const karta = karty[indeks];
    pole.value = karta.nazwa;
    poleId.value = karta.id;
    zamknij();
  }

  // Przeglądarka potrafi przywrócić ukryte id po przeładowaniu, a pole tekstowe (autocomplete=off) nie.
  if (!pole.value.trim()) poleId.value = '';

  pole.addEventListener('input', (zdarzenie) => {
    poleId.value = '';
    if (zdarzenie.isComposing) zamknij();
    else szukaj();
  });
  pole.addEventListener('compositionend', () => szukaj());
  pole.addEventListener('blur', zamknij);
  pole.form?.addEventListener('reset', zamknij);
  // Kliknięcie opcji zachowuje fokus w polu, także gdy listbox jest poza tabelą.
  okno.addEventListener('mousedown', (zdarzenie) => zdarzenie.preventDefault());
  lista.addEventListener('click', (zdarzenie) => {
    const opcja = zdarzenie.target.closest('[role="option"]');
    if (opcja) wybierz([...lista.children].indexOf(opcja));
  });
  pole.addEventListener('keydown', (zdarzenie) => {
    if (zdarzenie.isComposing) return;
    if (zdarzenie.key === 'Escape') {
      if (!okno.hidden) zdarzenie.preventDefault();
      zamknij();
    } else if (zdarzenie.key === 'Enter' && aktywna >= 0) {
      zdarzenie.preventDefault();
      wybierz(aktywna);
    } else if (zdarzenie.key === 'ArrowDown' || zdarzenie.key === 'ArrowUp') {
      if (!karty.length) {
        if (okno.hidden && [...pole.value.trim()].length >= 2) {
          zdarzenie.preventDefault();
          szukaj(true);
        }
        return;
      }
      zdarzenie.preventDefault();
      const wDol = zdarzenie.key === 'ArrowDown';
      lista.children[aktywna]?.setAttribute('aria-selected', 'false');
      aktywna = wDol ? Math.min(aktywna + 1, karty.length - 1) : aktywna <= 0 ? karty.length - 1 : aktywna - 1;
      const opcja = lista.children[aktywna];
      opcja.setAttribute('aria-selected', 'true');
      pole.setAttribute('aria-activedescendant', opcja.id);
      opcja.scrollIntoView({ block: 'nearest' });
    }
  });
}

const status = document.querySelector('[data-wybor-karty-status]');
for (const kontener of document.querySelectorAll('[data-wybor-karty]')) uruchomWyborKart(kontener, status);
