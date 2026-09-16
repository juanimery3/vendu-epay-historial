# Historial epay.uno — Vendu y Neptuno

Guarda en una base propia (Supabase) todo lo que pasa en las máquinas de las cuentas **Epay.Uno** y
**Neptuno**, para ver el historial sin depender del portal y detectar rápido movimientos:

| Qué | Cada cuánto | Fuente |
|---|---|---|
| Semáforo verde/rojo, código interno, nombre, UID y MAC del módulo, último acceso | 10 min | API `e=estatus` con token (sin token: portal) |
| Ventas una por una (con el código interno que tenía la máquina en esa venta) | 1 hora | API `e=venta` |
| Pagos (PDV, débito inmediato, gift card), los mismos del reporte de pagos externos | 1 hora | API `e=pago` |
| Existencias por canal (slot) | 1 hora | API `e=canal` |
| Cierres de lote del PDV (reporte "Cierres PDV"), con lote y liquidación Ubii | 1 hora (min :23) | API `e=cierres` con token |
| Gift cards, clientes y foto diaria de sus saldos | 6 horas (min :41) | API `e=gifts` y `e=clientes` con token |
| Productos con precios y costos | 6 horas | API `e=prods` |
| Descripción de cada ficha, pago hasta y ruta | 6 horas | Portal (**el único login**: 4 al día) |

Cada corrida guarda en `epay.corridas` cuántos logins hizo (`resumen.logins`).

Todo cambio queda en `epay.eventos`: **caida**, **recuperacion**, **cambio_modulo** (otro UID),
**cambio_codigo_interno** (el módulo quedó en otra máquina), **cambio_nombre**, **cambio_version**,
**cambio_descripcion**, **alta**, **baja**, **reactivada**.

> Repo público: el código se ve, pero **no** las credenciales (van en Secrets de GitHub) ni los datos
> (van a Supabase). Los registros de GitHub Actions solo muestran conteos, nunca nombres ni montos.

## Puesta en marcha (una sola vez)

1. **Crear el proyecto en Supabase**: supabase.com → New project → nombre `vendu-epay-historial`,
   región *East US*, guarda la contraseña de la base.
2. **Copiar la conexión**: botón *Connect* → *Connection string* → **Transaction pooler** → copia la URI
   (puerto 6543) y cambia `[YOUR-PASSWORD]` por la contraseña del paso 1.
3. **Cargar los secretos en GitHub**: este repo → *Settings* → *Secrets and variables* → *Actions* →
   *New repository secret*, uno por uno:

   | Nombre | Valor |
   |---|---|
   | `DATABASE_URL` | la URI del paso 2 |
   | `EPAYUNO_USER` / `EPAYUNO_PASS` | usuario y clave del portal epay.uno de Epay.Uno |
   | `NEPTUNO_USER` / `NEPTUNO_PASS` | usuario y clave del portal epay.uno de Neptuno |
   | `EPAYUNO_API_TOKEN` / `NEPTUNO_API_TOKEN` | (opcional) token de la API de epay.uno de cada cuenta: el semáforo pasa a leerse por API y guarda la MAC del módulo y el último acceso; sin token, cierres, gift cards y clientes se omiten para esa cuenta |

4. **Crear las tablas**: pestaña *Actions* → **Instalar base** → *Run workflow*.
5. **Cargar el pasado**: *Actions* → **Cargar histórico** → *Run workflow* con `desde` = `2026-07`
   (o el mes que quieras). Tarda varios minutos.
6. **Cargar los cierres pasados**: *Actions* → **Cierres de lote** → *Run workflow* con `desde` = `2026-06-01`.
7. Listo: *Estatus de máquinas*, *Ventas y pagos*, *Cierres de lote*, *Gift cards y clientes* y
   *Fichas y productos* corren solos.

## Dónde mirar

Supabase → *Table Editor* → esquema **epay**, o *SQL Editor* con estas vistas:

| Vista | Para qué |
|---|---|
| `epay.v_estatus` | semáforo actual con código interno y minutos en ese color |
| `epay.v_caidas` | caídas y recuperaciones, lo más reciente primero |
| `epay.v_movimientos` | módulos o códigos internos cambiados, renombres, altas y bajas |
| `epay.v_codigos_repetidos` | un mismo código interno en dos registros (módulo movido sin actualizar la ficha) |
| `epay.v_mac_repetidas` | un mismo módulo físico (MAC) en dos registros (requiere token de API) |
| `epay.v_codigo_en_ventas` | con qué código interno vendió cada módulo y entre qué fechas |
| `epay.v_sin_ventas` | horas desde la última venta (verde pero sin vender = revisar) |
| `epay.v_ventas_dia` | ventas por día (hora de Caracas) y máquina |
| `epay.v_pagos_dia` | pagos por día, máquina y medio |
| `epay.v_ventas_vs_pagos` | ventas contra pagos por día y máquina (diferencia en Bs) |
| `epay.v_inventario` | existencias por canal con estado ok / bajo / vacío / negativo |
| `epay.v_cierres_dia` | por día de Caracas: máquinas que cerraron lote y total de cierres |
| `epay.v_sin_cierre` | máquinas vigentes y activas sin cierre ayer, con sus pagos PDV de ayer y su último cierre |
| `epay.v_liquidaciones_ubii` | por lote Ubii: acreditación de débito otros bancos, débito UBII APP y VISA, máquinas y cierres |
| `epay.v_gift_cards` | gift cards con la máquina donde se usaron, en hora de Caracas |
| `epay.v_saldos_clientes` | cambios de saldo de los clientes entre fotos diarias |
| `epay.v_sincronizacion` | última corrida de cada tarea (si algo se detuvo) |

Tablas: `maquinas`, `estatus_actual`, `eventos`, `ventas`, `pagos`, `pagos_externos`, `productos`, `canales`,
`cierres`, `gift_cards`, `clientes`, `clientes_saldos`, `medios_pago` (catálogo), `feriados_bancarios` y `corridas`.

**Medios de pago** (`epay.medios_pago`, catálogo oficial confirmado por epay el 16-09-2026): 1 TC / TD, 2 PDV,
3 Pago Móvil, 4 Yappy, 5 ePay QR, 6 Yappy QR, 7 Débito Inmediato, 8 BioPago BDV, 9 Nequi, 10 BreB,
11 Gift Card, 12 Commodo.

**Regla Ubii** en `epay.cierres` y `epay.v_liquidaciones_ubii`: Ubii corta sus lotes a las 19:00 de Caracas.
Un cierre antes de las 19:00 del día D va al lote de D (`lote_ubii`); a las 19:00 o después, al lote de D+1.
Los datos del 14/08 al 10/09/2026 muestran que Mercantil acredita el débito de otros bancos y VISA exactos el
**día hábil siguiente** a la fecha del lote (`debito_otros_bancos`, `visa`: lun–jue y dom +1, vie +3, sáb +2),
y la wallet UBII APP del aeropuerto el **día calendario siguiente** a las 04:30, también en fines de semana
(`debito_ubii_app`). Día hábil = lunes a viernes que no esté en `epay.feriados_bancarios` (tabla que se llena a
mano; función `epay.siguiente_dia_habil(fecha)`).

**Datos personales**: `clientes` y `gift_cards` guardan nombres, correos, teléfonos y códigos. Solo van a la
base; los registros de Actions muestran únicamente conteos.

Ejemplos:

```sql
-- Máquinas en rojo ahora
select codigo_interno, nombre, minutos_en_este_color from epay.v_estatus where color = 'rojo' order by 3 desc;

-- Movimientos de la última semana
select * from epay.v_movimientos where fecha_caracas > now() - interval '7 days';

-- Módulos que vendieron con más de un código interno (se movieron)
select * from epay.v_codigo_en_ventas
where (cuenta, maquina_id) in (select cuenta, maquina_id from epay.v_codigo_en_ventas group by 1, 2 having count(*) > 1);
```

## Para desarrolladores

```
npm ci
DATABASE_URL=... EPAYUNO_USER=... EPAYUNO_PASS=... node src/index.js estatus
```

Tareas: `esquema`, `estatus`, `ventas`, `fichas`, `historico AAAA-MM [AAAA-MM]`,
`cierres [AAAA-MM-DD [AAAA-MM-DD]]` (sin fechas: anteayer a hoy UTC; con fechas: carga día por día, 4 en paralelo),
`clientes` (gift cards + clientes + saldos). `cierres` y `clientes` necesitan `EPAYUNO_API_TOKEN` /
`NEPTUNO_API_TOKEN`; la cuenta sin token se omite sin error.
`LIMITE_MAQUINAS=N` limita ventas y fichas a N máquinas (pruebas). `PGLITE=1` usa un Postgres en memoria
(requiere `npm i @electric-sql/pglite`).
Notas de datos: la API de ventas entrega la hora en UTC (se guarda como tal); el reporte de pagos está en hora
de Caracas. La API de ventas también devuelve las máquinas Epay K (ej. NEPT1).
`e=cierres` filtra por día UTC (`fecha=AAAA-MM-DD`; `desde`/`hasta`/`mes` devuelven vacío) y entrega la hora en
UTC; una máquina puede cerrar 2–3 veces en un día. `e=gifts` y `e=clientes` devuelven todo e ignoran los filtros;
las fechas de las gift cards se asumen en UTC (por confirmar).
