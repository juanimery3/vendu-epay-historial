// Cliente mínimo de epay.uno: login con usuario y clave, páginas del portal y API v1.
// Nunca imprime credenciales, nombres de máquinas ni montos: los logs del repo son públicos.

import { camposFormulario, esLogin, limpiar, parseTabla } from "./util.js";

const BASE = "https://www.epay.uno";
const UA = "Mozilla/5.0 (Vendu-Historial/1.0)";

export class Epay {
  constructor({ cuenta, usuario, clave, token }) {
    this.cuenta = cuenta;
    this.usuario = usuario;
    this.clave = clave;
    this.token = token;
    this.cookies = new Map();
    this.logins = 0; // se informa en cada corrida: la meta es depender lo menos posible del portal
  }

  async #pedir(ruta, { form, redirect = "follow" } = {}) {
    const res = await fetch(BASE + ruta, {
      method: form ? "POST" : "GET",
      headers: {
        Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        "User-Agent": UA,
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
      redirect,
      signal: AbortSignal.timeout(60_000),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const par = c.split(";")[0];
      const i = par.indexOf("=");
      if (i > 0) this.cookies.set(par.slice(0, i).trim(), par.slice(i + 1).trim());
    }
    return res;
  }

  async login() {
    if (!this.usuario || !this.clave) throw new Error("faltan credenciales");
    this.logins++;
    await this.#pedir("/login.php", { redirect: "manual" }); // siembra PHPSESSID
    // "enviar" es el botón del formulario: login.php exige isset($_POST['enviar']).
    const res = await this.#pedir("/login.php", {
      redirect: "manual",
      form: { user: this.usuario, pass: this.clave, location: "/cliente.php", enviar: "Entrar" },
    });
    const ok = (res.status >= 300 && res.status < 400) || (res.status === 200 && !esLogin(await res.text()));
    if (!ok) throw new Error("login rechazado por epay.uno");
  }

  // Un solo login compartido: dos logins simultáneos se invalidan la sesión entre sí.
  #sesion = null;

  #asegurarSesion() {
    if (!this.#sesion) {
      this.#sesion = this.login().catch((e) => {
        this.#sesion = null;
        throw e;
      });
    }
    return this.#sesion;
  }

  /** HTML de una página del portal; si la sesión venció, renueva el login (una vez para todos) y reintenta. */
  async pagina(ruta, form) {
    for (let intento = 0; intento < 2; intento++) {
      const sesion = this.#asegurarSesion();
      await sesion;
      const res = await this.#pedir(ruta, { form });
      if (!res.ok) throw new Error(`HTTP ${res.status} en ${ruta.split("?")[0]}`);
      const html = await res.text();
      if (!esLogin(html)) return html;
      if (this.#sesion === sesion) this.#sesion = null;
    }
    throw new Error(`sesión rechazada en ${ruta.split("?")[0]}`);
  }

  async #api(parametros) {
    const res = await this.#pedir("/api/?" + new URLSearchParams(parametros));
    if (!res.ok) throw new Error(`API HTTP ${res.status}`);
    const texto = await res.text();
    try {
      return JSON.parse(texto);
    } catch {
      throw new Error(`la API e=${parametros.e} no devolvió JSON`);
    }
  }

  /**
   * Flota con el token de la API (e=estatus): código interno, UID, MAC del módulo, activo, versión y
   * último acceso (UTC). Sin token válido epay responde 403.
   */
  async estatusApi() {
    const lista = await this.#api({ e: "estatus", token: this.token });
    if (!Array.isArray(lista)) throw new Error("e=estatus no devolvió una lista");
    return lista
      .map((m) => ({
        maquina_id: Number(m.rowid),
        codigo_interno: String(m.codigo ?? "").trim() || null,
        // El portal muestra el nombre sin espacios sobrantes; sin trim alternar API/portal simula cambios de nombre.
        nombre: String(m.nombre ?? "").trim() || null,
        uid: m.serial || null,
        modulo_mac: String(m.modulo ?? "").trim().toUpperCase() || null,
        activo_epay: m.activo === "1",
        version: m.version || null,
        // Los módulos que nunca reportaron traen fechas de relleno de hace años: se guardan como vacías.
        ultimo_acceso: /^20[2-9]\d-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(m.acceso ?? "")
          ? m.acceso.replace(" ", "T") + "Z"
          : null,
      }))
      .filter((m) => m.maquina_id > 0);
  }

  /** Endpoint con token: sin token no se llama (epay respondería 403). */
  #apiToken(parametros) {
    if (!this.token) throw new Error(`e=${parametros.e} requiere token de API`);
    return this.#api({ ...parametros, token: this.token });
  }

  /**
   * Cierres de lote del PDV de un día (e=cierres, equivale a reporte23.php "Cierres PDV").
   * `fecha` (AAAA-MM-DD) filtra por día UTC y las fechas del resultado vienen en UTC.
   */
  async cierresDia(fecha) {
    const lista = await this.#apiToken({ e: "cierres", fecha });
    if (!Array.isArray(lista)) throw new Error("e=cierres no devolvió una lista");
    return lista;
  }

  /** Todas las gift cards de la cuenta (e=gifts; ignora filtros). */
  async giftCards() {
    const lista = await this.#apiToken({ e: "gifts" });
    if (!Array.isArray(lista)) throw new Error("e=gifts no devolvió una lista");
    return lista;
  }

  /** Clientes con saldo (e=clientes; ignora filtros). DATOS PERSONALES: solo a la base, nunca a los logs. */
  async clientes() {
    const lista = await this.#apiToken({ e: "clientes" });
    if (!Array.isArray(lista)) throw new Error("e=clientes no devolvió una lista");
    return lista;
  }

  /** Semáforo "Estatus equipos" de reportes.php: verde = reportó hace menos de 1 h. */
  async estatus() {
    const html = await this.pagina("/reportes.php");
    const re = /<td class="col-md-1 (btn-danger|btn-success)">\s*([^<]*?)\s*<a href="maquinas\.php\?id=(\d+)"[\s\S]*?<small>([\s\S]*?)<\/small>/g;
    const lista = [...html.matchAll(re)].map((m) => ({
      maquina_id: Number(m[3]),
      codigo_interno: limpiar(m[2]) || null,
      color: m[1] === "btn-success" ? "verde" : "rojo",
    }));
    if (lista.length === 0) throw new Error('reportes.php sin la sección "Estatus equipos"');
    return lista;
  }

  /** Máquinas definidas (reporte7.php): código interno, nombre, versión, UID, pago, ruta, inventario. */
  async maquinas() {
    const filas = parseTabla(await this.pagina("/reporte7.php"));
    const lista = [];
    for (const f of filas) {
      const sys = (f["Codigo(sys)"] || "").match(/^(.*?)\s*\((\d+)\)\s*$/);
      if (!sys) continue;
      const vs = (f["(Version) Serial"] || "").match(/^\(([^)]*)\)\s*(\S*)/);
      lista.push({
        maquina_id: Number(sys[2]),
        codigo_interno: sys[1].trim() || null,
        nombre: f["Nombre"] || null,
        version: vs ? vs[1] || null : null,
        uid: vs && vs[2] ? vs[2] : null,
        pago_hasta: /^\d{4}-\d{2}-\d{2}$/.test(f["Pago Hasta"] || "") ? f["Pago Hasta"] : null,
        ruta: f["Ruta"] || null,
        inventario: f["Inventario"] || null,
      });
    }
    if (lista.length === 0) throw new Error("reporte7.php no devolvió máquinas");
    return lista;
  }

  /** Campos de la ficha maquinas.php?id= (coment = descripción). */
  async ficha(maquinaId) {
    const html = await this.pagina(`/maquinas.php?id=${Number(maquinaId)}`);
    const form = [...html.matchAll(/<form[^>]*>([\s\S]*?)<\/form>/gi)].find((f) => /name=["']rowid["']/i.test(f[1]));
    if (!form) throw new Error("ficha sin formulario de datos");
    return camposFormulario(form[1]);
  }

  /** Ventas de un módulo en un mes (API v1). Fechas en UTC. */
  ventasMes(uid, mes, anio) {
    return this.#api({ e: "venta", id: uid, m: String(mes), a: String(anio) });
  }

  /** Pagos de un módulo en un mes (API v1): los mismos del reporte de pagos externos. Fechas en UTC. */
  pagosMes(uid, mes, anio) {
    return this.#api({ e: "pago", id: uid, m: String(mes), a: String(anio) });
  }

  /** Productos cargados en un módulo, con precios y costos (API v1). */
  productos(uid) {
    return this.#api({ e: "prods", id: uid });
  }

  /** Canales (slots) de un módulo con producto, existencia, mínimo y máximo (API v1). */
  canales(uid) {
    return this.#api({ e: "canal", id: uid });
  }
}
