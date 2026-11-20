// Panel „Edytuj" na liście magazynu: lista zmian zamiast ściany pól.
// Wiersze to klony <template> wyrenderowanego przez serwer — skrypt nie składa HTML z napisów,
// więc nazwy z bazy (marki, kategorie, parametry) przechodzą wyłącznie przez escapowanie EJS.

const panel = document.querySelector('#hurt-pasek.hz');
if (panel) uruchom(panel);

function uruchom(cialo) {
  const form = cialo.closest('form');
  const lista = cialo.querySelector('#hz-lista');
  const menu = cialo.querySelector('#hz-menu');
  const kolejna = cialo.querySelector('#hz-kolejna');
  const zamknij = cialo.querySelector('#hz-menu-zamknij');
  const stopka = cialo.querySelector('#hz-stopka');
  const ile = cialo.querySelector('[data-hz-ile]');
  const szablony = cialo.querySelector('#hz-szablony');
  const opcje = [...menu.querySelectorAll('.hz-opcja')];

  // Bez skryptu menu zostaje ukryte (mówi o tym <noscript>); ze skryptem startuje rozwinięte.
  menu.hidden = false;

  const wiersze = () => [...lista.children];
  const dodane = () => new Set(wiersze().map((li) => li.dataset.zmiana));

  function pokazMenu(tak) {
    const ileWierszy = lista.children.length;
    const otwarte = tak || ileWierszy === 0;
    menu.hidden = !otwarte;
    kolejna.hidden = otwarte || ileWierszy === 0;
    zamknij.hidden = ileWierszy === 0;
    if (tak) opcje.find((o) => !o.disabled)?.focus();
  }

  function odswiez() {
    stopka.hidden = lista.children.length === 0;
    const juz = dodane();
    for (const o of opcje) o.disabled = juz.has(o.dataset.z);
  }

  function policzZaznaczone() {
    if (!ile || !form) return;
    const n = form.querySelectorAll('input[name="zaznaczone"]:checked').length;
    ile.textContent = `${n} ${odmiana(n)}`;
  }

  // Pola wyboru „wyczyść”, „bez progu”, „wróć do tekstu domyślnego” wykluczają wpisaną wartość —
  // wyłączone pole nie jedzie z formularzem, więc serwer nie dostanie dwóch sprzecznych poleceń.
  function wykluczenia(li) {
    const pole = li.querySelector('.hz-wyczysc input[type="checkbox"]');
    if (!pole) return;
    const inne = [...li.querySelectorAll('.hz-pola input, .hz-pola select, .hz-pola textarea')].filter(
      (p) => p !== pole,
    );
    const ustaw = () => {
      for (const p of inne) p.disabled = pole.checked;
    };
    pole.addEventListener('change', ustaw);
    ustaw();
  }

  function trybCeny(li) {
    const tryb = li.querySelector('select[name="cena_tryb"]');
    const zaokr = li.querySelector('.hurt-zaokraglenie');
    if (!tryb || !zaokr) return;
    const ustaw = () => {
      const naKwote = tryb.value === 'na_kwote';
      zaokr.hidden = naKwote;
      zaokr.querySelector('select').disabled = naKwote;
    };
    tryb.addEventListener('change', ustaw);
    ustaw();
  }

  function dodajWiersz(klucz) {
    const wzor = szablony.content.querySelector(`li[data-zmiana="${CSS.escape(klucz)}"]`);
    if (!wzor || dodane().has(klucz)) return null;
    const li = wzor.cloneNode(true);
    lista.append(li);
    trybCeny(li);
    wykluczenia(li);
    li.querySelector('.hz-usun').addEventListener('click', () => usunWiersz(li));
    odswiez();
    pokazMenu(false);
    return li;
  }

  function usunWiersz(li) {
    li.remove();
    odswiez();
    pokazMenu(false);
    if (lista.children.length) kolejna.focus();
    else opcje.find((o) => !o.disabled)?.focus();
  }

  for (const o of opcje) {
    o.addEventListener('click', () => {
      const li = dodajWiersz(o.dataset.z);
      li?.querySelector('input, select, textarea')?.focus();
    });
  }
  kolejna.addEventListener('click', () => pokazMenu(true));
  zamknij.addEventListener('click', () => {
    pokazMenu(false);
    kolejna.focus();
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || lista.children.length === 0) return;
    // Esc zamyka listę pozycji, a nie cały panel <details>.
    e.preventDefault();
    e.stopPropagation();
    pokazMenu(false);
    kolejna.focus();
  });

  form?.addEventListener('change', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.name === 'zaznaczone') policzZaznaczone();
  });
  // „Zaznacz wszystkie” zmienia pola skryptem, bez zdarzenia change na każdym z nich.
  form?.addEventListener('click', () => queueMicrotask(policzZaznaczone));

  odswiez();
  pokazMenu(false);
  policzZaznaczone();
}

function odmiana(n) {
  if (n === 1) return 'zaznaczona';
  const d = n % 10;
  const s = n % 100;
  if (d >= 2 && d <= 4 && (s < 12 || s > 14)) return 'zaznaczone';
  return 'zaznaczonych';
}
