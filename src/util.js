// Utilidades de texto, HTML y fechas.

export function decodificar(s) {
  return String(s)
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

export function limpiar(s) {
  return decodificar(String(s ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** true si el HTML es la página de login (sesión ausente o vencida). */
export function esLogin(html) {
  const b = html.toLowerCase();
  return b.includes('type="password"') && b.includes("login.php");
}

/**
 * Filas de la tabla con más filas de la página, con la primera fila de <th> como cabecera.
 * Las tablas de epay.uno no usan <thead>/<tbody>.
 */
export function parseTabla(html) {
  let mejor = [];
  for (const t of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)) {
    const trs = [...t[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    if (trs.length > mejor.length) mejor = trs;
  }
  let cabecera = [];
  const filas = [];
  for (const tr of mejor) {
    const ths = [...tr[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => limpiar(m[1]));
    const tds = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => limpiar(m[1]));
    if (tds.length === 0) {
      if (ths.length > 1 && cabecera.length === 0) cabecera = ths;
      continue;
    }
    filas.push(Object.fromEntries(tds.map((v, i) => [cabecera[i] || `col_${i}`, v])));
  }
  return filas;
}

/** name → value de inputs, selects y textareas de un formulario. */
export function camposFormulario(html) {
  const campos = {};
  for (const [tag] of html.matchAll(/<input[^>]*>/gi)) {
    const nombre = (tag.match(/name=["']([^"']+)["']/i) || [])[1];
    if (!nombre) continue;
    const tipo = ((tag.match(/type=["']([^"']+)["']/i) || [])[1] || "text").toLowerCase();
    if (["submit", "button", "file", "image"].includes(tipo)) continue;
    if ((tipo === "checkbox" || tipo === "radio") && !/\schecked[\s>=/]/i.test(tag)) continue;
    campos[nombre] = decodificar((tag.match(/value=["']([^"']*)["']/i) || [])[1] ?? "");
  }
  for (const [, nombre, opciones] of html.matchAll(/<select[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/select>/gi)) {
    const todas = [...opciones.matchAll(/<option([^>]*)>/gi)].map((o) => o[1]);
    const elegida = todas.find((o) => /selected/i.test(o)) ?? todas[0] ?? "";
    campos[nombre] = decodificar((elegida.match(/value=["']([^"']*)["']/i) || [])[1] ?? "");
  }
  for (const [, nombre, valor] of html.matchAll(/<textarea[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/textarea>/gi)) {
    campos[nombre] = decodificar(valor).trim();
  }
  return campos;
}

/** "2,663.96" → 2663.96; texto vacío o inválido → null. */
export function numero(s) {
  const n = parseFloat(String(s ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Fecha YYYY-MM-DD en Caracas (UTC−4 fijo), desplazada en días. */
export function diaCaracas(desplazamientoDias = 0) {
  return new Date(Date.now() - 4 * 3600_000 + desplazamientoDias * 86_400_000).toISOString().slice(0, 10);
}

/** Ejecuta fn sobre items con como máximo `limite` tareas simultáneas. */
export async function enParalelo(items, limite, fn) {
  const resultados = new Array(items.length);
  let siguiente = 0;
  const trabajadores = Array.from({ length: Math.min(limite, items.length) }, async () => {
    while (siguiente < items.length) {
      const i = siguiente++;
      resultados[i] = await fn(items[i], i);
    }
  });
  await Promise.all(trabajadores);
  return resultados;
}
