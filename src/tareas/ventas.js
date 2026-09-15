// Ventas una por una (API e=venta) y pagos externos (reporte22.php).

import { createHash } from "node:crypto";
import { insertarLote } from "../db.js";
import { diaCaracas, enParalelo, numero } from "../util.js";

const COLUMNAS_VENTAS = [
  "cuenta", "venta_id", "maquina_id", "uid", "codigo_interno", "fecha", "producto_id",
  "monto_bs", "monto_usd", "tasa", "cliente_id", "tid", "descripcion",
];
const COLUMNAS_PAGOS = [
  "cuenta", "huella", "fecha", "maquina_id", "codigo_interno", "medio", "respuesta", "estatus", "monto_bs", "referencia",
];

/** Mes en curso (hora de Caracas) y, los dos primeros días, también el anterior. */
function mesesRecientes() {
  const [anio, mes, dia] = diaCaracas().split("-").map(Number);
  const meses = [{ anio, mes }];
  if (dia <= 2) meses.unshift(mes === 1 ? { anio: anio - 1, mes: 12 } : { anio, mes: mes - 1 });
  return meses;
}

export async function cargarVentas(db, epay, meses) {
  const maquinas = (await db.query(
    "select maquina_id, uid from epay.maquinas where cuenta = $1 and vigente and uid is not null order by maquina_id",
    [epay.cuenta]
  )).rows.slice(0, Number(process.env.LIMITE_MAQUINAS) || undefined);

  let recibidas = 0, nuevas = 0, fallos = 0;
  await enParalelo(maquinas, 4, async (maq) => {
    for (const { anio, mes } of meses) {
      let lista;
      try {
        lista = await epay.ventasMes(maq.uid, mes, anio);
      } catch {
        fallos++;
        continue;
      }
      if (!Array.isArray(lista) || lista.length === 0) continue;
      recibidas += lista.length;
      const filas = lista
        .filter((v) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(v.fecha)) && Number(v.rowid) > 0)
        .map((v) => [
          epay.cuenta,
          Number(v.rowid),
          maq.maquina_id, // la máquina dueña del UID consultado; el campo "maquina" de la API no siempre coincide
          maq.uid,
          (String(v.descr ?? "").match(/\(([^()]+)\)\s*$/) || [])[1]?.trim() || null, // "Compra  (I03-IND01)"
          String(v.fecha).replace(" ", "T") + "Z", // la API entrega UTC
          Number(v.producto) || null,
          numero(v.monto),
          numero(v.usd),
          numero(v.tasa),
          Number(v.usuario) || null,
          v.tid ?? null,
          v.descr ?? null,
        ]);
      nuevas += await insertarLote(db, "epay.ventas", COLUMNAS_VENTAS, filas, "(cuenta, venta_id) do nothing");
    }
  });
  return { maquinas: maquinas.length, ventas_recibidas: recibidas, ventas_nuevas: nuevas, fallos };
}

export async function cargarPagos(db, epay, desde, hasta) {
  const filas = [];
  for (const p of await epay.pagosExternos(desde, hasta)) {
    const f = p["Fecha"].match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}:\d{2}:\d{2})/);
    if (!f) continue;
    const maq = (p["Maquina"] || "").match(/^(.*?)\s*\((\d+)\)\s*$/);
    const huella = createHash("sha1")
      .update([epay.cuenta, p["Fecha"], p["Maquina"], p["Referencia"], p["Monto"], p["Medio"], p["Respuesta"]].join("|"))
      .digest("hex");
    filas.push([
      epay.cuenta, huella, `${f[3]}-${f[2]}-${f[1]}T${f[4]}-04:00`, // el reporte está en hora de Caracas
      maq ? Number(maq[2]) : null, maq ? maq[1] || null : null,
      p["Medio"] || null, p["Respuesta"] || null, p["Estatus"] || null, numero(p["Monto"]), p["Referencia"] || null,
    ]);
  }
  const nuevos = await insertarLote(db, "epay.pagos_externos", COLUMNAS_PAGOS, filas, "(cuenta, huella) do nothing");
  return { pagos_recibidos: filas.length, pagos_nuevos: nuevos };
}

export async function tareaVentas(db, epay) {
  const ventas = await cargarVentas(db, epay, mesesRecientes());
  const pagos = await cargarPagos(db, epay, diaCaracas(-1), diaCaracas());
  return { ...ventas, ...pagos };
}
