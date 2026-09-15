// Lo que todavía exige login (única tarea que entra al portal, cada 6 h): descripción de cada ficha
// (maquinas.php?id=) y pago hasta / ruta / inventario (reporte7.php). Los productos salen por API (e=prods).

import { insertarLote, registrarEvento } from "../db.js";
import { enParalelo, numero } from "../util.js";

const COLUMNAS_PRODUCTOS = [
  "cuenta", "producto_id", "codigo", "nombre", "categoria", "precio_bs", "precio_usd", "costo_bs", "costo_usd", "iva",
];

export async function tareaFichas(db, epay) {
  let fichas = 0, eventos = 0, productos = 0, fallos = 0, datosReporte7 = 0;

  // Pago hasta, ruta e inventario: una sola página del portal para toda la flota.
  try {
    for (const m of await epay.maquinas()) {
      await db.query(
        "update epay.maquinas set pago_hasta = $3, ruta = $4, inventario = $5 where cuenta = $1 and maquina_id = $2",
        [epay.cuenta, m.maquina_id, m.pago_hasta, m.ruta, m.inventario]
      );
      datosReporte7++;
    }
  } catch {
    fallos++;
  }

  const maquinas = (await db.query(
    "select maquina_id, uid, descripcion, codigo_interno from epay.maquinas where cuenta = $1 and vigente order by maquina_id",
    [epay.cuenta]
  )).rows.slice(0, Number(process.env.LIMITE_MAQUINAS) || undefined);

  await enParalelo(maquinas, 3, async (maq) => {
    try {
      const campos = await epay.ficha(maq.maquina_id);
      const descripcion = String(campos.coment ?? "").replace(/\r\n/g, "\n").trim();
      fichas++;
      if (maq.descripcion !== descripcion) {
        if (maq.descripcion !== null) {
          await registrarEvento(db, epay.cuenta, maq.maquina_id, "cambio_descripcion",
            { valor: maq.descripcion }, { valor: descripcion, codigo_interno: maq.codigo_interno });
          eventos++;
        }
        await db.query("update epay.maquinas set descripcion = $3 where cuenta = $1 and maquina_id = $2",
          [epay.cuenta, maq.maquina_id, descripcion]);
      }
    } catch {
      fallos++;
    }

    if (!maq.uid) return;
    try {
      const lista = await epay.productos(maq.uid);
      if (!Array.isArray(lista)) return;
      const filas = lista.filter((p) => Number(p.rowid) > 0).map((p) => [
        epay.cuenta, Number(p.rowid), p.codigo ?? null, p.nombre?.trim() ?? null, p.categoria || null,
        numero(p.precio), numero(p.usd), numero(p.costo), numero(p.costo_usd), numero(p.iva),
      ]);
      // Esperar y después sumar (con `+= await` se pierden las sumas de los trabajadores en paralelo).
      const actualizados = await insertarLote(db, "epay.productos", COLUMNAS_PRODUCTOS, filas,
        `(cuenta, producto_id) do update set codigo = excluded.codigo, nombre = excluded.nombre,
         categoria = excluded.categoria, precio_bs = excluded.precio_bs, precio_usd = excluded.precio_usd,
         costo_bs = excluded.costo_bs, costo_usd = excluded.costo_usd, iva = excluded.iva, actualizado = now()`);
      productos += actualizados;
    } catch {
      fallos++;
    }
  });
  return { fichas, datos_reporte7: datosReporte7, eventos, productos, fallos };
}
