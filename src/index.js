// Uso:
//   node src/index.js esquema                       instala o actualiza las tablas y vistas
//   node src/index.js estatus                       semáforo + datos de máquinas (cada 10 min; API con token)
//   node src/index.js ventas                        ventas y pagos del mes + existencias por canal (cada hora; API)
//   node src/index.js fichas                        descripciones, pago hasta/ruta (portal, único login) y productos (cada 6 h)
//   node src/index.js historico AAAA-MM [AAAA-MM]   carga inicial de ventas y pagos desde un mes (API)
//   node src/index.js cierres [AAAA-MM-DD [AAAA-MM-DD]]
//                                                   cierres de lote del PDV: sin fechas, anteayer a hoy UTC (cada hora);
//                                                   con fechas, carga histórica día por día (API con token)
//   node src/index.js clientes                      gift cards, clientes y foto diaria de saldos (cada 6 h; API con token)
// Credenciales por variables de entorno: DATABASE_URL, EPAYUNO_USER/PASS, NEPTUNO_USER/PASS y,
// opcionales, EPAYUNO_API_TOKEN / NEPTUNO_API_TOKEN (estatus por API con MAC del módulo; cierres y clientes
// solo corren en las cuentas que tienen token).

import { readFile } from "node:fs/promises";
import { conectar } from "./db.js";
import { Epay } from "./epay.js";
import { tareaCierres } from "./tareas/cierres.js";
import { tareaClientes } from "./tareas/clientes.js";
import { tareaEstatus } from "./tareas/estatus.js";
import { tareaFichas } from "./tareas/fichas.js";
import { tareaHistorico } from "./tareas/historico.js";
import { tareaVentas } from "./tareas/ventas.js";

// token = token de la API de epay.uno (endpoints globales, ej. e=estatus); opcional por cuenta.
const CUENTAS = [
  { cuenta: "epayuno", usuario: process.env.EPAYUNO_USER, clave: process.env.EPAYUNO_PASS, token: process.env.EPAYUNO_API_TOKEN },
  { cuenta: "neptuno", usuario: process.env.NEPTUNO_USER, clave: process.env.NEPTUNO_PASS, token: process.env.NEPTUNO_API_TOKEN },
];

const [tarea, ...args] = process.argv.slice(2);

const TAREAS = {
  estatus: (db, epay) => tareaEstatus(db, epay),
  ventas: (db, epay) => tareaVentas(db, epay),
  fichas: (db, epay) => tareaFichas(db, epay),
  historico: async (db, epay) => {
    await tareaEstatus(db, epay); // asegura la lista de máquinas antes de pedir sus ventas
    return tareaHistorico(db, epay, args[0], args[1] || undefined);
  },
  cierres: (db, epay) => tareaCierres(db, epay, args[0], args[1]),
  clientes: (db, epay) => tareaClientes(db, epay),
};
// Tareas que solo existen con el token de la API: la cuenta sin token se omite sin error.
const SOLO_CON_TOKEN = new Set(["cierres", "clientes"]);
const DIA = /^\d{4}-\d{2}-\d{2}$/;

async function main() {
  if (tarea === "historico" && (!/^\d{4}-\d{2}$/.test(args[0] || "") || (args[1] && !/^\d{4}-\d{2}$/.test(args[1])))) {
    console.error("Uso: node src/index.js historico AAAA-MM [AAAA-MM]");
    return 2;
  }
  if (tarea === "cierres" && ((args[0] && !DIA.test(args[0])) || (args[1] && !DIA.test(args[1])))) {
    console.error("Uso: node src/index.js cierres [AAAA-MM-DD [AAAA-MM-DD]]");
    return 2;
  }
  if (tarea !== "esquema" && !TAREAS[tarea]) {
    console.error("Uso: node src/index.js esquema | estatus | ventas | fichas | historico AAAA-MM [AAAA-MM] | cierres [AAAA-MM-DD [AAAA-MM-DD]] | clientes");
    return 2;
  }

  // Sin base configurada (secretos aún no cargados en GitHub) se avisa y se sale sin error,
  // para no generar un fallo —y un correo— cada 10 minutos.
  if (!process.env.DATABASE_URL && !process.env.PGLITE) {
    console.log("::warning::Falta el secreto DATABASE_URL: la sincronización está en pausa (ver README, paso 3)");
    return 0;
  }

  const db = await conectar();
  try {
    if (tarea === "esquema") {
      await db.exec(await readFile(new URL("../sql/001_esquema.sql", import.meta.url), "utf8"));
      console.log("Esquema epay instalado o actualizado");
      return 0;
    }

    let configuradas = 0, fallidas = 0;
    for (const c of CUENTAS) {
      if (!(c.usuario && c.clave) && !c.token) {
        console.log(`::warning::${c.cuenta}: faltan los secretos de epay.uno (usuario y clave o token), se omite`);
        continue;
      }
      if (SOLO_CON_TOKEN.has(tarea) && !c.token) {
        console.log(`${c.cuenta} · ${tarea} · sin token de API, se omite`);
        continue;
      }
      configuradas++;
      const inicio = new Date();
      const epay = new Epay(c);
      let ok = true, resumen;
      try {
        resumen = await TAREAS[tarea](db, epay);
      } catch (e) {
        ok = false;
        fallidas++;
        resumen = { error: String(e?.message ?? e).slice(0, 200) };
      }
      resumen.logins = epay.logins;
      const segundos = ((Date.now() - inicio.getTime()) / 1000).toFixed(1);
      console.log(`${c.cuenta} · ${tarea} · ${ok ? "ok" : "ERROR"} · ${segundos} s · ${JSON.stringify(resumen)}`);
      await db.query(
        "insert into epay.corridas (tarea, cuenta, inicio, ok, resumen) values ($1, $2, $3, $4, $5)",
        [tarea, c.cuenta, inicio.toISOString(), ok, JSON.stringify(resumen)]
      ).catch(() => {});
    }
    return fallidas > 0 ? 1 : 0;
  } finally {
    await db.end();
  }
}

process.exitCode = await main();
