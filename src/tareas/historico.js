// Carga inicial: ventas mes a mes y pagos externos semana a semana desde un mes dado.

import { diaCaracas } from "../util.js";
import { cargarPagos, cargarVentas } from "./ventas.js";

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

  const ventas = await cargarVentas(db, epay, meses);

  let pagosRecibidos = 0, pagosNuevos = 0;
  const hoy = diaCaracas();
  const ultimoDiaPedido = new Date(Date.UTC(anioFin, mesFin, 0)).toISOString().slice(0, 10);
  const fin = ultimoDiaPedido < hoy ? ultimoDiaPedido : hoy;
  for (let d = new Date(`${desde}-01T00:00:00Z`); d.toISOString().slice(0, 10) <= fin; d = new Date(d.getTime() + 7 * 86_400_000)) {
    const ini = d.toISOString().slice(0, 10);
    const semanaFin = new Date(d.getTime() + 6 * 86_400_000).toISOString().slice(0, 10);
    const r = await cargarPagos(db, epay, ini, semanaFin < fin ? semanaFin : fin);
    pagosRecibidos += r.pagos_recibidos;
    pagosNuevos += r.pagos_nuevos;
  }

  return { meses: meses.length, ...ventas, pagos_recibidos: pagosRecibidos, pagos_nuevos: pagosNuevos };
}
