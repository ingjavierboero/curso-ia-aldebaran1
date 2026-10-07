export class ArcaError extends Error {
  constructor(
    message: string,
    /** Código de ARCA (SOAP fault o Err/Obs de WSFEv1), si lo hay. */
    public readonly code?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ArcaError';
  }
}
