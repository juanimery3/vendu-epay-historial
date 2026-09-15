// Ventas y pagos una por una, y existencias por canal. Todo por API: no inicia sesión en el portal.

import { insertarLote } from "../db.js";
import { diaCaracas, enParalelo, numero } from "../util.js";

const COLUMNAS_VENTAS = [
  "cuenta", "venta_id", "maquina_id", "uid", "codigo_interno", "fecha", "producto_id",
  "monto_bs", "monto_usd", "tasa", "cliente_id", "tid", "descripcion",
];
const COLUMNAS_PAGOS = [
  "cuenta", "pago_id", "maquina_id", "uid", "fecha", "monto_bs", "medio_codigo", "medio", "ref", "ref2", "cliente_id",
];
const COLUMNAS_CANALES = [
  "cuenta", "canal_id", "maquina_id", "codigo", "seleccion", "producto_id", "activo", "cantidad", "minimo", "maximo",
];

// Códigos de medio de e=pago, verificados contra el reporte de pagos externos (15-09-2026):
// I03 (PDV, Débito Inmediato, Gift Card) y V16-UNIPBB, Epay K (TC / TD, respuesta KPAY3).
const MEDIOS = { 1: "TC / TD", 2: "PDV", 7: "Débito Inmediato", 11: "Gift Card" };

const FECHA_API = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const utc = (fecha) => String(fecha).replace(" ", "T") + "Z"; // la API entrega UTC

/** Mes en curso (hora de Caracas) y, los dos primeros días, también el anterior. */
function mesesRecientes() {
  const [anio, mes, dia] = diaCaracas().split("-").map(Number);
  const meses = [{ anio, mes }];
  if (dia <= 2) meses.unshift(mes === 1 ? { anio: anio - 1, mes: 12 } : { anio, mes: mes - 1 });
  return meses;
}

async function maquinasConUid(db, epay) {
  return (await db.query(
    "select maquina_id, uid from epay.maquinas where cuenta = $1 and vigente and uid is not null order by maquina_id",
    [epay.cuenta]
  )).rows.slice(0, Number(process.env.LIMITE_MAQUINAS) || undefined);
}

export async function cargarVentasYPagos(db, epay, meses) {
  const maquinas = await maquinasConUid(db, epay);
  const t = { ventas_recibidas: 0, ventas_nuevas: 0, pagos_recibidos: 0, pagos_nuevos: 0, fallos: 0 };

  await enParalelo(maquinas, 4, async (maq) => {
    for (const { anio, mes } of meses) {
      let ventas, pagos;
      try {
        [ventas, pagos] = await Promise.all([epay.ventasMes(maq.uid, mes, anio), epay.pagosMes(maq.uid, mes, anio)]);
      } catch {
        t.fallos++;
        continue;
      }

      const filasVentas = (Array.isArray(ventas) ? ventas : [])
        .filter((v) => FECHA_API.test(String(v.fecha)) && Number(v.rowid) > 0)
        .map((v) => [
          epay.cuenta, Number(v.rowid), maq.maquina_id, maq.uid,
          (String(v.descr ?? "").match(/\(([^()]+)\)\s*$/) || [])[1]?.trim() || null, // "Compra  (I03-IND01)"
          utc(v.fecha), Number(v.producto) || null, numero(v.monto), numero(v.usd), numero(v.tasa),
          Number(v.usuario) || null, v.tid ?? null, v.descr ?? null,
        ]);
      const filasPagos = (Array.isArray(pagos) ? pagos : [])
        .filter((p) => FECHA_API.test(String(p.fecha)) && Number(p.rowid) > 0)
        .map((p) => [
          epay.cuenta, Number(p.rowid), maq.maquina_id, maq.uid, utc(p.fecha), numero(p.monto),
          p.medio ?? null, MEDIOS[p.medio] ?? (p.medio ? `código ${p.medio}` : null),
          p.ref || null, p.ref2 || null, Number(p.usuario) || null,
        ]);

      // Esperar y después sumar: `t.x += await …` lee t.x antes del await y pierde lo sumado en paralelo.
      const ventasNuevas = await insertarLote(db, "epay.ventas", COLUMNAS_VENTAS, filasVentas, "(cuenta, venta_id) do nothing");
      const pagosNuevos = await insertarLote(db, "epay.pagos", COLUMNAS_PAGOS, filasPagos, "(cuenta, pago_id) do nothing");
      t.ventas_recibidas += filasVentas.length;
      t.ventas_nuevas += ventasNuevas;
      t.pagos_recibidos += filasPagos.length;
      t.pagos_nuevos += pagosNuevos;
    }
  });
  return { maquinas: maquinas.length, ...t };
}

/** Foto de existencias por canal de cada máquina; borra los canales que ya no trae la API. */
export async function cargarCanales(db, epay) {
  const maquinas = await maquinasConUid(db, epay);
  let canales = 0, fallos = 0;
  await enParalelo(maquinas, 4, async (maq) => {
    let lista;
    try {
      lista = await epay.canales(maq.uid);
    } catch {
      fallos++;
      return;
    }
    if (!Array.isArray(lista)) return;
    const filas = lista.filter((c) => Number(c.rowid) > 0).map((c) => [
      epay.cuenta, Number(c.rowid), maq.maquina_id, c.codigo ?? null, c.valor ?? null,
      Number(c.producto) || null, c.activo === "1", numero(c.cantidad), numero(c.minimo), numero(c.maximo),
    ]);
    const actualizados = await insertarLote(db, "epay.canales", COLUMNAS_CANALES, filas,
      `(cuenta, canal_id) do update set maquina_id = excluded.maquina_id, codigo = excluded.codigo,
       seleccion = excluded.seleccion, producto_id = excluded.producto_id, activo = excluded.activo,
       cantidad = excluded.cantidad, minimo = excluded.minimo, maximo = excluded.maximo, actualizado = now()`);
    await db.query(
      "delete from epay.canales where cuenta = $1 and maquina_id = $2 and not (canal_id = any($3::int[]))",
      [epay.cuenta, maq.maquina_id, filas.map((f) => f[1])]
    );
    canales += actualizados;
  });
  return { canales, fallos_canales: fallos };
}

export async function tareaVentas(db, epay) {
  const ventasYPagos = await cargarVentasYPagos(db, epay, mesesRecientes());
  const canales = await cargarCanales(db, epay);
  return { ...ventasYPagos, ...canales };
}
