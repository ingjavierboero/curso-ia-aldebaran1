# AGENTS.md — Aldebaran

## Propósito
Sistema SaaS interno que genera cada mes las facturas de los clientes (en homologación de ARCA),
se las envía por email y valida con un LLM los comprobantes de pago que responden. Spec: `PRD-002.md`.

## Stack
- Node 24 LTS + TypeScript 7. Monorepo con npm workspaces: `server/` y `web/`.
- Backend: Express 5 · SQLite con Drizzle ORM 0.45 + better-sqlite3 (migraciones con drizzle-kit).
- Frontend: React 19 + Vite 8 · antd 6 · zustand 5 · styled-components 6.
- LLM: `@anthropic-ai/sdk`, modelo `claude-haiku-4-5-20251001` (clasificación si/no/dudoso + extracción de CUIT/monto).
- Email (Gmail con contraseña de aplicación): nodemailer (SMTP) + imapflow (IMAP).
- ARCA: WSAA/WSFEv1 implementados a mano (SOAP), solo homologación.
- Jobs: node-cron dentro del server, TZ `America/Argentina/Buenos_Aires`.
- Tests: Vitest.

## Cómo correr
```bash
npm install        # instala todos los workspaces
npm run dev        # levanta server + web
npm run test       # corre toda la suite (Vitest)
```
Variables de entorno (`.env`, nunca commiteado; plantilla en `.env.example`):
`ANTHROPIC_API_KEY`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `ARCA_CUIT`, `ARCA_CERT_PATH`, `ARCA_KEY_PATH`.

## Qué NO hacer
- No apuntar nunca a los endpoints productivos de ARCA: solo homologación.
- No poner credenciales en el código ni en el repo (API key, Gmail, certificado/clave de ARCA): todo sale de variables de entorno.
- No versionar los certificados ni las claves de ARCA (`certs/`, `*.crt`, `*.key`, `*.pem`): viven solo en la máquina local y se referencian con `ARCA_CERT_PATH` y `ARCA_KEY_PATH`.
- El agente nunca marca una factura como "Pagada": cuando valida un comprobante (de una o de varias facturas) la pasa a "Pago recibido" para que un usuario la analice, y si es dudoso, parcial o no lo puede validar, a "Revisión manual". El usuario decide si pasa a "Pagada" o vuelve a "Pendiente de pago".
- No consultar ni integrar sistemas bancarios para validar pagos: la única fuente es el email del cliente.
- Los tests no envían emails reales ni llaman a ARCA, Gmail o Claude: se mockean.
- No editar migraciones ya aplicadas: si hay un cambio de schema, se genera una migración nueva.
