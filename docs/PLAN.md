# Plan de implementación — feature central

Circuito: **facturar → enviar → leer la casilla → validar el pago**. Spec: [PRD-002.md](../PRD-002.md).

Cada paso termina con sus tests en verde y un commit. No se avanza al siguiente sin aprobación.

## Estado

| # | Paso | Estado |
|---|---|---|
| 1 | Base del proyecto | ✅ Hecho |
| 2 | Base de datos | ✅ Hecho |
| 3 | Motor de reglas de pago | ✅ Hecho |
| 4 | Cotización | ✅ Hecho |
| 5 | Cliente ARCA (homologación) | ✅ Hecho |
| 6 | Proceso de facturación | ✅ Hecho |
| 7 | Email de la factura | ⏳ Próximo |
| 8 | Clasificador LLM | Pendiente |
| 9 | Lectura de la casilla | Pendiente |
| 10 | Scheduler | Pendiente |
| 11 | Cierre mínimo para el usuario | Pendiente |

## Pasos

1. **Base del proyecto.** Monorepo con workspaces (`server/` por ahora), TypeScript, Vitest, `.env.example` y un módulo que lea la configuración desde las variables de entorno. Sin lógica de negocio.
2. **Base de datos.** Schema de Drizzle y la primera migración con estas tablas: clientes, sistemas, asignaciones, facturas con sus ítems (guardando el nombre y el precio que tenían al facturar, por AC-35/36), cotizaciones, emails recibidos o historial, avisos, errores de proceso y configuración con valores por defecto. Montos en centavos (enteros). Un seed con datos de prueba, porque todavía no hay ABMs.
3. **Motor de reglas de pago (lógica pura).** Una función que recibe la clasificación, el CUIT, el monto y las facturas adeudadas, y devuelve el nuevo estado y el motivo (RF-62 a RF-74). Incluye la búsqueda de coincidencias de monto y de la combinación más antigua. Va primero porque es lo más delicado y se puede testear sin servicios externos (AC-73 a AC-89).
4. **Cotización.** Scraper de dolarhoy.com con un timeout de 10 s. Si falla, usa la última cotización registrada; si no hay ninguna, no se facturan los clientes con sistemas en dólares (RF-41 a RF-43).
5. **Cliente de ARCA para homologación.** WSAA (genera el ticket de acceso y lo guarda en caché) y WSFEv1 (consulta el último comprobante y pide el CAE), con un timeout de 30 s. La URL de homologación queda fija. Los tests usan respuestas SOAP mockeadas.
6. **Proceso de facturación.** Elige los clientes Activos con al menos un sistema Activo asignado, arma el detalle, genera una sola factura por cliente y período (si se vuelve a correr, no la duplica) y la deja en Pendiente de pago. Si falla, reintenta según la configuración y, si sigue fallando, registra un error de proceso (RF-89 y RF-92).
7. **Email de la factura.** nodemailer con Gmail. Cada envío queda en el historial del cliente y tiene los mismos reintentos y errores de proceso que el paso 6. No se envía nada a clientes Inactivos.
8. **Clasificador con LLM.** Haiku 4.5 con salida estructurada (si/no/dudoso, CUIT y monto). Reintentos de 2, 4 y 8 s, un timeout de 10 s y las respuestas 400/401/403 sin reintento (RNF-02). El SDK se mockea en los tests.
9. **Lectura de la casilla.** Con imapflow. Busca qué cliente envió el email; si no coincide ninguno, registra un aviso. Guarda el email en el historial, filtra los que tienen adjunto, llama al clasificador y al motor del paso 3, y actualiza las facturas. Si la casilla falla, registra un único error y lo pasa a Resuelto cuando vuelve a conectar, procesando lo atrasado (RF-50 a RF-61).
10. **Scheduler.** node-cron con TZ `America/Argentina/Buenos_Aires`: facturación el día 15 a la hora configurada y revisión de la casilla cada N minutos.
11. **Cierre mínimo para el usuario.** Dos o tres endpoints y una pantalla simple para ver las facturas en Pago recibido o Revisión manual y pasarlas a Pagada o devolverlas a Pendiente de pago (RF-77 a RF-80).

## Fuera de esta etapa

Login, usuarios y perfiles; ABMs con interfaz; dashboard y banners; recordatorios de fin de mes; reintento manual de errores; interfaz de configuración.

## Decisiones tomadas

- **Tipo de comprobante:** Factura C (código 11). Agregado al PRD como RF-102.
- **Punto de venta:** configurable desde la configuración, entre 1 y 99999. Agregado al PRD como RF-103, RF-104, AC-141 y AC-142.
- **Paso 11:** incluido en esta etapa.
- **LLM:** se usa la API key de Anthropic (`ANTHROPIC_API_KEY`). La alternativa de Claude por Vertex AI quedó descartada por ahora.
- **Formato de la factura en el email:** siempre PDF adjunto. Agregado al PRD como RF-106 y AC-145 (y en RF-46).
- **Decisiones de diseño del paso 2, llevadas al PRD:**
  - Una sola factura por cliente y período, aunque el proceso corra dos veces: RF-105 y AC-144.
  - CUIT y email de facturación únicos por cliente: RF-107 y AC-143.
  - Remitente comparado sin distinguir mayúsculas: RF-108 y AC-146.
  - Cada email se procesa una sola vez, por Message-ID: RF-109 y AC-147.
  - Solo las facturas en Revisión manual tienen motivo: RF-110 y AC-148.
  - Montos con precisión de centavos y coincidencia exacta: RNF-13 y AC-149.
- **Interpretaciones del paso 3, llevadas al PRD:**
  - Una coincidencia que se queda sin facturas para comparar mientras otra sigue: no hay combinación más antigua (definición de "Combinación más antigua" y AC-151).
  - RF-64 reemplaza el motivo de las facturas que ya estaban en Revisión manual (RF-64 y AC-75).
  - El CUIT se compara solo por sus dígitos: RF-111 y AC-150.
  - Un monto menor o igual a cero, o con fracción de centavo, no coincide: RNF-13 y AC-152.
- **Decisiones del paso 4, llevadas al PRD:**
  - La conversión de dólares a pesos se redondea al centavo más cercano: RF-112 y AC-153 (y la aclaración en RNF-13).
  - Cada lectura de dolarhoy.com queda registrada, y la de respaldo es la de fecha de lectura más reciente: RF-113, RF-42 y AC-154.
  - Si dolarhoy.com cambia su HTML y no se encuentra el blue venta, se trata como "no se puede leer la cotización" (RF-42): se usa la de respaldo y aparece el banner.
- **Decisiones del paso 5, llevadas al PRD:**
  - Cada cliente tiene su condición frente al IVA, con los valores que ARCA admite para Factura C (consultados en homologación): RF-114, RF-115, AC-155 y AC-156. Se agrega al cliente en el paso 6, con una migración nueva.
  - Fecha de emisión: el día en que se genera la factura. Período de servicio: del 1 al último día del mes facturado: RF-116 y AC-157.
  - Vencimiento del pago: el último día del mes facturado, o la fecha de emisión si es posterior (ARCA no admite un vencimiento anterior a la emisión): RF-117 y AC-158.
  - Las rutas relativas del `.env` (certificados y base) se toman desde la raíz del repo.
- **Decisiones del paso 6, llevadas al PRD:**
  - No se emiten comprobantes duplicados: si ARCA autorizó una factura y la respuesta se perdió, se registra con el CAE ya otorgado (RF-118 y AC-159).
  - El CUIT del cliente tiene que tener el dígito verificador válido (RF-119 y AC-160). Se aplica en el ABM de clientes; el seed ya usa CUIT válidos.
  - Un cliente sin condición frente al IVA no se factura y genera un error de proceso (RF-120 y AC-161).
  - La migración 0002 se escribió a mano: la de drizzle-kit recreaba `clients` y, dentro de la transacción, borraba en cascada asignaciones e historial.
  - Un cliente cuya generación falla se reintenta a los N minutos sin demorar a los demás.
- **Usuarios:** la tabla de usuarios y los campos de "quién confirmó o revisó" no están en esta etapa porque el login está fuera de alcance. Llegan con su propia migración.
