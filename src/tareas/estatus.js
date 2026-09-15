// Semáforo y datos de máquinas: detecta caídas, recuperaciones, altas, bajas y movimientos.
// Con token usa la API e=estatus (trae la MAC del módulo y el último acceso); sin token, el portal.

import { registrarEvento } from "../db.js";

const MINUTOS_VERDE = 60; // igual que "Estatus equipos": verde = reportó hace menos de 1 hora

// Cambios de estos campos entre una corrida y otra quedan como evento.
const CAMPOS_VIGILADOS = [
  ["cambio_modulo", "uid"],
  ["cambio_mac", "modulo_mac"],
  ["cambio_codigo_interno", "codigo_interno"],
  ["cambio_nombre", "nombre"],
  ["cambio_version", "version"],
];

async function leerDesdeApi(epay) {
  const lista = await epay.estatusApi();
  const limite = Date.now() - MINUTOS_VERDE * 60_000;
  // El dashboard solo muestra las activas; las inactivas quedan sin color.
  const colores = new Map(lista.filter((m) => m.activo_epay).map((m) => [
    m.maquina_id,
    m.ultimo_acceso && Date.parse(m.ultimo_acceso) >= limite ? "verde" : "rojo",
  ]));
  if (epay.usuario && epay.clave) {
    // Pago hasta, ruta e inventario solo salen en reporte7.php; si falla, se conservan los guardados.
    try {
      const extra = new Map((await epay.maquinas()).map((m) => [m.maquina_id, m]));
      for (const m of lista) Object.assign(m, pick(extra.get(m.maquina_id), ["pago_hasta", "ruta", "inventario"]));
    } catch {
      /* se sigue con los datos de la API */
    }
  }
  return { maquinas: lista, colores, fuente: "api" };
}

async function leerDesdePortal(epay) {
  const [semaforo, lista] = await Promise.all([epay.estatus(), epay.maquinas()]);
  return { maquinas: lista, colores: new Map(semaforo.map((s) => [s.maquina_id, s.color])), fuente: "portal" };
}

function pick(obj, campos) {
  const out = {};
  for (const c of campos) if (obj && obj[c] !== undefined) out[c] = obj[c];
  return out;
}

export async function tareaEstatus(db, epay) {
  const { maquinas, colores, fuente } = epay.token ? await leerDesdeApi(epay) : await leerDesdePortal(epay);

  const previas = new Map(
    (await db.query(
      "select maquina_id, codigo_interno, nombre, uid, version, modulo_mac, vigente from epay.maquinas where cuenta = $1",
      [epay.cuenta]
    )).rows.map((r) => [r.maquina_id, r])
  );
  const coloresPrevios = new Map(
    (await db.query("select maquina_id, color, desde from epay.estatus_actual where cuenta = $1", [epay.cuenta]))
      .rows.map((r) => [r.maquina_id, r])
  );
  const idsPor = (campo) => {
    const mapa = new Map();
    for (const m of maquinas) if (m[campo]) mapa.set(m[campo], [...(mapa.get(m[campo]) || []), m.maquina_id]);
    return mapa;
  };
  const compartidos = { codigo_interno: idsPor("codigo_interno"), modulo_mac: idsPor("modulo_mac") };

  let eventos = 0;
  const evento = async (maquinaId, tipo, antes, despues) => {
    await registrarEvento(db, epay.cuenta, maquinaId, tipo, antes, despues);
    eventos++;
  };

  for (const m of maquinas) {
    const prev = previas.get(m.maquina_id);
    if (!prev) {
      await evento(m.maquina_id, "alta", null, {
        codigo_interno: m.codigo_interno, nombre: m.nombre, uid: m.uid, modulo_mac: m.modulo_mac ?? null,
      });
    } else {
      if (!prev.vigente) await evento(m.maquina_id, "reactivada", null, { codigo_interno: m.codigo_interno, nombre: m.nombre });
      for (const [tipo, campo] of CAMPOS_VIGILADOS) {
        if (!(campo in m)) continue; // la fuente de esta corrida no trae el campo (ej. MAC sin token)
        if (campo === "modulo_mac" && prev[campo] == null) continue; // primera vez que se conoce la MAC
        if ((prev[campo] ?? null) === (m[campo] ?? null)) continue;
        const despues = { valor: m[campo], codigo_interno: m.codigo_interno };
        if (compartidos[campo] && m[campo]) {
          despues.tambien_en = compartidos[campo].get(m[campo]).filter((id) => id !== m.maquina_id);
        }
        await evento(m.maquina_id, tipo, { valor: prev[campo] }, despues);
      }
    }

    // coalesce: una fuente que no trae un dato no borra el que ya estaba guardado.
    await db.query(
      `insert into epay.maquinas (cuenta, maquina_id, codigo_interno, nombre, uid, version, pago_hasta, ruta, inventario,
                                  modulo_mac, activo_epay, ultimo_acceso)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (cuenta, maquina_id) do update set
         codigo_interno = excluded.codigo_interno, nombre = excluded.nombre, uid = excluded.uid,
         version = excluded.version,
         pago_hasta = coalesce(excluded.pago_hasta, epay.maquinas.pago_hasta),
         ruta = coalesce(excluded.ruta, epay.maquinas.ruta),
         inventario = coalesce(excluded.inventario, epay.maquinas.inventario),
         modulo_mac = coalesce(excluded.modulo_mac, epay.maquinas.modulo_mac),
         activo_epay = coalesce(excluded.activo_epay, epay.maquinas.activo_epay),
         ultimo_acceso = coalesce(excluded.ultimo_acceso, epay.maquinas.ultimo_acceso),
         vigente = true, ultima_vez = now()`,
      [
        epay.cuenta, m.maquina_id, m.codigo_interno, m.nombre, m.uid, m.version,
        m.pago_hasta ?? null, m.ruta ?? null, m.inventario ?? null,
        m.modulo_mac ?? null, m.activo_epay ?? null, m.ultimo_acceso ?? null,
      ]
    );

    const color = colores.get(m.maquina_id);
    if (!color) continue; // no figura en el semáforo (inactiva)
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
        { color: previo.color, minutos_en_ese_color: minutos }, { color, ultimo_acceso: m.ultimo_acceso ?? null });
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

  const valores = [...colores.values()];
  return {
    fuente,
    maquinas: maquinas.length,
    verdes: valores.filter((c) => c === "verde").length,
    rojas: valores.filter((c) => c === "rojo").length,
    eventos,
  };
}
