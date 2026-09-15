// Descripción de cada ficha (maquinas.php?id=) y productos con precios y costos (API e=prods).

import { insertarLote, registrarEvento } from "../db.js";
import { enParalelo, numero } from "../util.js";

const COLUMNAS_PRODUCTOS = [
  "cuenta", "producto_id", "codigo", "nombre", "categoria", "precio_bs", "precio_usd", "costo_bs", "costo_usd", "iva",
];

export async function tareaFichas(db, epay) {
  const maquinas = (await db.query(
    "select maquina_id, uid, descripcion, codigo_interno from epay.maquinas where cuenta = $1 and vigente order by maquina_id",
    [epay.cuenta]
  )).rows.slice(0, Number(process.env.LIMITE_MAQUINAS) || undefined);

  let fichas = 0, eventos = 0, productos = 0, fallos = 0;
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
  return { fichas, eventos, productos, fallos };
}
