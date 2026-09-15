# Historial epay.uno — Vendu y Neptuno

Guarda en una base propia (Supabase) todo lo que pasa en las máquinas de las cuentas **Epay.Uno** y
**Neptuno**, para ver el historial sin depender del portal y detectar rápido movimientos:

| Qué | Cada cuánto | Fuente |
|---|---|---|
| Semáforo verde/rojo, código interno, nombre, UID del módulo | 10 min | "Estatus equipos" y Máquinas definidas |
| Ventas una por una (con el código interno que tenía la máquina en esa venta) | 1 hora | API de ventas |
| Pagos externos (PDV, débito inmediato, gift card) | 1 hora | Pagos externos |
| Descripción de cada ficha y productos con precios y costos | 6 horas | Ficha de máquina y API de productos |

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

4. **Crear las tablas**: pestaña *Actions* → **Instalar base** → *Run workflow*.
5. **Cargar el pasado**: *Actions* → **Cargar histórico** → *Run workflow* con `desde` = `2026-07`
   (o el mes que quieras). Tarda varios minutos.
6. Listo: *Estatus de máquinas*, *Ventas y pagos* y *Fichas y productos* corren solos.

## Dónde mirar

Supabase → *Table Editor* → esquema **epay**, o *SQL Editor* con estas vistas:

| Vista | Para qué |
|---|---|
| `epay.v_estatus` | semáforo actual con código interno y minutos en ese color |
| `epay.v_caidas` | caídas y recuperaciones, lo más reciente primero |
| `epay.v_movimientos` | módulos o códigos internos cambiados, renombres, altas y bajas |
| `epay.v_codigos_repetidos` | un mismo código interno en dos registros (módulo movido sin actualizar la ficha) |
| `epay.v_codigo_en_ventas` | con qué código interno vendió cada módulo y entre qué fechas |
| `epay.v_sin_ventas` | horas desde la última venta (verde pero sin vender = revisar) |
| `epay.v_ventas_dia` | ventas por día (hora de Caracas) y máquina |
| `epay.v_sincronizacion` | última corrida de cada tarea (si algo se detuvo) |

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

Tareas: `esquema`, `estatus`, `ventas`, `fichas`, `historico AAAA-MM [AAAA-MM]`.
`LIMITE_MAQUINAS=N` limita ventas y fichas a N máquinas (pruebas). `PGLITE=1` usa un Postgres en memoria
(requiere `npm i @electric-sql/pglite`).
Notas de datos: la API de ventas entrega la hora en UTC (se guarda como tal); el reporte de pagos está en hora
de Caracas. La API de ventas también devuelve las máquinas Epay K (ej. NEPT1).
