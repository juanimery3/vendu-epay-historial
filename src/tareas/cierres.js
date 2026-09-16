// Cierres de lote del PDV (API e=cierres con token, sin login). Un día UTC por llamada.
// El día local, el lote Ubii y la fecha de liquidación los calcula la base (columnas generadas).

import { insertarLote } from "../db.js";
import { diaUtc, enParalelo, fechaApiUtc, rangoDias } from "../util.js";

const COLUMNAS = ["cuenta", "cierre_id", "maquina_id", "codigo_interno", "uid", "fecha"];

/** Pide los días dados (AAAA-MM-DD, UTC) y guarda sus cierres. Solo devuelve conteos. */
export async function cargarCierres(db, epay, dias) {
  const t = { dias: dias.length, dias_con_cierres: 0, cierres_recibidos: 0, cierres_nuevos_o_cambiados: 0, fallos: 0 };
  await enParalelo(dias, 4, async (dia) => {
    let lista;
    try {
      lista = await epay.cierresDia(dia);
    } catch {
      t.fallos++;
      return;
    }
    const filas = lista
      .filter((c) => Number(c.rowid) > 0 && Number(c.maquina) > 0 && fechaApiUtc(c.fecha))
      .map((c) => [
        epay.cuenta, Number(c.rowid), Number(c.maquina), String(c.codigo ?? "").trim() || null,
        String(c.serial ?? "").trim() || null, fechaApiUtc(c.fecha),
      ]);
    // coalesce: un dato que no viene no borra el guardado. Solo cuentan las filas nuevas o que cambiaron.
    const afectadas = await insertarLote(db, "epay.cierres", COLUMNAS, filas,
      `(cuenta, cierre_id) do update set maquina_id = excluded.maquina_id,
         codigo_interno = coalesce(excluded.codigo_interno, epay.cierres.codigo_interno),
         uid = coalesce(excluded.uid, epay.cierres.uid), fecha = excluded.fecha, actualizado = now()
       where (epay.cierres.maquina_id, epay.cierres.codigo_interno, epay.cierres.uid, epay.cierres.fecha)
             is distinct from (excluded.maquina_id, coalesce(excluded.codigo_interno, epay.cierres.codigo_interno),
                               coalesce(excluded.uid, epay.cierres.uid), excluded.fecha)`);
    // Esperar y después sumar: con "+= await" se pierden las sumas de los trabajadores en paralelo.
    t.cierres_recibidos += filas.length;
    t.cierres_nuevos_o_cambiados += afectadas;
    if (filas.length > 0) t.dias_con_cierres++;
  });
  return t;
}

/**
 * Sin rango: anteayer, ayer y hoy (UTC; el día de Caracas cruza dos días UTC).
 * Con rango: carga histórica día por día, ej. desde 2026-06-01.
 */
export async function tareaCierres(db, epay, desde, hasta) {
  if (!desde) return cargarCierres(db, epay, [diaUtc(-2), diaUtc(-1), diaUtc(0)]);
  const dias = rangoDias(desde, hasta || diaUtc(0));
  if (dias.length === 0 || dias.length > 400) throw new Error("rango de días inválido (máximo 400)");
  return cargarCierres(db, epay, dias);
}
