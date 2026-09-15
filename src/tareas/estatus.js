// Semáforo y datos de máquinas: detecta caídas, recuperaciones, altas, bajas y movimientos.

import { registrarEvento } from "../db.js";

// Cambios de estos campos entre una corrida y otra quedan como evento.
const CAMPOS_VIGILADOS = [
  ["cambio_modulo", "uid"],
  ["cambio_codigo_interno", "codigo_interno"],
  ["cambio_nombre", "nombre"],
  ["cambio_version", "version"],
];

export async function tareaEstatus(db, epay) {
  const [semaforo, maquinas] = await Promise.all([epay.estatus(), epay.maquinas()]);
  const colorPorId = new Map(semaforo.map((s) => [s.maquina_id, s.color]));
  const previas = new Map(
    (await db.query("select maquina_id, codigo_interno, nombre, uid, version, vigente from epay.maquinas where cuenta = $1", [epay.cuenta]))
      .rows.map((r) => [r.maquina_id, r])
  );
  const coloresPrevios = new Map(
    (await db.query("select maquina_id, color, desde from epay.estatus_actual where cuenta = $1", [epay.cuenta]))
      .rows.map((r) => [r.maquina_id, r])
  );
  const idsPorCodigo = new Map();
  for (const m of maquinas) {
    if (m.codigo_interno) idsPorCodigo.set(m.codigo_interno, [...(idsPorCodigo.get(m.codigo_interno) || []), m.maquina_id]);
  }

  let eventos = 0;
  const evento = async (maquinaId, tipo, antes, despues) => {
    await registrarEvento(db, epay.cuenta, maquinaId, tipo, antes, despues);
    eventos++;
  };

  for (const m of maquinas) {
    const prev = previas.get(m.maquina_id);
    if (!prev) {
      await evento(m.maquina_id, "alta", null, { codigo_interno: m.codigo_interno, nombre: m.nombre, uid: m.uid });
    } else {
      if (!prev.vigente) await evento(m.maquina_id, "reactivada", null, { codigo_interno: m.codigo_interno, nombre: m.nombre });
      for (const [tipo, campo] of CAMPOS_VIGILADOS) {
        if ((prev[campo] ?? null) === (m[campo] ?? null)) continue;
        const despues = { valor: m[campo], codigo_interno: m.codigo_interno };
        if (campo === "codigo_interno" && m.codigo_interno) {
          despues.tambien_en = idsPorCodigo.get(m.codigo_interno).filter((id) => id !== m.maquina_id);
        }
        await evento(m.maquina_id, tipo, { valor: prev[campo] }, despues);
      }
    }

    await db.query(
      `insert into epay.maquinas (cuenta, maquina_id, codigo_interno, nombre, uid, version, pago_hasta, ruta, inventario)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (cuenta, maquina_id) do update set
         codigo_interno = excluded.codigo_interno, nombre = excluded.nombre, uid = excluded.uid,
         version = excluded.version, pago_hasta = excluded.pago_hasta, ruta = excluded.ruta,
         inventario = excluded.inventario, vigente = true, ultima_vez = now()`,
      [epay.cuenta, m.maquina_id, m.codigo_interno, m.nombre, m.uid, m.version, m.pago_hasta, m.ruta, m.inventario]
    );

    const color = colorPorId.get(m.maquina_id);
    if (!color) continue; // no figura en "Estatus equipos"
    const previo = coloresPrevios.get(m.maquina_id);
    if (!previo) {
      await db.query(
        "insert into epay.estatus_actual (cuenta, maquina_id, color, desde, revisado) values ($1, $2, $3, now(), now())",
        [epay.cuenta, m.maquina_id, color]
      );
      continue;
    }
    if (previo.color !== color) {
      const minutos = Math.round((Date.now() - new Date(previo.desde).getTime()) / 60_000);
      await evento(m.maquina_id, color === "rojo" ? "caida" : "recuperacion",
        { color: previo.color, minutos_en_ese_color: minutos }, { color });
    }
    // En Postgres todas las expresiones del SET ven los valores anteriores de la fila.
    await db.query(
      `update epay.estatus_actual
       set desde = case when color <> $3 then now() else desde end, color = $3, revisado = now()
       where cuenta = $1 and maquina_id = $2`,
      [epay.cuenta, m.maquina_id, color]
    );
  }

  const vigentesHoy = new Set(maquinas.map((m) => m.maquina_id));
  for (const [id, prev] of previas) {
    if (prev.vigente && !vigentesHoy.has(id)) {
      await evento(id, "baja", { codigo_interno: prev.codigo_interno, nombre: prev.nombre }, { vigente: false });
      await db.query("update epay.maquinas set vigente = false where cuenta = $1 and maquina_id = $2", [epay.cuenta, id]);
    }
  }

  return {
    maquinas: maquinas.length,
    verdes: semaforo.filter((s) => s.color === "verde").length,
    rojas: semaforo.filter((s) => s.color === "rojo").length,
    eventos,
  };
}
