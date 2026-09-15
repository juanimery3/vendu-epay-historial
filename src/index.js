// Uso:
//   node src/index.js esquema                       instala o actualiza las tablas y vistas
//   node src/index.js estatus                       semáforo + datos de máquinas (cada 10 min)
//   node src/index.js ventas                        ventas del mes y pagos de ayer y hoy (cada hora)
//   node src/index.js fichas                        descripciones y productos (cada 6 h)
//   node src/index.js historico AAAA-MM [AAAA-MM]   carga inicial desde un mes
// Credenciales por variables de entorno: DATABASE_URL, EPAYUNO_USER/PASS, NEPTUNO_USER/PASS.

import { readFile } from "node:fs/promises";
import { conectar } from "./db.js";
import { Epay } from "./epay.js";
import { tareaEstatus } from "./tareas/estatus.js";
import { tareaFichas } from "./tareas/fichas.js";
import { tareaHistorico } from "./tareas/historico.js";
import { tareaVentas } from "./tareas/ventas.js";

const CUENTAS = [
  { cuenta: "epayuno", usuario: process.env.EPAYUNO_USER, clave: process.env.EPAYUNO_PASS },
  { cuenta: "neptuno", usuario: process.env.NEPTUNO_USER, clave: process.env.NEPTUNO_PASS },
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
};

async function main() {
  if (tarea === "historico" && (!/^\d{4}-\d{2}$/.test(args[0] || "") || (args[1] && !/^\d{4}-\d{2}$/.test(args[1])))) {
    console.error("Uso: node src/index.js historico AAAA-MM [AAAA-MM]");
    return 2;
  }
  if (tarea !== "esquema" && !TAREAS[tarea]) {
    console.error("Uso: node src/index.js esquema | estatus | ventas | fichas | historico AAAA-MM [AAAA-MM]");
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
      if (!c.usuario || !c.clave) {
        console.log(`::warning::${c.cuenta}: faltan los secretos de usuario y clave de epay.uno, se omite`);
        continue;
      }
      configuradas++;
      const inicio = new Date();
      let ok = true, resumen;
      try {
        resumen = await TAREAS[tarea](db, new Epay(c));
      } catch (e) {
        ok = false;
        fallidas++;
        resumen = { error: String(e?.message ?? e).slice(0, 200) };
      }
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
