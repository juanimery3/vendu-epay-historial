// Carga inicial: ventas y pagos mes a mes desde un mes dado (por API, sin login).

import { diaCaracas } from "../util.js";
import { cargarVentasYPagos } from "./ventas.js";

export async function tareaHistorico(db, epay, desde, hasta = diaCaracas().slice(0, 7)) {
  const meses = [];
  let [anio, mes] = desde.split("-").map(Number);
  const [anioFin, mesFin] = hasta.split("-").map(Number);
  while (anio < anioFin || (anio === anioFin && mes <= mesFin)) {
    meses.push({ anio, mes });
    if (++mes > 12) {
      mes = 1;
      anio++;
    }
  }
  if (meses.length === 0 || meses.length > 36) throw new Error("rango de meses inválido (máximo 36)");

  return { meses: meses.length, ...(await cargarVentasYPagos(db, epay, meses)) };
}
