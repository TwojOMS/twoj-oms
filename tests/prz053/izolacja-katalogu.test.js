import {it,expect} from 'vitest';
import {kanalyWidoku,adresKanalu} from '../../src/domena/kanaly.js';
it('modyfikacja wyniku widoku nie przecieka do kolejnej instalacji',()=>{
  const pierwszy=kanalyWidoku([]);
  const reczne=pierwszy.find(k=>k.klucz==='reczne');
  const etykieta=reczne.etykieta;
  try {
    reczne.etykieta='Zmieniona tylko lokalnie';
    expect(adresKanalu('reczne',[])).toBe('ręczne');
  } finally {reczne.etykieta=etykieta;}
});
