-- Historial propio de epay.uno (cuentas Epay.Uno y Neptuno) en Supabase / Postgres 15+.
-- Idempotente: se puede correr las veces que haga falta (workflow "Instalar base" o `node src/index.js esquema`).
-- El esquema epay NO queda expuesto por la API pública de Supabase: se consulta en el SQL Editor,
-- en el Table Editor o con la cadena de conexión.

create schema if not exists epay;
revoke all on schema epay from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema epay from anon, authenticated';
  end if;
end $$;

-- Máquinas tal como las muestra epay (reporte7.php + ficha). maquina_id es el registro del módulo en epay.
create table if not exists epay.maquinas (
  cuenta         text    not null check (cuenta in ('epayuno', 'neptuno')),
  maquina_id     integer not null,
  codigo_interno text,                                   -- "Codigo interno" de la ficha, ej. C15-KURICA
  nombre         text,
  descripcion    text,
  uid            text,                                   -- serial del módulo Epay
  version        text,                                   -- 239, k414…
  es_k           boolean generated always as (version like 'k%') stored,
  ubikode        text    generated always as (substring(nombre from 'U[0-9]{7}')) stored,
  pago_hasta     date,
  ruta           text,
  inventario     text,
  vigente        boolean not null default true,          -- false si dejó de aparecer en epay
  primera_vez    timestamptz not null default now(),
  ultima_vez     timestamptz not null default now(),
  primary key (cuenta, maquina_id)
);
-- Datos que solo trae la API con token (e=estatus).
alter table epay.maquinas add column if not exists modulo_mac    text;         -- MAC del módulo físico
alter table epay.maquinas add column if not exists activo_epay   boolean;      -- false = epay no la muestra en el dashboard
alter table epay.maquinas add column if not exists ultimo_acceso timestamptz;  -- último reporte del módulo

-- Color actual del semáforo ("Estatus equipos"): verde = reportó hace menos de 1 h.
create table if not exists epay.estatus_actual (
  cuenta     text    not null,
  maquina_id integer not null,
  color      text    not null check (color in ('verde', 'rojo')),
  desde      timestamptz not null,                      -- desde cuándo está en ese color
  revisado   timestamptz not null,
  primary key (cuenta, maquina_id)
);

-- Todo lo que cambia: caídas, recuperaciones, módulos y códigos internos movidos, nombres, descripciones.
create table if not exists epay.eventos (
  id         bigint generated always as identity primary key,
  fecha      timestamptz not null default now(),
  cuenta     text    not null,
  maquina_id integer not null,
  tipo       text    not null,   -- alta, baja, reactivada, caida, recuperacion, cambio_modulo, cambio_mac,
                                 -- cambio_codigo_interno, cambio_nombre, cambio_version, cambio_descripcion
  antes      jsonb,
  despues    jsonb   not null
);
create index if not exists eventos_fecha on epay.eventos (fecha desc);
create index if not exists eventos_maquina on epay.eventos (cuenta, maquina_id, fecha desc);
create index if not exists eventos_tipo on epay.eventos (tipo, fecha desc);

-- Ventas una por una (API e=venta). codigo_interno es el que figuraba en la venta: "Compra (I03-IND01)".
create table if not exists epay.ventas (
  cuenta         text    not null,
  venta_id       bigint  not null,
  maquina_id     integer not null,
  uid            text,
  codigo_interno text,
  fecha          timestamptz not null,
  producto_id    integer,
  monto_bs       numeric(14, 2),
  monto_usd      numeric(12, 2),
  tasa           numeric(14, 4),
  cliente_id     integer,
  tid            text,
  descripcion    text,
  cargada        timestamptz not null default now(),
  primary key (cuenta, venta_id)
);
create index if not exists ventas_maquina_fecha on epay.ventas (cuenta, maquina_id, fecha);
create index if not exists ventas_fecha on epay.ventas (fecha);

-- Pagos en la máquina (reporte22.php): PDV, débito inmediato, gift card…
create table if not exists epay.pagos_externos (
  cuenta         text not null,
  huella         text not null,                          -- sha1 de fecha|máquina|referencia|monto|medio|respuesta
  fecha          timestamptz not null,
  maquina_id     integer,
  codigo_interno text,
  medio          text,
  respuesta      text,
  estatus        text,
  monto_bs       numeric(14, 2),
  referencia     text,
  cargado        timestamptz not null default now(),
  primary key (cuenta, huella)
);
create index if not exists pagos_maquina_fecha on epay.pagos_externos (cuenta, maquina_id, fecha);

-- Productos con precios y costos (API e=prods).
create table if not exists epay.productos (
  cuenta      text    not null,
  producto_id integer not null,
  codigo      text,
  nombre      text,
  categoria   text,
  precio_bs   numeric(14, 2),
  precio_usd  numeric(12, 2),
  costo_bs    numeric(14, 2),
  costo_usd   numeric(12, 4),
  iva         numeric(8, 4),
  actualizado timestamptz not null default now(),
  primary key (cuenta, producto_id)
);

-- Catálogo oficial de medios de pago de epay.uno (confirmado por epay el 16-09-2026).
-- Mantener igual a MEDIOS en src/tareas/ventas.js.
create table if not exists epay.medios_pago (
  codigo text primary key,                               -- medio_codigo de la API e=pago
  nombre text not null
);
insert into epay.medios_pago (codigo, nombre) values
  ('1', 'TC / TD'), ('2', 'PDV'), ('3', 'Pago Móvil'), ('4', 'Yappy'), ('5', 'ePay QR'), ('6', 'Yappy QR'),
  ('7', 'Débito Inmediato'), ('8', 'BioPago BDV'), ('9', 'Nequi'), ('10', 'BreB'), ('11', 'Gift Card'),
  ('12', 'Commodo')
on conflict (codigo) do update set nombre = excluded.nombre;

-- Pagos por módulo desde la API e=pago (sin login). Coinciden con el reporte de pagos externos.
-- medio_codigo: ver epay.medios_pago.
create table if not exists epay.pagos (
  cuenta       text    not null,
  pago_id      bigint  not null,                         -- rowid de la API
  maquina_id   integer not null,
  uid          text,
  fecha        timestamptz not null,                     -- la API la da en UTC
  monto_bs     numeric(14, 2),
  medio_codigo text,
  medio        text,
  ref          text,                                     -- referencia / aprobación
  ref2         text,                                     -- lote / referencia bancaria
  cliente_id   integer,
  cargado      timestamptz not null default now(),
  primary key (cuenta, pago_id)
);
create index if not exists pagos_api_maquina_fecha on epay.pagos (cuenta, maquina_id, fecha);
create index if not exists pagos_api_fecha on epay.pagos (fecha);
-- Nombre del medio según el catálogo oficial, también para los pagos guardados como "código N" (idempotente).
update epay.pagos p
set medio = m.nombre
from epay.medios_pago m
where m.codigo = p.medio_codigo and p.medio is distinct from m.nombre;

-- Existencias por canal (slot) de cada máquina desde la API e=canal (sin login). Foto de la última lectura.
create table if not exists epay.canales (
  cuenta      text    not null,
  canal_id    integer not null,                          -- rowid de la API
  maquina_id  integer not null,
  codigo      text,                                      -- slot
  seleccion   text,                                      -- número que marca el cliente
  producto_id integer,
  activo      boolean,
  cantidad    numeric(10, 2),
  minimo      numeric(10, 2),
  maximo      numeric(10, 2),
  actualizado timestamptz not null default now(),
  primary key (cuenta, canal_id)
);
create index if not exists canales_maquina on epay.canales (cuenta, maquina_id);

-- Cierres de lote del PDV desde la API e=cierres (con token). Equivale a reporte23.php "Cierres PDV".
-- Regla Ubii (dada por Juan; días calendario, feriados no considerados, POR CONFIRMAR):
--   * Ubii corta sus lotes a las 19:00 de Caracas: un cierre antes de las 19:00 del día local D entra en el
--     lote de D; a las 19:00 o después, en el lote de D+1 (lote_ubii).
--   * Débito y Master se liquidan el día calendario siguiente al lote (liquidacion_debito).
--   * Visa se liquida el día hábil siguiente a liquidacion_debito, saltando solo sábado y domingo
--     (liquidacion_visa).
create table if not exists epay.cierres (
  cuenta         text    not null,
  cierre_id      bigint  not null,                       -- rowid de la API, único por cierre
  maquina_id     integer not null,
  codigo_interno text,                                   -- el que tenía la máquina al cerrar
  uid            text,                                   -- serial del módulo
  fecha          timestamptz not null,                   -- la API la da en UTC
  dia_local      date generated always as ((fecha at time zone 'America/Caracas')::date) stored,
  lote_ubii      date generated always as (((fecha at time zone 'America/Caracas') + interval '5 hours')::date) stored,
  liquidacion_debito date generated always as ((((fecha at time zone 'America/Caracas') + interval '5 hours')::date + 1)) stored,
  liquidacion_visa   date generated always as (
    (((fecha at time zone 'America/Caracas') + interval '5 hours')::date + 1) + case extract(isodow from (((fecha at time zone 'America/Caracas') + interval '5 hours')::date + 1)) when 5 then 3 when 6 then 2 else 1 end
  ) stored,
  creado         timestamptz not null default now(),
  actualizado    timestamptz not null default now(),
  primary key (cuenta, cierre_id)
);
create index if not exists cierres_dia on epay.cierres (cuenta, dia_local, maquina_id);
create index if not exists cierres_liquidacion on epay.cierres (cuenta, liquidacion_debito);
create index if not exists cierres_maquina_fecha on epay.cierres (cuenta, maquina_id, fecha desc);

-- Gift cards desde la API e=gifts (con token). Fechas asumidas en UTC (POR CONFIRMAR).
-- usado null = no se ha usado (la API manda "0000-00-00 00:00:00" y maquina null).
create table if not exists epay.gift_cards (
  cuenta        text not null,
  codigo        text not null,
  fecha         timestamptz,
  vence         timestamptz,
  monto         numeric,                                 -- hay montos de ~10^8: sin precisión fija
  unico         boolean,
  usuario       text,
  usado         timestamptz,
  maquina_id    integer,                                 -- dónde se usó
  grupo         text,
  producto      text,
  nota          text,
  visto_primero timestamptz not null default now(),
  visto_ultimo  timestamptz not null default now(),
  primary key (cuenta, codigo)
);
create index if not exists gift_cards_usado on epay.gift_cards (cuenta, usado);

-- Clientes con saldo desde la API e=clientes (con token). DATOS PERSONALES: nunca a los logs.
create table if not exists epay.clientes (
  cuenta      text    not null,
  cliente_id  integer not null,                          -- rowid de la API (= cliente_id de ventas y pagos)
  codigo      text,
  nombre      text,
  apellido    text,
  email       text,
  telhome     text,
  telmobil    text,
  saldo       numeric,
  creado      timestamptz not null default now(),
  actualizado timestamptz not null default now(),
  primary key (cuenta, cliente_id)
);

-- Foto diaria del saldo de cada cliente (día de Caracas; la última lectura del día manda).
create table if not exists epay.clientes_saldos (
  cuenta     text    not null,
  cliente_id integer not null,
  fecha      date    not null,
  saldo      numeric not null,
  leido      timestamptz not null default now(),
  primary key (cuenta, cliente_id, fecha)
);

-- Bitácora de cada ejecución: permite ver si la sincronización se detuvo (huecos).
create table if not exists epay.corridas (
  id      bigint generated always as identity primary key,
  tarea   text not null,
  cuenta  text not null,
  inicio  timestamptz not null,
  fin     timestamptz not null default now(),
  ok      boolean not null,
  resumen jsonb
);
create index if not exists corridas_inicio on epay.corridas (inicio desc);

-- ── Vistas ───────────────────────────────────────────────────────────────────

-- Semáforo actual con código interno, minutos en ese color, MAC del módulo y minutos sin reportar.
-- (Columnas nuevas siempre al final: CREATE OR REPLACE VIEW no permite reordenar.)
create or replace view epay.v_estatus as
select m.cuenta, m.maquina_id, m.codigo_interno, m.nombre, m.ubikode, m.uid, m.es_k,
       e.color, e.desde as en_este_color_desde,
       round(extract(epoch from now() - e.desde) / 60)::int as minutos_en_este_color,
       e.revisado,
       m.modulo_mac, m.ultimo_acceso at time zone 'America/Caracas' as ultimo_acceso_caracas,
       round(extract(epoch from now() - m.ultimo_acceso) / 60)::int as minutos_sin_reportar
from epay.maquinas m
left join epay.estatus_actual e using (cuenta, maquina_id)
where m.vigente;

-- Caídas y recuperaciones, lo más reciente primero.
create or replace view epay.v_caidas as
select ev.fecha at time zone 'America/Caracas' as fecha_caracas, ev.cuenta, ev.maquina_id,
       m.codigo_interno, m.nombre, ev.tipo,
       (ev.antes ->> 'minutos_en_ese_color')::int as minutos_en_color_anterior
from epay.eventos ev
left join epay.maquinas m using (cuenta, maquina_id)
where ev.tipo in ('caida', 'recuperacion')
order by ev.fecha desc;

-- Movimientos: módulo cambiado, código interno cambiado, renombres, altas y bajas.
create or replace view epay.v_movimientos as
select ev.fecha at time zone 'America/Caracas' as fecha_caracas, ev.cuenta, ev.maquina_id,
       m.codigo_interno as codigo_actual, ev.tipo, ev.antes, ev.despues
from epay.eventos ev
left join epay.maquinas m using (cuenta, maquina_id)
where ev.tipo not in ('caida', 'recuperacion')
order by ev.fecha desc;

-- Un mismo código interno en dos registros vigentes: módulo movido sin actualizar la ficha.
create or replace view epay.v_codigos_repetidos as
select cuenta, codigo_interno, count(*) as registros,
       string_agg(maquina_id::text || ' ' || coalesce(nombre, ''), ' | ' order by maquina_id) as maquinas
from epay.maquinas
where vigente and codigo_interno is not null
group by cuenta, codigo_interno
having count(*) > 1;

-- Un mismo módulo físico (MAC) en dos registros vigentes: módulo movido o ficha duplicada.
create or replace view epay.v_mac_repetidas as
select cuenta, modulo_mac, count(*) as registros,
       string_agg(coalesce(codigo_interno, '(sin código)') || ' · ' || maquina_id, ' | ' order by maquina_id) as maquinas
from epay.maquinas
where vigente and modulo_mac is not null and modulo_mac <> ''
group by cuenta, modulo_mac
having count(*) > 1;

-- Con qué código interno se registraron las ventas de cada módulo: si cambia, el módulo se movió.
create or replace view epay.v_codigo_en_ventas as
select v.cuenta, v.maquina_id, m.codigo_interno as codigo_actual, v.codigo_interno as codigo_en_venta,
       min(v.fecha at time zone 'America/Caracas') as primera_venta,
       max(v.fecha at time zone 'America/Caracas') as ultima_venta,
       count(*) as ventas,
       v.codigo_interno is distinct from m.codigo_interno as distinto_al_actual
from epay.ventas v
left join epay.maquinas m using (cuenta, maquina_id)
group by v.cuenta, v.maquina_id, m.codigo_interno, v.codigo_interno
order by v.cuenta, v.maquina_id, primera_venta;

-- Ventas por día (hora de Caracas) y máquina.
create or replace view epay.v_ventas_dia as
select v.cuenta, (v.fecha at time zone 'America/Caracas')::date as dia, v.maquina_id,
       m.codigo_interno, m.nombre,
       count(*) as ventas, sum(v.monto_bs) as monto_bs, sum(v.monto_usd) as monto_usd
from epay.ventas v
left join epay.maquinas m using (cuenta, maquina_id)
group by 1, 2, 3, 4, 5;

-- Pagos por día (hora de Caracas), máquina y medio.
create or replace view epay.v_pagos_dia as
select p.cuenta, (p.fecha at time zone 'America/Caracas')::date as dia, p.maquina_id, m.codigo_interno, p.medio,
       count(*) as pagos, sum(p.monto_bs) as monto_bs
from epay.pagos p
left join epay.maquinas m using (cuenta, maquina_id)
group by 1, 2, 3, 4, 5;

-- Ventas contra pagos por día y máquina: diferencia_bs distinta de 0 = pagos sin despacho o despachos sin pago.
create or replace view epay.v_ventas_vs_pagos as
with v as (
  select cuenta, (fecha at time zone 'America/Caracas')::date as dia, maquina_id,
         count(*) as ventas, sum(monto_bs) as ventas_bs
  from epay.ventas group by 1, 2, 3
), p as (
  select cuenta, (fecha at time zone 'America/Caracas')::date as dia, maquina_id,
         count(*) as pagos, sum(monto_bs) as pagos_bs
  from epay.pagos group by 1, 2, 3
)
select cuenta, dia, maquina_id, m.codigo_interno,
       coalesce(v.ventas, 0) as ventas, coalesce(p.pagos, 0) as pagos,
       coalesce(v.ventas_bs, 0) as ventas_bs, coalesce(p.pagos_bs, 0) as pagos_bs,
       coalesce(p.pagos_bs, 0) - coalesce(v.ventas_bs, 0) as diferencia_bs
from v
full join p using (cuenta, dia, maquina_id)
left join epay.maquinas m using (cuenta, maquina_id);

-- Inventario por canal con el mismo criterio del portal (cantidad < mínimo = bajo).
create or replace view epay.v_inventario as
select c.cuenta, c.maquina_id, m.codigo_interno, c.codigo as slot, c.seleccion, c.producto_id, pr.nombre as producto,
       c.cantidad, c.minimo, c.maximo, c.activo,
       case when not c.activo then 'inactivo'
            when c.cantidad < 0 then 'negativo'
            when c.cantidad = 0 then 'vacio'
            when c.cantidad < c.minimo then 'bajo'
            else 'ok' end as estado,
       c.actualizado at time zone 'America/Caracas' as actualizado_caracas
from epay.canales c
left join epay.maquinas m using (cuenta, maquina_id)
left join epay.productos pr on pr.cuenta = c.cuenta and pr.producto_id = c.producto_id;

-- Horas desde la última venta de cada máquina vigente (verde sin vender = revisar).
create or replace view epay.v_sin_ventas as
select s.cuenta, s.maquina_id, s.codigo_interno, s.nombre, s.color,
       u.ultima_venta at time zone 'America/Caracas' as ultima_venta_caracas,
       round(extract(epoch from now() - u.ultima_venta) / 3600, 1) as horas_sin_vender
from epay.v_estatus s
left join (select cuenta, maquina_id, max(fecha) as ultima_venta from epay.ventas group by 1, 2) u
  using (cuenta, maquina_id)
order by horas_sin_vender desc nulls first;

-- Cierres por día local (Caracas): máquinas que cerraron y total de cierres.
create or replace view epay.v_cierres_dia as
select cuenta, dia_local, count(distinct maquina_id) as maquinas_con_cierre, count(*) as cierres
from epay.cierres
group by cuenta, dia_local;

-- Máquinas vigentes y activas sin cierre de lote ayer (día de Caracas). Con pagos PDV ayer y sin cierre = revisar.
create or replace view epay.v_sin_cierre as
with ayer as (select ((now() at time zone 'America/Caracas')::date - 1) as dia)
select m.cuenta, m.maquina_id, m.codigo_interno, m.nombre, e.color, ayer.dia as dia_sin_cierre,
       (select count(*) from epay.pagos p
        where p.cuenta = m.cuenta and p.maquina_id = m.maquina_id and p.medio_codigo = '2'
          and p.fecha >= (ayer.dia::timestamp at time zone 'America/Caracas')
          and p.fecha < ((ayer.dia + 1)::timestamp at time zone 'America/Caracas')) as pagos_pdv_ayer,
       u.ultimo_cierre at time zone 'America/Caracas' as ultimo_cierre_caracas,
       ayer.dia - (u.ultimo_cierre at time zone 'America/Caracas')::date as dias_desde_ultimo_cierre
from epay.maquinas m
cross join ayer
left join epay.estatus_actual e using (cuenta, maquina_id)
left join (select cuenta, maquina_id, max(fecha) as ultimo_cierre from epay.cierres group by 1, 2) u
  using (cuenta, maquina_id)
where m.vigente and coalesce(m.activo_epay, true)
  and not exists (select 1 from epay.cierres c
                  where c.cuenta = m.cuenta and c.maquina_id = m.maquina_id and c.dia_local = ayer.dia)
order by pagos_pdv_ayer desc, m.cuenta, m.codigo_interno;

-- Cuándo liquida Ubii cada lote (regla de las 19:00; débito/Master y Visa, ver epay.cierres).
create or replace view epay.v_liquidaciones_ubii as
select cuenta, lote_ubii, liquidacion_debito, liquidacion_visa,
       count(distinct maquina_id) as maquinas, count(*) as cierres
from epay.cierres
group by cuenta, lote_ubii, liquidacion_debito, liquidacion_visa
order by cuenta, lote_ubii desc;

-- Movimientos de saldo de clientes entre fotos diarias (primera foto y días en que cambió).
create or replace view epay.v_saldos_clientes as
select * from (
  select s.cuenta, s.cliente_id, c.codigo, c.nombre, c.apellido, s.fecha, s.saldo,
         lag(s.saldo) over w as saldo_anterior,
         s.saldo - lag(s.saldo) over w as diferencia
  from epay.clientes_saldos s
  left join epay.clientes c using (cuenta, cliente_id)
  window w as (partition by s.cuenta, s.cliente_id order by s.fecha)
) x
where saldo_anterior is null or diferencia <> 0
order by fecha desc, cuenta, cliente_id;

-- Gift cards con la máquina donde se usaron, fechas en hora de Caracas.
create or replace view epay.v_gift_cards as
select g.cuenta, g.codigo, g.fecha at time zone 'America/Caracas' as creada_caracas,
       g.vence at time zone 'America/Caracas' as vence_caracas, g.monto, g.unico, g.usuario,
       g.usado at time zone 'America/Caracas' as usada_caracas, g.usado is not null as usada,
       g.maquina_id, m.codigo_interno, g.grupo, g.producto, g.nota
from epay.gift_cards g
left join epay.maquinas m using (cuenta, maquina_id);

-- Última ejecución de cada tarea por cuenta.
create or replace view epay.v_sincronizacion as
select distinct on (tarea, cuenta) tarea, cuenta, fin at time zone 'America/Caracas' as ultima_corrida_caracas,
       ok, round(extract(epoch from now() - fin) / 60)::int as minutos_desde, resumen
from epay.corridas
order by tarea, cuenta, fin desc;
