// Conexión a Postgres (Supabase) o, para pruebas locales, a PGlite en memoria (PGLITE=1).

export async function conectar() {
  if (process.env.PGLITE) {
    const { PGlite } = await import("@electric-sql/pglite");
    const pg = new PGlite();
    return { query: (sql, params) => pg.query(sql, params), exec: (sql) => pg.exec(sql), end: () => pg.close() };
  }
  if (!process.env.DATABASE_URL) throw new Error("Falta DATABASE_URL");
  const { default: pg } = await import("pg");
  // El certificado del pooler de Supabase no está en el almacén de Node: se cifra sin verificar la cadena.
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 4 });
  return { query: (sql, params) => pool.query(sql, params), exec: (sql) => pool.query(sql), end: () => pool.end() };
}

/**
 * INSERT de muchas filas en lotes. `alConflicto` es lo que va después de ON CONFLICT,
 * ej. "(cuenta, venta_id) do nothing". Devuelve cuántas filas se insertaron o actualizaron.
 */
export async function insertarLote(db, tabla, columnas, filas, alConflicto, tamano = 300) {
  let afectadas = 0;
  for (let i = 0; i < filas.length; i += tamano) {
    const lote = filas.slice(i, i + tamano);
    const valores = [];
    const marcas = lote.map((fila, r) => {
      valores.push(...fila);
      return "(" + fila.map((_, c) => "$" + (r * columnas.length + c + 1)).join(", ") + ")";
    });
    const res = await db.query(
      `insert into ${tabla} (${columnas.join(", ")}) values ${marcas.join(", ")} on conflict ${alConflicto} returning 1`,
      valores
    );
    afectadas += res.rows.length;
  }
  return afectadas;
}

export async function registrarEvento(db, cuenta, maquinaId, tipo, antes, despues) {
  await db.query(
    "insert into epay.eventos (cuenta, maquina_id, tipo, antes, despues) values ($1, $2, $3, $4, $5)",
    [cuenta, maquinaId, tipo, antes === null ? null : JSON.stringify(antes), JSON.stringify(despues)]
  );
}
