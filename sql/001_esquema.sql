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

-- Horas desde la última venta de cada máquina vigente (verde sin vender = revisar).
create or replace view epay.v_sin_ventas as
select s.cuenta, s.maquina_id, s.codigo_interno, s.nombre, s.color,
       u.ultima_venta at time zone 'America/Caracas' as ultima_venta_caracas,
       round(extract(epoch from now() - u.ultima_venta) / 3600, 1) as horas_sin_vender
from epay.v_estatus s
left join (select cuenta, maquina_id, max(fecha) as ultima_venta from epay.ventas group by 1, 2) u
  using (cuenta, maquina_id)
order by horas_sin_vender desc nulls first;

-- Última ejecución de cada tarea por cuenta.
create or replace view epay.v_sincronizacion as
select distinct on (tarea, cuenta) tarea, cuenta, fin at time zone 'America/Caracas' as ultima_corrida_caracas,
       ok, round(extract(epoch from now() - fin) / 60)::int as minutos_desde, resumen
from epay.corridas
order by tarea, cuenta, fin desc;
