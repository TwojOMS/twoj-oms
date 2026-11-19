// GALERIA NA KARCIE PRODUKTU — przeciąganie, zapis kolejności bez przeładowania, potwierdzenie usunięcia, powiększenie.
//
// Szablon `_karta-galeria.ejs` działa bez tego skryptu: każda akcja to zwykły formularz. Skrypt przechwytuje te same
// formularze i wysyła je z `Accept: application/json`, więc serwer ma jedną drogę zapisu. Kolejność zawsze idzie jako
// PEŁNA permutacja (pola `kolejnosc`) — serwer odrzuca ją (409), gdy galeria zmieniła się w innej karcie przeglądarki,
// i wtedy wracamy do poprzedniego ułożenia.
//
// Przeciąganie (mysz, pióro) ma zamiennik bez ruchu wskaźnikiem: menu „⋯” z „Przesuń w lewo / w prawo / Ustaw jako
// główne” (WCAG 2.5.7). Dotyk przewija stronę jak zwykle — kolejność zmienia się wtedy przez to samo menu.

export function przesun(ids, id, kierunek) {
  const wynik = [...ids];
  const i = wynik.indexOf(id);
  const j = i + (kierunek === 'lewo' ? -1 : 1);
  if (i < 0 || j < 0 || j >= wynik.length) return wynik;
  [wynik[i], wynik[j]] = [wynik[j], wynik[i]];
  return wynik;
}

export function ustawGlowne(ids, id) {
  return ids.includes(id) ? [id, ...ids.filter((x) => x !== id)] : [...ids];
}

export function przeniesPrzed(ids, id, celId, po) {
  if (id === celId || !ids.includes(id) || !ids.includes(celId)) return [...ids];
  const reszta = ids.filter((x) => x !== id);
  reszta.splice(reszta.indexOf(celId) + (po ? 1 : 0), 0, id);
  return reszta;
}

// Cel liczymy z układu (najbliższy środek miniatury), nie z elementu pod kursorem: miniatury stoją w siatce
// z odstępami, a kursor w przerwie też ma wskazywać miejsce.
export function celUpuszczenia(prostokaty, x, y) {
  let najlepszy = null;
  prostokaty.forEach((p, indeks) => {
    const sx = p.left + p.width / 2;
    const sy = p.top + p.height / 2;
    const odleglosc = Math.hypot(x - sx, y - sy);
    if (!najlepszy || odleglosc < najlepszy.odleglosc) najlepszy = { indeks, po: x > sx, odleglosc };
  });
  return najlepszy && { indeks: najlepszy.indeks, po: najlepszy.po };
}

async function wyslijFormularz(adres, pola, wyslij, bladSieci) {
  let odpowiedz;
  try {
    odpowiedz = await wyslij(adres, {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: new URLSearchParams(pola),
      credentials: 'same-origin',
    });
  } catch {
    throw new Error(bladSieci);
  }
  const dane = await odpowiedz.json().catch(() => ({}));
  if (!odpowiedz.ok) throw new Error(dane.blad || `Serwer odpowiedział kodem ${odpowiedz.status}.`);
  return dane;
}

export async function zapiszKolejnosc(adres, ids, wyslij = globalThis.fetch) {
  const pola = ids.map((id) => ['kolejnosc', String(id)]);
  const dane = await wyslijFormularz(adres, pola, wyslij, 'Nie udało się zapisać kolejności — sprawdź połączenie.');
  return dane.kolejnosc ?? ids;
}

export async function zapiszAi(adres, ai, wyslij = globalThis.fetch) {
  const pola = ai ? [['ai', '1']] : [];
  const dane = await wyslijFormularz(adres, pola, wyslij, 'Nie udało się zapisać znacznika AI — sprawdź połączenie.');
  return dane.ai;
}

// Stan kolejności: najpierw pokazuje nowe ułożenie (operator widzi efekt od razu), potem zapisuje; przy odmowie
// wraca do ułożenia sprzed zmiany. Jeden zapis naraz — drugi przy niedokończonym pierwszym zgubiłby kolejność.
export function utworzKolejnosc({ ids, zapisz, pokaz, oglos }) {
  let biezace = [...ids];
  let zajety = false;
  const takieSame = (a, b) => a.length === b.length && a.every((x, i) => String(x) === String(b[i]));
  return {
    ids: () => [...biezace],
    async zmien(nowe, id) {
      if (zajety || takieSame(nowe, biezace)) return false;
      zajety = true;
      const stare = biezace;
      pokaz(nowe);
      try {
        const zapisane = await zapisz(nowe);
        biezace = zapisane;
        pokaz(zapisane);
        const miejsce = zapisane.findIndex((x) => String(x) === String(id)) + 1;
        oglos(
          `Zdjęcie jest teraz na miejscu ${miejsce} z ${zapisane.length}${miejsce === 1 ? ' (główne)' : ''}. Zapisano.`,
        );
      } catch (e) {
        biezace = stare;
        pokaz(stare);
        oglos(`Nie zapisano kolejności: ${e.message} Przywrócono poprzednią.`, true);
      } finally {
        zajety = false;
      }
      return true;
    },
  };
}

export const licznik = (i, n) => `${i + 1} / ${n}`;
export const kolejnyIndeks = (i, n, krok) => (((i + krok) % n) + n) % n;

// ——— Podłączenie do strony ———————————————————————————————————————————————————————————————————————————————————

const PROG_PRZECIAGANIA = 5;

export function podlaczGalerie(korzen) {
  const dodaj = korzen.querySelector('.karta-galeria-dodaj');
  const strefa = dodaj?.querySelector('.strefa-pliku');
  const sekcja = korzen.closest('#zdjecia-karty');
  if (sekcja && strefa) {
    const otworzDodawanie = (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return false;
      e.preventDefault();
      dodaj.open = true;
      return true;
    };
    sekcja.addEventListener('dragenter', otworzDodawanie);
    sekcja.addEventListener('dragover', otworzDodawanie);
    sekcja.addEventListener('drop', (e) => {
      if (!otworzDodawanie(e) || strefa.contains(e.target)) return;
      // Przekaż oryginalne pliki do obsługi limitów i znaczników AI w strefie.
      strefa.dispatchEvent(new DragEvent('drop', { dataTransfer: e.dataTransfer, cancelable: true }));
    });
  }
  const pomocAi = korzen.querySelector('[data-galeria-ai-pomoc]');
  if (pomocAi) pomocAi.hidden = false;

  const lista = korzen.querySelector('ol.karta-galeria');
  if (!lista) return;
  const dokument = korzen.ownerDocument;
  const komunikat = korzen.querySelector('#karta-galeria-komunikat');
  const potwierdz = korzen.querySelector('[data-galeria-potwierdz]');
  const miejscePotwierdzenia = potwierdz?.parentElement;
  const dialog = korzen.querySelector('dialog.karta-galeria-dialog');
  const nazwa = korzen.dataset.nazwa ?? '';
  const miniatury = () => [...lista.children];
  const idZ = (li) => Number(li.dataset.zdjecieId);
  korzen.classList.add('karta-galeria--skrypt');

  const oglos = (tekst, blad = false) => {
    if (!komunikat) return;
    // Czyszczenie przed wpisaniem: ten sam tekst drugi raz z rzędu też ma zostać przeczytany.
    komunikat.textContent = '';
    komunikat.classList.toggle('karta-galeria-komunikat--blad', blad);
    setTimeout(() => (komunikat.textContent = tekst), 60);
  };

  // Po przestawieniu numery, napisy dla czytnika, brzegowe „w lewo / w prawo”, plakietka „główne”, ukryte pola
  // „ustaw jako główne” i duże zdjęcie liczą się od nowa z kolejności w DOM.
  const odswiez = () => {
    const wszystkie = miniatury();
    const ids = wszystkie.map(idZ);
    wszystkie.forEach((li, i) => {
      const n = String(i + 1);
      li.querySelectorAll('[data-numer]').forEach((el) => (el.textContent = n));
      li.querySelectorAll('[data-aria-wzor]').forEach((el) =>
        el.setAttribute('aria-label', el.dataset.ariaWzor.replace('{n}', n)),
      );
      const lewo = li.querySelector('button[value="lewo"]');
      const prawo = li.querySelector('button[value="prawo"]');
      if (lewo) lewo.disabled = i === 0;
      if (prawo) prawo.disabled = i === wszystkie.length - 1;
      const plakietka = li.querySelector('[data-glowne]');
      if (plakietka) plakietka.hidden = i > 0;
      const naGlowne = li.querySelector('form.karta-galeria-na-glowne');
      if (naGlowne) {
        naGlowne
          .querySelectorAll('input[name="kolejnosc"]')
          .forEach((pole, k) => (pole.value = String(ustawGlowne(ids, idZ(li))[k])));
        const przycisk = naGlowne.querySelector('button');
        if (przycisk) przycisk.disabled = i === 0;
      }
    });
    const glowne = korzen.querySelector('a[data-galeria-glowne]');
    const zastepnik = korzen.querySelector('[data-galeria-brak-podgladu]');
    const adres = wszystkie[0]?.dataset.adres;
    if (glowne) glowne.hidden = !adres;
    if (zastepnik) zastepnik.hidden = Boolean(adres);
    if (glowne && adres) {
      glowne.href = adres;
      const obraz = glowne.querySelector('img');
      if (obraz && obraz.getAttribute('src') !== adres) {
        obraz.removeAttribute('width');
        obraz.removeAttribute('height');
        obraz.src = adres;
      }
    }
  };

  const pokaz = (ids) => {
    const aktywny = dokument.activeElement;
    const poId = new Map(miniatury().map((li) => [String(idZ(li)), li]));
    // moveBefore zachowuje fokus i stan elementu; starsze przeglądarki dostają zwykłe przeniesienie i fokus wraca
    // ręcznie poniżej.
    ids.forEach((id) => {
      const li = poId.get(String(id));
      if (!li) return;
      if (typeof lista.moveBefore === 'function') lista.moveBefore(li, null);
      else lista.append(li);
    });
    odswiez();
    if (aktywny && aktywny !== dokument.activeElement && lista.contains(aktywny)) {
      const cel = aktywny.disabled ? aktywny.closest('details')?.querySelector('summary') : aktywny;
      cel?.focus();
    }
  };

  const kolejnosc = utworzKolejnosc({
    ids: miniatury().map(idZ),
    zapisz: (ids) => zapiszKolejnosc(korzen.dataset.adresKolejnosc, ids),
    pokaz,
    oglos,
  });

  // ——— Menu „⋯” i kosz: te same formularze co bez skryptu ———
  let doUsuniecia = null;
  const zamknijPotwierdzenie = (wrocFokus = true) => {
    if (!potwierdz || potwierdz.hidden) return;
    potwierdz.hidden = true;
    miejscePotwierdzenia.append(potwierdz);
    const kosz = doUsuniecia?.querySelector('button');
    doUsuniecia = null;
    if (wrocFokus) kosz?.focus();
  };
  const pokazPotwierdzenie = (formularz) => {
    if (!potwierdz) return false;
    doUsuniecia = formularz;
    const li = formularz.closest('li');
    const numer = miniatury().indexOf(li) + 1;
    potwierdz.querySelector('[data-pytanie]').textContent = `Usunąć zdjęcie ${numer}?`;
    const uwaga = potwierdz.querySelector('[data-uwaga]');
    uwaga.textContent = formularz.dataset.uwaga ?? '';
    uwaga.hidden = !formularz.dataset.uwaga;
    lista.querySelectorAll('details.karta-galeria-menu[open]').forEach((menu) => (menu.open = false));
    li.append(potwierdz);
    potwierdz.hidden = false;
    // Fokus na bezpiecznej akcji: Enter przy rozpędzie nie kasuje zdjęcia.
    potwierdz.querySelector('[data-anuluj]').focus();
    return true;
  };
  if (potwierdz) {
    potwierdz.querySelector('[data-anuluj]').addEventListener('click', () => zamknijPotwierdzenie());
    potwierdz.querySelector('[data-tak]').addEventListener('click', () => {
      const formularz = doUsuniecia;
      if (!formularz) return;
      potwierdz.querySelectorAll('button').forEach((b) => (b.disabled = true));
      // submit() nie wywołuje zdarzenia „submit”, więc nie wracamy do potwierdzenia; serwer przekierowuje na kartę.
      formularz.submit();
    });
    potwierdz.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        zamknijPotwierdzenie();
      }
    });
  }

  lista.addEventListener('submit', (e) => {
    const formularz = e.target;
    const li = formularz.closest('li');
    if (!li) return;
    if (formularz.classList.contains('karta-galeria-kosz')) {
      if (pokazPotwierdzenie(formularz)) e.preventDefault();
      return;
    }
    if (
      formularz.classList.contains('karta-galeria-przesun') ||
      formularz.classList.contains('karta-galeria-na-glowne')
    ) {
      e.preventDefault();
      const id = idZ(li);
      const ids = kolejnosc.ids();
      const naGlowne = formularz.classList.contains('karta-galeria-na-glowne');
      const nowe = naGlowne ? ustawGlowne(ids, id) : przesun(ids, id, e.submitter?.value);
      // „Przesuń” zostawia menu otwarte, żeby z klawiatury przesuwać kilka miejsc z rzędu; „główne” to akcja
      // jednorazowa, więc menu się zamyka, a fokus wraca na „⋯” tego zdjęcia.
      if (naGlowne) {
        const menu = formularz.closest('details');
        if (menu) {
          menu.open = false;
          menu.querySelector('summary')?.focus();
        }
      }
      kolejnosc.zmien(nowe, id);
      return;
    }
    if (formularz.classList.contains('karta-galeria-ai')) {
      e.preventDefault();
      zmienAi(formularz, li);
    }
  });

  const zmienAi = async (formularz, li) => {
    const pole = formularz.querySelector('input[name="ai"]');
    if (!pole || pole.disabled) return;
    const chce = pole.checked;
    pole.disabled = true;
    try {
      const ai = await zapiszAi(formularz.action, chce);
      pole.checked = ai === 1;
      const znak = li.querySelector('[data-znak-ai]');
      if (znak) {
        znak.textContent = 'AI';
        znak.title = 'Zdjęcie wygenerowane lub zmienione przez AI';
        znak.hidden = ai !== 1;
      }
      oglos(ai === 1 ? 'Zdjęcie oznaczone jako AI.' : 'Zdjęto oznaczenie AI.');
    } catch (e) {
      pole.checked = !chce;
      oglos(`Nie zapisano znacznika AI: ${e.message}`, true);
    } finally {
      pole.disabled = false;
    }
  };
  // Ze skryptem znacznik zapisuje się od razu po kliknięciu pola — przycisk „Zapisz znacznik” chowa CSS.
  lista.addEventListener('change', (e) => {
    const pole = e.target;
    if (pole.name !== 'ai') return;
    const formularz = pole.closest('form.karta-galeria-ai');
    if (formularz) zmienAi(formularz, formularz.closest('li'));
  });

  // Jedno otwarte menu naraz; klik poza menu albo Escape je zamyka.
  lista.addEventListener(
    'toggle',
    (e) => {
      if (!e.target.open) return;
      lista.querySelectorAll('details.karta-galeria-menu[open]').forEach((d) => d !== e.target && (d.open = false));
    },
    true,
  );
  dokument.addEventListener('click', (e) => {
    lista
      .querySelectorAll('details.karta-galeria-menu[open]')
      .forEach((d) => !d.contains(e.target) && (d.open = false));
  });
  lista.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const menu = e.target.closest?.('details.karta-galeria-menu[open]');
    if (menu) {
      menu.open = false;
      menu.querySelector('summary').focus();
    }
  });

  // ——— Przeciąganie wskaźnikiem ———
  let ruch = null;
  let pominKlik = false;
  const wyczyscCel = () =>
    miniatury().forEach((li) => li.classList.remove('karta-galeria-cel--przed', 'karta-galeria-cel--po'));
  const zakoncz = (zapisz) => {
    if (!ruch) return;
    const { li, cel, aktywne } = ruch;
    ruch = null;
    li.classList.remove('karta-galeria-miniatura--przeciagana');
    lista.classList.remove('karta-galeria--przeciaganie');
    wyczyscCel();
    if (!aktywne) return;
    pominKlik = true;
    setTimeout(() => (pominKlik = false), 0);
    if (!zapisz || !cel) return;
    const id = idZ(li);
    const celId = idZ(miniatury()[cel.indeks]);
    kolejnosc.zmien(przeniesPrzed(kolejnosc.ids(), id, celId, cel.po), id);
  };
  lista.addEventListener('pointerdown', (e) => {
    const uchwyt = e.target.closest?.('.karta-galeria-obraz');
    if (!uchwyt || e.button !== 0 || e.pointerType === 'touch' || ruch) return;
    ruch = { li: uchwyt.closest('li'), uchwyt, x: e.clientX, y: e.clientY, id: e.pointerId, aktywne: false, cel: null };
  });
  dokument.addEventListener('pointermove', (e) => {
    if (!ruch || e.pointerId !== ruch.id) return;
    if (!(e.buttons & 1)) {
      zakoncz(false);
      return;
    }
    if (!ruch.aktywne) {
      if (Math.hypot(e.clientX - ruch.x, e.clientY - ruch.y) < PROG_PRZECIAGANIA) return;
      ruch.aktywne = true;
      // Wskaźnik mógł już zniknąć (np. puszczony poza oknem) — przeciąganie działa wtedy bez przechwycenia.
      try {
        ruch.uchwyt.setPointerCapture?.(e.pointerId);
      } catch {}
      ruch.li.classList.add('karta-galeria-miniatura--przeciagana');
      lista.classList.add('karta-galeria--przeciaganie');
    }
    e.preventDefault();
    const wszystkie = miniatury();
    ruch.cel = celUpuszczenia(
      wszystkie.map((li) => li.getBoundingClientRect()),
      e.clientX,
      e.clientY,
    );
    wyczyscCel();
    const celLi = ruch.cel && wszystkie[ruch.cel.indeks];
    if (celLi && celLi !== ruch.li)
      celLi.classList.add(ruch.cel.po ? 'karta-galeria-cel--po' : 'karta-galeria-cel--przed');
  });
  const anulujRuch = (e) => ruch && e.pointerId === ruch.id && zakoncz(false);
  dokument.addEventListener('pointerup', (e) => ruch && e.pointerId === ruch.id && zakoncz(true));
  dokument.addEventListener('pointercancel', anulujRuch);
  dokument.addEventListener('lostpointercapture', anulujRuch);
  dokument.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ruch?.aktywne) {
      e.preventDefault();
      zakoncz(false);
      oglos('Przeciąganie anulowane.');
    }
  });

  // ——— Powiększenie ———
  if (!dialog || typeof dialog.showModal !== 'function') return;
  const duze = dialog.querySelector('[data-galeria-duze]');
  const licznikEl = dialog.querySelector('[data-galeria-licznik]');
  let biezacy = 0;
  const zPodgladem = () => miniatury().filter((li) => li.dataset.adres);
  const pokazDuze = (i) => {
    const lista = zPodgladem();
    if (!lista.length) return;
    biezacy = kolejnyIndeks(i, lista.length, 0);
    duze.src = lista[biezacy].dataset.adres;
    duze.alt = `${nazwa} — zdjęcie ${biezacy + 1} z ${lista.length}`;
    licznikEl.textContent = licznik(biezacy, lista.length);
    dialog.querySelectorAll('[data-galeria-krok]').forEach((b) => (b.hidden = lista.length < 2));
  };
  const otworz = (li) => {
    pokazDuze(Math.max(0, zPodgladem().indexOf(li)));
    dialog.showModal();
  };
  korzen.addEventListener('click', (e) => {
    const link = e.target.closest?.('.karta-galeria-obraz, a[data-galeria-glowne]');
    if (!link || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    if (pominKlik) return;
    otworz(link.matches('[data-galeria-glowne]') ? miniatury()[0] : link.closest('li'));
  });
  const krok = (k) => pokazDuze(kolejnyIndeks(biezacy, zPodgladem().length, k));
  dialog
    .querySelectorAll('[data-galeria-krok]')
    .forEach((b) => b.addEventListener('click', () => krok(Number(b.dataset.galeriaKrok))));
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') krok(-1);
    else if (e.key === 'ArrowRight') krok(1);
    else return;
    e.preventDefault();
  });
  // closedby="any" (zamykanie klikiem w tło) nie wszędzie jest; tam dokładamy to samo ręcznie: wciśnięcie
  // i puszczenie poza prostokątem okna.
  if (!('closedBy' in dialog)) {
    let poza = false;
    const pozaOknem = (e) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    dialog.addEventListener('pointerdown', (e) => (poza = e.target === dialog && pozaOknem(e)));
    dialog.addEventListener('pointerup', (e) => {
      if (poza && e.target === dialog && pozaOknem(e)) dialog.close();
      poza = false;
    });
  }
}

if (typeof document !== 'undefined') {
  document.querySelectorAll('[data-karta-galeria]').forEach(podlaczGalerie);
}
