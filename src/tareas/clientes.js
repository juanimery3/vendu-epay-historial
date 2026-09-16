// Gift cards y clientes con saldo (API e=gifts y e=clientes con token, sin login).
// DATOS PERSONALES Y CÓDIGOS: solo van a la base; el resumen de la corrida lleva únicamente conteos.

import { insertarLote } from "../db.js";
import { diaCaracas, fechaApiUtc, numero } from "../util.js";

const COLUMNAS_GIFTS = [
  "cuenta", "codigo", "fecha", "vence", "monto", "unico", "usuario", "usado", "maquina_id", "grupo", "producto", "nota",
];
const COLUMNAS_CLIENTES = ["cuenta", "cliente_id", "codigo", "nombre", "apellido", "email", "telhome", "telmobil", "saldo"];
const COLUMNAS_SALDOS = ["cuenta", "cliente_id", "fecha", "saldo"];

const texto = (v) => (v === null || v === undefined ? null : String(v).trim() || null);

async function cargarGiftCards(db, epay) {
  const lista = await epay.giftCards();
  const previas = new Map(
    (await db.query("select codigo, usado is not null as usada from epay.gift_cards where cuenta = $1", [epay.cuenta]))
      .rows.map((r) => [r.codigo, r.usada])
  );
  // Fechas: se asumen en UTC como en las demás APIs (POR CONFIRMAR contra el portal).
  // usado = "0000-00-00 00:00:00" y maquina = null mientras la tarjeta no se usa.
  const filas = lista.filter((g) => texto(g.codigo)).map((g) => [
    epay.cuenta, texto(g.codigo), fechaApiUtc(g.fecha), fechaApiUtc(g.vence), numero(g.monto),
    g.unico === null || g.unico === undefined ? null : String(g.unico) === "1",
    texto(g.usuario), fechaApiUtc(g.usado), Number(g.maquina) > 0 ? Number(g.maquina) : null,
    texto(g.grupo), texto(g.producto), texto(g.nota),
  ]);
  await insertarLote(db, "epay.gift_cards", COLUMNAS_GIFTS, filas,
    `(cuenta, codigo) do update set
       fecha = coalesce(excluded.fecha, epay.gift_cards.fecha),
       vence = coalesce(excluded.vence, epay.gift_cards.vence),
       monto = coalesce(excluded.monto, epay.gift_cards.monto),
       unico = coalesce(excluded.unico, epay.gift_cards.unico),
       usuario = coalesce(excluded.usuario, epay.gift_cards.usuario),
       usado = coalesce(excluded.usado, epay.gift_cards.usado),
       maquina_id = coalesce(excluded.maquina_id, epay.gift_cards.maquina_id),
       grupo = coalesce(excluded.grupo, epay.gift_cards.grupo),
       producto = coalesce(excluded.producto, epay.gift_cards.producto),
       nota = coalesce(excluded.nota, epay.gift_cards.nota),
       visto_ultimo = now()`);
  return {
    gift_cards: filas.length,
    gift_cards_nuevas: filas.filter((f) => !previas.has(f[1])).length,
    gift_cards_usadas: filas.filter((f) => f[7]).length,
    gift_cards_recien_usadas: filas.filter((f) => f[7] && previas.get(f[1]) === false).length,
  };
}

async function cargarClientes(db, epay) {
  const lista = await epay.clientes();
  const filas = lista.filter((c) => Number(c.rowid) > 0).map((c) => [
    epay.cuenta, Number(c.rowid), texto(c.codigo), texto(c.nombre), texto(c.apellido), texto(c.email),
    texto(c.telhome), texto(c.telmobil), numero(c.saldo),
  ]);
  await insertarLote(db, "epay.clientes", COLUMNAS_CLIENTES, filas,
    `(cuenta, cliente_id) do update set
       codigo = coalesce(excluded.codigo, epay.clientes.codigo),
       nombre = coalesce(excluded.nombre, epay.clientes.nombre),
       apellido = coalesce(excluded.apellido, epay.clientes.apellido),
       email = coalesce(excluded.email, epay.clientes.email),
       telhome = coalesce(excluded.telhome, epay.clientes.telhome),
       telmobil = coalesce(excluded.telmobil, epay.clientes.telmobil),
       saldo = coalesce(excluded.saldo, epay.clientes.saldo),
       actualizado = now()`);

  // Foto diaria del saldo (día de Caracas): la última lectura del día queda como saldo de ese día.
  const hoy = diaCaracas();
  const saldos = filas.filter((f) => f[8] !== null).map((f) => [epay.cuenta, f[1], hoy, f[8]]);
  const saldosCambiados = await insertarLote(db, "epay.clientes_saldos", COLUMNAS_SALDOS, saldos,
    `(cuenta, cliente_id, fecha) do update set saldo = excluded.saldo, leido = now()
     where epay.clientes_saldos.saldo is distinct from excluded.saldo`);
  return { clientes: filas.length, saldos_del_dia: saldos.length, saldos_nuevos_o_cambiados: saldosCambiados };
}

export async function tareaClientes(db, epay) {
  const r = {};
  let fallos = 0;
  // Una fuente que falla no impide la otra.
  for (const cargar of [cargarGiftCards, cargarClientes]) {
    try {
      Object.assign(r, await cargar(db, epay));
    } catch {
      fallos++;
    }
  }
  if (fallos === 2) throw new Error("e=gifts y e=clientes fallaron");
  return { ...r, fallos };
}
