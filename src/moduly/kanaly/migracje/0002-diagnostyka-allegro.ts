import type {Migracja} from '../../../core/kontrakty.ts';
export const migracjaDiagnostykiAllegro:Migracja={numer:2,nazwa:'jawne wyniki testow polaczenia Allegro',wykonaj(db){
 db.exec(`CREATE TABLE IF NOT EXISTS kanaly_diagnostyka (
  kanal TEXT PRIMARY KEY, ostatnia_proba_at TEXT NOT NULL, ostatni_sukces_at TEXT,
  blad INTEGER NOT NULL CHECK(blad IN (0,1))
 )`);
}};
