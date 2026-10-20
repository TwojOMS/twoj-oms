export function przeniesElement(elementy, z, na) {
  const wynik = [...elementy];
  const [element] = wynik.splice(z, 1);
  wynik.splice(na, 0, element);
  return wynik;
}

export function inicjalizujKolejnosc(lista, komunikat, wyslij = fetch) {
  let zapisuje = false;
  let chwyt = null;
  let przewijanie = null;
  const wiersze = () => [...lista.querySelectorAll('[data-klucz]')];
  const uloz = elementy => lista.append(...elementy);
  const oglos = tekst => { komunikat.textContent = tekst; };
  const uchwytWiersza = wiersz => wiersz.querySelector('.ust-uchwyt');
  const pozycja = wiersz => `${uchwytWiersza(wiersz).dataset.nazwa}: pozycja ${wiersze().indexOf(wiersz) + 1} z ${wiersze().length}.`;

  async function zapisz(poprzednie, wiersz) {
    if (poprzednie.every((w, i) => w === wiersze()[i])) { oglos(`Kolejność bez zmian. ${pozycja(wiersz)}`); return; }
    zapisuje = true;
    lista.setAttribute('aria-busy', 'true');
    oglos('Zapisywanie kolejności…');
    try {
      const odpowiedz = await wyslij('/ustawienia/statusy', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ akcja: 'kolejnosc', kolejnosc: wiersze().map(w => w.dataset.klucz) }),
      });
      if (!odpowiedz.ok) throw new Error('Nie zapisano');
      // Wygaśnięcie sesji może przekierować do HTML logowania (200).
      await odpowiedz.json();
      oglos(`Zapisano kolejność. ${pozycja(wiersz)}`);
    } catch {
      uloz(poprzednie);
      oglos('Nie udało się zapisać. Przywrócono poprzednią kolejność. Spróbuj ponownie lub odśwież ekran.');
    } finally {
      zapisuje = false;
      lista.removeAttribute('aria-busy');
      uchwytWiersza(wiersz).focus({ preventScroll: true });
    }
  }

  lista.addEventListener('keydown', async e => {
    if (e.key === 'Escape' && chwyt) { e.preventDefault(); zakoncz(false); return; }
    const uchwyt = e.target.closest('.ust-uchwyt');
    if (!uchwyt || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    if (zapisuje || chwyt) return;
    const poprzednie = wiersze();
    const wiersz = uchwyt.closest('[data-klucz]');
    const z = poprzednie.indexOf(wiersz);
    const na = z + (e.key === 'ArrowUp' ? -1 : 1);
    if (na < 0 || na >= poprzednie.length) return;
    uloz(przeniesElement(poprzednie, z, na));
    uchwyt.focus({ preventScroll: true });
    await zapisz(poprzednie, wiersz);
  });

  function przesun(y) {
    const obecne = wiersze();
    const pozostale = obecne.filter(w => w !== chwyt.wiersz);
    let na = pozostale.findIndex(w => {
      const r = w.getBoundingClientRect();
      return y < r.top + r.height / 2;
    });
    if (na < 0) na = pozostale.length;
    const z = obecne.indexOf(chwyt.wiersz);
    if (z !== na) {
      // Przenosimy tylko chwytany wiersz; pola edycji innych statusów zachowują stan.
      const nowe = przeniesElement(obecne, z, na);
      lista.insertBefore(chwyt.wiersz, nowe[na + 1] ?? null);
      chwyt.uchwyt.focus({ preventScroll: true });
      chwyt.uchwyt.setPointerCapture(chwyt.id);
    }
  }

  function przewijaj() {
    if (!chwyt) return;
    const okno = lista.ownerDocument.defaultView;
    const y = chwyt.y;
    const krok = y < 80 ? -12 : y > okno.innerHeight - 80 ? 12 : 0;
    if (krok) { okno.scrollBy(0, krok); przesun(y); }
    przewijanie = okno.requestAnimationFrame(przewijaj);
  }

  lista.addEventListener('pointerdown', e => {
    const uchwyt = e.target.closest('.ust-uchwyt');
    if (!uchwyt || zapisuje || chwyt || e.button !== 0 || !e.isPrimary) return;
    e.preventDefault();
    const wiersz = uchwyt.closest('[data-klucz]');
    uchwyt.focus({ preventScroll: true });
    uchwyt.setPointerCapture(e.pointerId);
    chwyt = { wiersz, uchwyt, id: e.pointerId, poprzednie: wiersze(), y: e.clientY };
    wiersz.classList.add('ust-przeciagany');
    uchwyt.setAttribute('aria-pressed', 'true');
    oglos(`Przeciągasz ${uchwyt.dataset.nazwa}. Upuść w wybranym miejscu. Escape anuluje.`);
    przewijaj();
  });

  const dokument = lista.ownerDocument;
  dokument.addEventListener('pointermove', e => {
    if (!chwyt || e.pointerId !== chwyt.id) return;
    e.preventDefault();
    chwyt.y = e.clientY;
    przesun(e.clientY);
  }, { passive: false });

  async function zakoncz(zapisac) {
    if (!chwyt) return;
    const { wiersz, uchwyt, id, poprzednie } = chwyt;
    chwyt = null;
    dokument.defaultView.cancelAnimationFrame(przewijanie);
    wiersz.classList.remove('ust-przeciagany');
    uchwyt.setAttribute('aria-pressed', 'false');
    if (uchwyt.hasPointerCapture(id)) uchwyt.releasePointerCapture(id);
    if (zapisac) await zapisz(poprzednie, wiersz);
    else { uloz(poprzednie); oglos('Anulowano przesuwanie.'); }
    uchwyt.focus({ preventScroll: true });
  }
  dokument.addEventListener('pointerup', e => { if (chwyt?.id === e.pointerId) void zakoncz(true); });
  dokument.addEventListener('pointercancel', e => { if (chwyt?.id === e.pointerId) void zakoncz(false); });
  dokument.defaultView.addEventListener('blur', () => { void zakoncz(false); });
}

if (typeof document !== 'undefined') {
  const lista = document.querySelector('#statusy-zamowien tbody');
  if (lista) inicjalizujKolejnosc(lista, document.getElementById('statusy-kolejnosc-komunikat'));
}
